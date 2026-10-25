'use strict';
// Background jobs in PostgreSQL (docs/06 S7, 0013_jobs): retries with
// backoff, dead jobs kept with their error, one runner per job across
// processes (FOR UPDATE SKIP LOCKED), e-mails that failed sent again later,
// the daily maintenance, and the cron runner. setup() wipes and re-seeds
// the database for this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup, USER, ORG, BRANCH, TEST_DB_URL } = require('./helpers');
const jobs = require('../src/jobs');

let h, deps;
before(async () => {
  h = await setup();
  deps = h.app.locals;
});
after(() => h.close());

const minutes = (n) => new Date(Date.now() + n * 60e3);
const jobRow = async (id) => (await h.sql('select * from public.jobs where id = $1', [id])).rows[0];

test('a job that fails twice, then succeeds: done after 3 attempts, with backoff between them', async () => {
  let calls = 0;
  jobs.register('test.flaky', async () => { calls += 1; if (calls < 3) throw new Error(`boom ${calls}`); });
  const id = await jobs.enqueue(deps.db, 'test.flaky', { n: 1 });
  assert.deepEqual(await jobs.runDue(deps.db, { deps }), { done: 0, failed: 0, retried: 1 });
  let j = await jobRow(id);
  assert.equal(j.attempts, 1);
  assert.equal(j.last_error, 'boom 1');
  const wait = Date.parse(j.run_at) - Date.now();
  assert.ok(wait > 90e3 && wait <= 125e3, `about 2 minutes, got ${wait} ms`);
  assert.deepEqual(await jobs.runDue(deps.db, { deps }), { done: 0, failed: 0, retried: 0 }, 'not due yet');
  await jobs.runDue(deps.db, { deps, now: minutes(3) });
  assert.deepEqual(await jobs.runDue(deps.db, { deps, now: minutes(30) }), { done: 1, failed: 0, retried: 0 });
  j = await jobRow(id);
  assert.equal(j.attempts, 3);
  assert.ok(j.done_at);
  assert.equal(calls, 3);
});

test('a job that keeps failing is dead after max_attempts (5), kept with its last error', async () => {
  jobs.register('test.broken', async () => { throw new Error('always'); });
  const id = await jobs.enqueue(deps.db, 'test.broken', {});
  let r;
  // +1 minute: run_at has microseconds, a JS Date only milliseconds.
  for (let i = 0; i < 5; i++) r = await jobs.runDue(deps.db, { deps, now: minutes(1 + i * 400) });
  assert.deepEqual(r, { done: 0, failed: 1, retried: 0 });
  const j = await jobRow(id);
  assert.equal(j.attempts, 5);
  assert.ok(j.dead_at);
  assert.equal(j.last_error, 'always');
  assert.deepEqual(await jobs.runDue(deps.db, { deps, now: minutes(10000) }), { done: 0, failed: 0, retried: 0 }, 'never again');
});

test('two runners at once never run one job twice (SKIP LOCKED); unknown kinds fail instead of looping', async () => {
  let runs = 0;
  jobs.register('test.slow', async () => { runs += 1; await new Promise((r) => setTimeout(r, 300)); });
  await jobs.enqueue(deps.db, 'test.slow', {});
  const [a, b] = await Promise.all([jobs.runDue(deps.db, { deps, workerId: 'a' }), jobs.runDue(deps.db, { deps, workerId: 'b' })]);
  assert.equal(runs, 1);
  assert.equal(a.done + b.done, 1);
  const id = await jobs.enqueue(deps.db, 'test.nobody', {}, { maxAttempts: 1 });
  await jobs.runDue(deps.db, { deps });
  assert.match((await jobRow(id)).last_error, /no handler for test\.nobody/);
});

