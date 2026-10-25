'use strict';
// Background jobs in PostgreSQL (docs/06 S7, 0013_jobs): no external
// queue on hosting.com. Jobs are claimed one at a time with
// FOR UPDATE SKIP LOCKED, so the Passenger processes (in-process poller)
// and the cron runner (api/scripts/run-jobs.js) never run one job twice.
// Each job runs in its own transaction, its handler inside a savepoint: a
// failure undoes the handler's writes, records the error and waits
// min(2^attempts, 360) minutes; after max_attempts the job is dead and kept.
//
//   register(kind, async (payload, { client, db, deps, job }) => {})
//   enqueue(db, kind, payload, { runAt, maxAttempts, dedupeKey }) → id
//       (one pending job per dedupeKey: a second enqueue returns the first)
//   enqueueOnce(db, kind, payload, key) → id | null (never twice for a key)
//   runDue(db, { limit, workerId, deps, now }) → { done, retried, failed }
//
// A handler that must wait (the SMTP hourly budget is spent) throws
// defer(until, reason): the job runs again then, and the attempt is not
// counted.
//
// Payloads hold ids only: no e-mail address, token or health data.

const os = require('os');
const { scrub } = require('./errorlog');

const handlers = new Map();
const WORKER = `${os.hostname()}:${process.pid}`;

function register(kind, fn) {
  handlers.set(kind, fn);
}

function defer(until, reason) {
  return Object.assign(new Error(reason), { deferUntil: until });
}

async function enqueue(db, kind, payload = {}, { runAt = null, maxAttempts = 5, dedupeKey = null } = {}) {
  const { rows } = await db.query(
    `insert into public.jobs (kind, payload, run_at, max_attempts, dedupe_key)
     values ($1, $2::jsonb, coalesce($3::timestamptz, now()), $4, $5)
     on conflict (dedupe_key) where done_at is null and dead_at is null do nothing
     returning id`,
    [kind, JSON.stringify(payload), runAt, maxAttempts, dedupeKey]);
  if (rows[0]) return Number(rows[0].id);
  const { rows: [pending] } = await db.query(
    'select id from public.jobs where dedupe_key = $1 and done_at is null and dead_at is null', [dedupeKey]);
  return pending ? Number(pending.id) : null;
}

async function enqueueOnce(db, kind, payload, key) {
  const { rows } = await db.query(
    `insert into public.jobs (kind, payload, dedupe_key)
     select $1, $2::jsonb, $3 where not exists (select 1 from public.jobs where dedupe_key = $3)
     on conflict (dedupe_key) where done_at is null and dead_at is null do nothing
     returning id`,
    [kind, JSON.stringify(payload || {}), key]);
  return rows[0] ? Number(rows[0].id) : null;
}

// One due job, claimed and run in one transaction: 'done' | 'retried' |
// 'failed' (dead), or null when nothing is due (or every due job is taken).
async function runOne(db, { workerId, deps, now }) {
  return db.withContext({ system: true }, async (client) => {
    const { rows } = await client.query(
      `select * from public.jobs
        where done_at is null and dead_at is null and run_at <= coalesce($1::timestamptz, now())
        order by run_at, id limit 1 for update skip locked`, [now]);
    const job = rows[0];
    if (!job) return null;
    await client.query('savepoint job');
    try {
      const handler = handlers.get(job.kind);
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      await handler(job.payload || {}, { client, db, deps, job });
      await client.query('release savepoint job');
      await client.query(
        `update public.jobs set done_at = now(), attempts = attempts + 1, last_error = null,
                locked_by = $2, updated_at = now() where id = $1`, [job.id, workerId]);
      return 'done';
    } catch (err) {
      await client.query('rollback to savepoint job');
      if (err && err.deferUntil) {
        await client.query(
          'update public.jobs set run_at = $2, last_error = $3, locked_by = $4, updated_at = now() where id = $1',
          [job.id, err.deferUntil, scrub(err.message, 500), workerId]);
        return 'retried';
      }
      const attempts = job.attempts + 1;
      const dead = attempts >= job.max_attempts;
      await client.query(
        `update public.jobs set attempts = $2, last_error = $3, locked_by = $4, updated_at = now(),
                dead_at = case when $5 then now() end,
                run_at = case when $5 then run_at
                              else coalesce($6::timestamptz, now()) + make_interval(mins => $7) end
          where id = $1`,
        [job.id, attempts, scrub((err && err.message) || String(err), 500), workerId, dead, now, Math.min(2 ** attempts, 360)]);
      return dead ? 'failed' : 'retried';
    }
  });
}

async function runDue(db, { limit = 20, workerId = WORKER, deps = {}, now = null } = {}) {
  const stats = { done: 0, failed: 0, retried: 0 };
  for (let i = 0; i < limit; i++) {
    const result = await runOne(db, { workerId, deps, now });
    if (!result) break;
    stats[result] += 1;
  }
  return stats;
}

module.exports = { register, defer, enqueue, enqueueOnce, runDue, handlers };
