'use strict';
// Rate limits shared by every API process (docs/06 S5, 0011_rate_limits):
// Passenger runs several Node processes, and an in-memory counter is per
// process (the limit multiplied by their number) and forgotten on restart.
// The second app below shares the database, like a second Passenger worker.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rawRequest, freePort, USER, ORG, PASSWORD, RATE_LIMIT_CLOCK } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const ratelimit = require('../src/ratelimit');

let h, other, otherPort;
before(async () => {
  h = await setup();
  otherPort = await freePort();
  const app = createApp(h.config);
  other = { app, server: await new Promise((r) => { const s = app.listen(otherPort, '127.0.0.1', () => r(s)); }) };
});
after(async () => {
  await new Promise((r) => other.server.close(r));
  await other.app.locals.close();
  await h.close();
});

const headers = (ip) => ({ 'x-requested-with': 'clinicsys', 'x-forwarded-for': ip });
const loginOn = (port, email, password, ip) => rawRequest(port, 'POST', '/api/auth/login', { headers: headers(ip), json: { email, password } });

test('login: failures of one e-mail add up across API processes; the 11th attempt is 429 with Retry-After', async () => {
  const email = USER.physioReception2.email;
  for (let i = 0; i < 10; i++) {
    const port = i % 2 ? otherPort : h.port;
    assert.equal((await loginOn(port, email, `bad-${i}`, `10.50.0.${i + 1}`)).status, 401, `attempt ${i + 1}`);
  }
  for (const port of [h.port, otherPort]) {
    const blocked = await loginOn(port, email, PASSWORD, '10.50.1.1');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'too_many_attempts');
    const wait = Number(blocked.headers['retry-after']);
    assert.ok(wait > 0 && wait <= 900, String(wait));
    assert.equal(blocked.body.error.retry_after, wait);
  }
});

test('login: the window ends and the e-mail may try again (fixed 15-minute windows)', async () => {
  const email = USER.dentalAdmin.email;
  const t0 = Number(RATE_LIMIT_CLOCK); // helpers.js holds the limits' clock still
  try {
    for (let i = 0; i < 10; i++) await loginOn(h.port, email, 'wrong', `10.51.0.${i + 1}`);
    assert.equal((await loginOn(h.port, email, PASSWORD, '10.51.1.1')).status, 429);
    process.env.RATE_LIMIT_NOW = String(t0 + 900e3);
    assert.equal((await loginOn(otherPort, email, PASSWORD, '10.51.1.1')).status, 200);
  } finally {
    process.env.RATE_LIMIT_NOW = RATE_LIMIT_CLOCK;
  }
});

test('login: 50 failures from one IP in 15 minutes block that IP (any e-mail), not others', async () => {
  const ip = '10.52.0.1';
  for (let i = 0; i < 50; i++) {
    assert.equal((await loginOn(i % 2 ? otherPort : h.port, `ghost${i}@clinicsys.test`, 'x-wrong', ip)).status, 401, `attempt ${i + 1}`);
  }
  assert.equal((await loginOn(h.port, USER.physioDoctor.email, PASSWORD, ip)).status, 429);
  assert.equal((await loginOn(h.port, USER.physioDoctor.email, PASSWORD, '10.52.0.2')).status, 200);
});