test('dedupeKey: one pending job per key; once it is done, a new one may be queued', async () => {
  jobs.register('test.once', async () => {});
  const a = await jobs.enqueue(deps.db, 'test.once', { x: 1 }, { dedupeKey: 'once:1' });
  const b = await jobs.enqueue(deps.db, 'test.once', { x: 2 }, { dedupeKey: 'once:1' });
  assert.equal(a, b);
  await jobs.runDue(deps.db, { deps });
  const c = await jobs.enqueue(deps.db, 'test.once', { x: 3 }, { dedupeKey: 'once:1' });
  assert.notEqual(c, a);
  // enqueueOnce: never again for that key (the daily maintenance).
  const d1 = await jobs.enqueueOnce(deps.db, 'test.once', {}, 'daily:2026-10-25');
  await jobs.runDue(deps.db, { deps });
  assert.equal(await jobs.enqueueOnce(deps.db, 'test.once', {}, 'daily:2026-10-25'), null);
  assert.ok(d1);
});

test('an invitation e-mail that fails is sent again by a job (new link), and the job carries no address or token', async () => {
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const email = `retry-${Date.now().toString(36)}@e2e.test`;
  const real = deps.mailer;
  deps.mailer = { send: async () => { throw new Error('smtp down'); } };
  let created;
  try {
    created = await admin.post('/api/org/invitations', { email, role: 'receptionist', branch_ids: [BRANCH.physio1] });
    await deps.drain();
  } finally {
    deps.mailer = real;
  }
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.email_sent, false);
  const id = created.body.invitation.id;
  const { rows: queued } = await h.sql("select * from public.jobs where kind = 'email.invitation' and done_at is null");
  assert.equal(queued.length, 1);
  const payload = JSON.stringify(queued[0].payload);
  assert.ok(!payload.includes('@') && !/[A-Za-z0-9_-]{40,}/.test(payload), payload);
  assert.equal(queued[0].payload.invitationId, id);

  const before = h.outbox().length;
  const r = await jobs.runDue(deps.db, { deps, now: minutes(5) });
  assert.equal(r.done, 1);
  const { rows: [inv] } = await h.sql('select email_status from public.invitations where id = $1', [id]);
  assert.equal(inv.email_status, 'sent');
  const mail = h.outbox().slice(before).find((m) => JSON.stringify(m.to).includes(email));
  assert.ok(mail, 'the e-mail went out');
  const token = new URL(String(mail.text).match(/https?:\/\/\S+/)[0]).searchParams.get('invite');
  assert.equal((await h.client().get(`/api/invitations/${token}`)).status, 200, 'its link works');
});

test('an invitation accepted or revoked meanwhile: the job finishes without sending', async () => {
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const real = deps.mailer;
  deps.mailer = { send: async () => { throw new Error('smtp down'); } };
  let id;
  try {
    id = (await admin.post('/api/org/invitations', { email: `gone-${Date.now().toString(36)}@e2e.test`, role: 'doctor', branch_ids: [BRANCH.physio1] })).body.invitation.id;
    await deps.drain();
  } finally {
    deps.mailer = real;
  }
  assert.equal((await admin.del(`/api/org/invitations/${id}`)).status, 204);
  const before = h.outbox().length;
  assert.equal((await jobs.runDue(deps.db, { deps, now: minutes(5) })).done, 1);
  assert.equal(h.outbox().length, before);
});

test('a password-reset e-mail that fails is sent again by a job; the payload is the account id only', async () => {
  const real = deps.mailer;
  deps.mailer = { send: async () => { throw new Error('smtp down'); } };
  try {
    assert.equal((await h.client({ ip: '10.70.0.1' }).post('/api/auth/reset/request', { email: USER.physioDoctor.email })).status, 204);
    await deps.drain();
  } finally {
    deps.mailer = real;
  }
  const { rows: [job] } = await h.sql("select * from public.jobs where kind = 'email.password_reset' and done_at is null");
  assert.deepEqual(job.payload, { userId: USER.physioDoctor.id, lang: 'ar' });
  const before = h.outbox().length;
  assert.equal((await jobs.runDue(deps.db, { deps, now: minutes(5) })).done, 1);
  assert.ok(h.outbox().slice(before).some((m) => JSON.stringify(m.to).includes(USER.physioDoctor.email)));
});

