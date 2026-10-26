'use strict';
// Resource ("spend") alerts inside hosting.com (docs/06 S8, 0014_usage): the
// account's disk quota (database + clinic files + backups), the SMTP hourly
// and daily budgets. Platform admins get one e-mail per level crossed
// upward (70 / 85 / 95 %) at most once a day, and one when it falls back
// below 70 %. E-mail jobs wait for the next hour once the hourly budget is
// spent. setup() wipes and re-seeds the database for this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, USER } = require('./helpers');
const usage = require('../src/usage');
const jobs = require('../src/jobs');

let h, deps, backups;
const MB = 1024 * 1024;
before(async () => {
  backups = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-usage-backups-'));
  h = await setup({ env: { DISK_QUOTA_MB: '100', SMTP_HOURLY_LIMIT: '10', SMTP_DAILY_LIMIT: '50', BACKUP_DIR: backups } });
  deps = h.app.locals;
  fs.mkdirSync(path.join(backups, '20261025T021500Z'), { recursive: true });
  fs.writeFileSync(path.join(backups, '20261025T021500Z', 'db.dump'), Buffer.alloc(3 * 1024));
  fs.mkdirSync(path.join(h.config.filesDir, 'org-a', 'patient-files'), { recursive: true });
  fs.writeFileSync(path.join(h.config.filesDir, 'org-a', 'patient-files', 'x.pdf'), Buffer.alloc(5 * 1024));
});
after(async () => {
  await h.close();
  fs.rmSync(backups, { recursive: true, force: true });
});

const alertsTo = (email, from) => h.outbox().slice(from).filter((m) => JSON.stringify(m.to).includes(email));
const fake = (diskPct, extra = {}) => ({
  dbBytes: Math.round(diskPct * MB * 0.6), filesBytes: Math.round(diskPct * MB * 0.3), backupsBytes: Math.round(diskPct * MB * 0.1),
  diskTotalBytes: 1e12, diskFreeBytes: 5e11, emailsLastHour: 0, emailsToday: 0, ...extra,
});

test('collectUsage(): database size, clinic files and backups (walked), free disk, e-mails of the last hour and today', async () => {
  await h.sql("insert into public.mail_log (sent_at, ok) values (now() - interval '10 minutes', true), (now() - interval '2 hours', true), (now() - interval '3 days', false)");
  const u = await usage.collectUsage(deps.db, deps.config);
  assert.ok(u.dbBytes > MB, 'pg_database_size');
  assert.equal(u.filesBytes, 5 * 1024);
  assert.equal(u.backupsBytes, 3 * 1024);
  assert.ok(u.diskTotalBytes > 0 && u.diskFreeBytes > 0);
  assert.equal(u.emailsLastHour, 1);
  assert.ok(u.emailsToday >= 1 && u.emailsToday <= 2);
});

test('levels: 72 % → one 70 % alert to the platform admins; again → nothing; 86 % → 85 %; back to 50 % → «انتهى الخطر»', async () => {
  const from = h.outbox().length;
  let r = await usage.checkUsage(deps, { usage: fake(72) });
  assert.deepEqual(r.sent.map((a) => [a.key, a.level]), [['disk', 70]]);
  let mails = alertsTo(USER.superAdmin.email, from);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /70|72/);
  assert.match(mails[0].text, /القرص|disk/i);

  r = await usage.checkUsage(deps, { usage: fake(73) });
  assert.deepEqual(r.sent, [], 'the same level is not sent twice');
  r = await usage.checkUsage(deps, { usage: fake(86) });
  assert.deepEqual(r.sent.map((a) => [a.key, a.level]), [['disk', 85]]);
  r = await usage.checkUsage(deps, { usage: fake(75) });
  assert.deepEqual(r.sent, [], 'going down within the alert zone sends nothing');
  r = await usage.checkUsage(deps, { usage: fake(87) });
  assert.deepEqual(r.sent, [], '85 % was already sent in the last 24 hours');
  r = await usage.checkUsage(deps, { usage: fake(50) });
  assert.deepEqual(r.sent.map((a) => [a.key, a.level]), [['disk', 0]]);
  mails = alertsTo(USER.superAdmin.email, from);
  assert.equal(mails.length, 3);
  assert.match(mails[2].text, /انتهى الخطر/);
  assert.match(mails[2].text, /back below/i);
});

test('hovering around 70 %: one alert and one «انتهى الخطر», not one every time it dips', async () => {
  await h.sql("delete from public.alert_state");
  const from = h.outbox().length;
  const levels = [];
  for (const pct of [71, 69, 71, 69, 72, 68]) {
    const r = await usage.checkUsage(deps, { usage: fake(pct) });
    levels.push(...r.sent.filter((a) => a.key === 'disk').map((a) => a.level));
  }
  assert.deepEqual(levels, [70, 0], 'the 70 % alert once a day, and its recovery once');
  assert.equal(alertsTo(USER.superAdmin.email, from).length, 2);
});

test('the e-mail budget: the hourly and daily SMTP limits are levels too', async () => {
  const r = await usage.checkUsage(deps, { usage: fake(10, { emailsLastHour: 10, emailsToday: 20 }) });
  assert.deepEqual(r.sent.map((a) => [a.key, a.level]).sort(), [['email_hour', 95]]);
  assert.equal(r.levels.email_day, 0, '20 of 50');
});

test('e-mail jobs wait for the next hour once the hourly budget is spent; the attempt is not counted', async () => {
  await h.sql("insert into public.mail_log (sent_at, ok) select now() - interval '5 minutes', true from generate_series(1, 10)");
  const id = await jobs.enqueue(deps.db, 'email.password_reset', { userId: USER.physioDoctor.id, lang: 'ar' });
  const before = h.outbox().length;
  await jobs.runDue(deps.db, { deps });
  const { rows: [j] } = await h.sql('select * from public.jobs where id = $1', [id]);
  assert.equal(j.done_at, null);
  assert.equal(j.attempts, 0);
  assert.match(j.last_error, /hourly e-mail limit/);
  const next = new Date(Math.floor(Date.now() / 3600e3) * 3600e3 + 3600e3);
  assert.equal(Date.parse(j.run_at), next.getTime(), 'the start of the next hour');
  assert.equal(h.outbox().length, before, 'nothing sent');
});

test('usage.check is a job (hourly); GET /api/platform/usage shows the latest snapshot with the limits and levels', async () => {
  const id = await jobs.enqueue(deps.db, 'usage.check', {});
  await jobs.runDue(deps.db, { deps, now: new Date(Date.now() + 2 * 3600e3) });
  assert.ok((await h.sql('select done_at from public.jobs where id = $1', [id])).rows[0].done_at);
  const sa = await h.as('superAdmin', { platform: true });
  const res = await sa.get('/api/platform/usage');
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.snapshot.db_bytes > 0);
  assert.deepEqual(res.body.limits, { disk_bytes: 100 * MB, emails_per_hour: 10, emails_per_day: 50 });
  assert.deepEqual(Object.keys(res.body.levels).sort(), ['disk', 'email_day', 'email_hour']);
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  assert.equal((await admin.get('/api/platform/usage')).status, 403);
});