test('password reset: 20 requests per IP per hour, then 429 rate_limited; at most 3 e-mails per account per hour', async () => {
  const ip = '10.53.0.1';
  const before = h.outbox().length;
  for (let i = 0; i < 20; i++) {
    const r = await rawRequest(i % 2 ? otherPort : h.port, 'POST', '/api/auth/reset/request', { headers: headers(ip), json: { email: USER.physioTherapist.email } });
    assert.equal(r.status, 204, `request ${i + 1}`);
  }
  const blocked = await rawRequest(h.port, 'POST', '/api/auth/reset/request', { headers: headers(ip), json: { email: USER.physioTherapist.email } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await h.app.locals.drain();
  await other.app.locals.drain();
  const sent = h.outbox().slice(before).filter((m) => JSON.stringify(m.to).includes(USER.physioTherapist.email));
  assert.equal(sent.length, 3, 'three reset e-mails, the rest dropped without telling');
});

test('invitations: at most 5 sends (create + resend) to one e-mail per day, from the clinic or the platform', async () => {
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const email = `limit-${Date.now()}@e2e.test`;
  const created = await admin.post('/api/org/invitations', { email, role: 'receptionist', branch_ids: ['br-demo-physio-1'] });
  assert.equal(created.status, 201, created.text);
  const id = created.body.invitation.id;
  for (let i = 0; i < 4; i++) assert.equal((await admin.post(`/api/org/invitations/${id}/resend`, {})).status, 200, `resend ${i + 1}`);
  const blocked = await admin.post(`/api/org/invitations/${id}/resend`, {});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
  const sa = await h.as('superAdmin', { platform: true });
  const viaPlatform = await sa.post(`/api/platform/organizations/${ORG.physio}/invitations/${id}/resend`, {});
  assert.equal(viaPlatform.status, 429, 'the same address, whoever sends');
  // Another address of the clinic is not affected.
  assert.equal((await admin.post('/api/org/invitations', { email: `other-${email}`, role: 'doctor', branch_ids: ['br-demo-physio-1'] })).status, 201);
});

test('invitation links: 30 unknown or unusable tokens per IP in 10 minutes, then 429 (valid links are not counted)', async () => {
  const ip = '10.54.0.1';
  for (let i = 0; i < 30; i++) {
    const r = await rawRequest(i % 2 ? otherPort : h.port, 'GET', `/api/invitations/${'t'.repeat(43)}`, { headers: headers(ip) });
    assert.equal(r.status, 404, `lookup ${i + 1}`);
  }
  const blocked = await rawRequest(h.port, 'GET', `/api/invitations/${'t'.repeat(43)}`, { headers: headers(ip) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
});

test('uploads: 120 per user per hour', async () => {
  await ratelimit.hit(h.app.locals.db, 'upload_user', USER.physioAdmin.id, 120);
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const r = await admin.upload({ bucket: 'patient-files', path: 'P-PHY-01/limit.txt' }, { name: 'limit.txt', type: 'text/plain', data: 'x' });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.body.error.code, 'rate_limited');
  const recep = await h.as('physioReception', { slug: 'demo-physio' });
  const ok = await recep.upload({ bucket: 'patient-files', path: 'P-PHY-01/limit2.txt' }, { name: 'limit2.txt', type: 'text/plain', data: 'x' });
  assert.equal(ok.status, 200, ok.text);
});

test('the counters keep no e-mail, IP or user id: only sha256 of the key', async () => {
  const { rows } = await h.sql('select bucket, key_hash from public.rate_limits');
  assert.ok(rows.length > 0);
  const text = JSON.stringify(rows);
  for (const needle of [USER.physioReception2.email, '10.50.0.1', USER.physioAdmin.id]) assert.ok(!text.includes(needle), needle);
  for (const r of rows) assert.match(r.key_hash, /^[0-9a-f]{64}$/);
});

test('every API process also caps one session at API_RATE_PER_MIN requests a minute (a runaway screen loop)', async () => {
  const port = await freePort();
  const app = createApp(loadConfig({ ...configEnv(h.config), API_RATE_PER_MIN: '5' }));
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  try {
    const { cookie } = await h.login(USER.physioAdmin.email);
    const get = () => rawRequest(port, 'GET', '/api/auth/session', { headers: { cookie: cookie.value || cookie } });
    for (let i = 0; i < 5; i++) assert.equal((await get()).status, 200, `request ${i + 1}`);
    const blocked = await get();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal((await rawRequest(port, 'GET', '/api/health')).status, 200, 'health checks are never throttled');
  } finally {
    await new Promise((r) => server.close(r));
    await app.locals.close();
  }
});

test('the per-process cap never puts every client without an address in one bucket (a Unix-socket proxy gives no req.ip)', () => {
  const { throttle } = require('../src/ratelimit');
  const mw = throttle(2);
  const pass = (req) => {
    let out = 'none';
    mw(req, { set() {} }, (err) => { out = err ? err.status || 'error' : 'next'; });
    return out;
  };
  for (let i = 0; i < 5; i++) assert.equal(pass({ cookies: {}, socket: {} }), 'next', `anonymous request ${i + 1} without an address`);
  const known = { cookies: {}, ip: '10.60.0.1', socket: {} };
  assert.deepEqual([pass(known), pass(known), pass(known)], ['next', 'next', 429], 'a known address still has its cap');
});

// The environment that produced h.config, for a second app with one change.
function configEnv(c) {
  return {
    NODE_ENV: 'test', PORT: '0', DATABASE_URL: c.databaseUrl, APP_BASE_DOMAIN: 'localhost',
    FILES_DIR: c.filesDir, MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: c.mailOutboxDir, DIST_DIR: c.distDir,
  };
}