test('mail_log counts every send and failure, without addresses; the platform stats show queued and failed jobs', async () => {
  await assert.rejects(deps.mailer.send({ to: 'not-an-address', subject: 's', text: 't', kind: 'test' }));
  const { rows } = await h.sql('select * from public.mail_log');
  assert.ok(rows.some((r) => r.ok === true) && rows.some((r) => r.ok === false));
  assert.ok(!JSON.stringify(rows).includes('@'));
  const sa = await h.as('superAdmin', { platform: true });
  const stats = (await sa.get('/api/platform/stats')).body;
  assert.equal(typeof stats.jobs_queued, 'number');
  assert.ok(stats.jobs_failed >= 1, 'the dead test.broken job');
});

test('maintenance.daily removes what is no longer needed and keeps the rest', async () => {
  await h.sql(`insert into public.rate_limits (bucket, key_hash, window_start, count) values
    ('login_ip', 'old', now() - interval '3 days', 1), ('login_ip', 'new', now() - interval '1 hour', 1)`);
  await h.sql(`insert into public.idempotency_keys (scope, key, created_at) values ('t', 'old-key', now() - interval '2 days'), ('t', 'new-key', now())`);
  await h.sql(`insert into public.error_groups (fingerprint, source, message) values ('${'f'.repeat(64)}', 'api', 'x')`);
  await h.sql(`insert into public.error_events (fingerprint, message, created_at) values
    ('${'f'.repeat(64)}', 'old', now() - interval '31 days'), ('${'f'.repeat(64)}', 'new', now())`);
  await h.sql(`insert into public.jobs (kind, payload, done_at, created_at) values ('test.once', '{}', now() - interval '31 days', now() - interval '31 days')`);
  await h.sql(`insert into public.mail_log (sent_at, ok) values (now() - interval '91 days', true)`);
  await jobs.enqueue(deps.db, 'maintenance.daily', {});
  assert.equal((await jobs.runDue(deps.db, { deps })).done, 1);
  const left = async (sql) => (await h.sql(sql)).rows.map((r) => r.v).sort();
  assert.deepEqual(await left("select key_hash v from public.rate_limits where key_hash in ('old', 'new')"), ['new']);
  assert.deepEqual(await left("select key v from public.idempotency_keys where scope = 't'"), ['new-key']);
  assert.deepEqual(await left(`select message v from public.error_events where fingerprint = '${'f'.repeat(64)}'`), ['new']);
  assert.equal((await h.sql("select count(*)::int n from public.jobs where done_at < now() - interval '30 days'")).rows[0].n, 0);
  assert.equal((await h.sql("select count(*)::int n from public.mail_log where sent_at < now() - interval '90 days'")).rows[0].n, 0);
});

test('node api/scripts/run-jobs.js (cron, every minute): queues the day\'s maintenance and the hour\'s check once, drains, exits 0', async () => {
  await h.sql("delete from public.jobs where kind = 'maintenance.daily'");
  const env = {
    ...process.env, NODE_ENV: 'test', DATABASE_URL: TEST_DB_URL, APP_BASE_DOMAIN: 'localhost',
    FILES_DIR: h.config.filesDir, MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: h.config.mailOutboxDir, JOBS_MAX_SECONDS: '5',
  };
  const script = path.join(__dirname, '..', 'scripts', 'run-jobs.js');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /jobs: \d+ done, \d+ retried, \d+ failed/);
  }
  const { rows } = await h.sql("select count(*)::int n, count(done_at)::int done from public.jobs where kind = 'maintenance.daily'");
  assert.deepEqual(rows[0], { n: 1, done: 1 }, 'once a day, whatever the number of runs');
  const { rows: [u] } = await h.sql("select count(*)::int n from public.jobs where kind = 'usage.check' and done_at is not null");
  assert.equal(u.n, 1, 'and the resource check once an hour');
  assert.ok(ORG.physio);
});
