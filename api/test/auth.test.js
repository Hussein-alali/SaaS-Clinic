'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { setup, sessionCookie, USER, PASSWORD } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('login success returns user, memberships and an httpOnly SameSite=Lax 12h cookie', async () => {
  const res = await h.client({ ip: '10.0.0.1' }).post('/api/auth/login', { email: USER.multi.email, password: PASSWORD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { id: USER.multi.id, email: USER.multi.email, name: 'Two Clinics' });
  assert.equal(res.body.is_super_admin, false);
  const slugs = res.body.memberships.map((m) => `${m.slug}:${m.role}:${m.status}:${m.specialty_code}`).sort();
  assert.deepEqual(slugs, ['demo-dental:receptionist:active:dental', 'demo-physio:therapist:active:physio']);
  assert.ok(res.body.memberships.every((m) => m.organization_id && m.name));

  const c = sessionCookie(res);
  assert.ok(c, 'cs_session cookie set');
  assert.match(c.header, /HttpOnly/i);
  assert.match(c.header, /SameSite=Lax/i);
  assert.match(c.header, /Path=\//);
  assert.match(c.header, /Max-Age=43200/);
  assert.doesNotMatch(c.header, /Secure/i);
  assert.doesNotMatch(c.header, /Domain=/i);

  const token = decodeURIComponent(c.value.slice('cs_session='.length));
  const payload = jwt.decode(token, { complete: true });
  assert.equal(payload.header.alg, 'HS256');
  assert.equal(payload.payload.sub, USER.multi.id);
  assert.equal(payload.payload.sv, 1);
  assert.equal(payload.payload.exp - payload.payload.iat, 12 * 3600);
  assert.deepEqual(Object.keys(payload.payload).sort(), ['exp', 'iat', 'sub', 'sv']);

  const s = await h.client({ cookie: c }).get('/api/auth/session');
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, res.body);
});

test('remember me issues a 30-day cookie; e-mail is case-insensitive; Supabase $2a$ hashes work', async () => {
  const res = await h
    .client({ ip: '10.0.0.2' })
    .post('/api/auth/login', { email: USER.physioReception.email.toUpperCase(), password: PASSWORD, remember: true });
  assert.equal(res.status, 200);
  assert.match(sessionCookie(res).header, /Max-Age=2592000/);
});

test('super admin flag and users without memberships', async () => {
  const { res } = await h.login(USER.superAdmin.email, { ip: '10.0.0.3' });
  assert.equal(res.body.is_super_admin, true);
  assert.deepEqual(res.body.memberships, []);
  // memberships only list active members of active clinics
  const s = await h.login(USER.suspendedAdmin.email, { ip: '10.0.0.3' });
  assert.deepEqual(s.res.body.memberships, []);
});

test('login failures share one generic 401 message', async () => {
  const c = h.client({ ip: '10.0.1.1' });
  const wrong = await c.post('/api/auth/login', { email: USER.physioAdmin.email, password: 'nope-nope' });
  const unknown = await c.post('/api/auth/login', { email: 'nobody@clinicsys.test', password: 'nope-nope' });
  const disabled = await c.post('/api/auth/login', { email: USER.disabled.email, password: PASSWORD });
  for (const r of [wrong, unknown, disabled]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: { message: 'Invalid login credentials', code: 'invalid_credentials' } });
    assert.equal(sessionCookie(r), null);
  }
  const missing = await c.post('/api/auth/login', { email: USER.physioAdmin.email });
  assert.equal(missing.status, 400);
});

test('login requires the X-Requested-With header (CSRF)', async () => {
  const res = await h.client({ csrf: false, ip: '10.0.1.2' }).post('/api/auth/login', { email: USER.physioAdmin.email, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'csrf_header_required');
  const wrong = await h
    .client({ csrf: false, ip: '10.0.1.2' })
    .post('/api/auth/login', { email: USER.physioAdmin.email, password: PASSWORD }, { 'x-requested-with': 'XMLHttpRequest' });
  assert.equal(wrong.status, 403);
});

test('rate limit: 10 failures per e-mail in 15 minutes → 429, even from other IPs and with the right password', async () => {
  const email = USER.physioDoctor.email;
  for (let i = 0; i < 10; i++) {
    const r = await h.client({ ip: `10.1.0.${i + 1}` }).post('/api/auth/login', { email, password: `bad-${i}` });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await h.client({ ip: '10.1.0.99' }).post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_attempts');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  // other accounts are unaffected
  const other = await h.client({ ip: '10.1.0.99' }).post('/api/auth/login', { email: USER.physioAdmin.email, password: PASSWORD });
  assert.equal(other.status, 200);
});

test('rate limit: 10 failures per IP in 15 minutes → 429 for any e-mail from that IP', async () => {
  const ip = '10.2.0.1';
  for (let i = 0; i < 10; i++) {
    const r = await h.client({ ip }).post('/api/auth/login', { email: `ghost${i}@clinicsys.test`, password: 'x-wrong' });
    assert.equal(r.status, 401);
  }
  const blocked = await h.client({ ip }).post('/api/auth/login', { email: USER.dentalAdmin.email, password: PASSWORD });
  assert.equal(blocked.status, 429);
  const elsewhere = await h.client({ ip: '10.2.0.2' }).post('/api/auth/login', { email: USER.dentalAdmin.email, password: PASSWORD });
  assert.equal(elsewhere.status, 200);
});

test('a successful login clears the e-mail failure counter', async () => {
  const email = USER.physioTherapist.email;
  for (let i = 0; i < 9; i++) await h.client({ ip: `10.3.0.${i + 1}` }).post('/api/auth/login', { email, password: 'wrong-pw' });
  assert.equal((await h.login(email, { ip: '10.3.1.1' })).res.status, 200);
  for (let i = 0; i < 9; i++) {
    const r = await h.client({ ip: `10.3.2.${i + 1}` }).post('/api/auth/login', { email, password: 'wrong-pw' });
    assert.equal(r.status, 401);
  }
});

test('no cookie, garbage cookie, forged signature → 401', async () => {
  assert.equal((await h.client().get('/api/auth/session')).status, 401);
  const garbage = await h.client({ cookie: 'cs_session=abc.def.ghi' }).get('/api/auth/session');
  assert.equal(garbage.status, 401);
  assert.equal(garbage.body.error.code, 'invalid_session');
  assert.match(sessionCookie(garbage).header, /Expires=Thu, 01 Jan 1970/);
  const forged = jwt.sign({ sub: USER.physioAdmin.id, sv: 1 }, 'not-the-secret', { algorithm: 'HS256', expiresIn: 60 });
  assert.equal((await h.client({ cookie: `cs_session=${forged}` }).get('/api/auth/session')).status, 401);
  const none = jwt.sign({ sub: USER.physioAdmin.id, sv: 1 }, '', { algorithm: 'none' });
  assert.equal((await h.client({ cookie: `cs_session=${none}` }).get('/api/auth/session')).status, 401);
  const expired = jwt.sign({ sub: USER.physioAdmin.id, sv: 1, exp: Math.floor(Date.now() / 1000) - 10 }, h.config.jwtSecret);
  assert.equal((await h.client({ cookie: `cs_session=${expired}` }).get('/api/auth/session')).status, 401);
});

test('password change bumps session_version: other sessions die, this one is re-issued', async () => {
  const a = await h.login(USER.changer.email, { ip: '10.4.0.1', remember: true });
  const b = await h.login(USER.changer.email, { ip: '10.4.0.2' });
  const tooShort = await h.client({ cookie: a.cookie }).post('/api/auth/password', { password: '123' });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.error.code, 'weak_password');

  const res = await h.client({ cookie: a.cookie }).post('/api/auth/password', { password: 'NewPass#2026' });
  assert.equal(res.status, 204);
  const renewed = sessionCookie(res);
  assert.ok(renewed, 'cookie re-issued');
  assert.match(renewed.header, /Max-Age=2592000/, 'keeps the remember-me lifetime');

  assert.equal((await h.client({ cookie: b.cookie }).get('/api/auth/session')).status, 401, 'other session revoked');
  assert.equal((await h.client({ cookie: a.cookie }).get('/api/auth/session')).status, 401, 'old token revoked');
  assert.equal((await h.client({ cookie: renewed }).get('/api/auth/session')).status, 200, 'new token works');

  const { rows } = await h.sql('select session_version from auth.users where id = $1', [USER.changer.id]);
  assert.equal(rows[0].session_version, 2);
  const oldPw = await h.client({ ip: '10.4.0.3' }).post('/api/auth/login', { email: USER.changer.email, password: PASSWORD });
  assert.equal(oldPw.status, 401);
  assert.equal((await h.login(USER.changer.email, { password: 'NewPass#2026', ip: '10.4.0.3' })).res.status, 200);
});

test('disabling the account ends its sessions immediately (status alone, or version bump)', async () => {
  const { cookie } = await h.login(USER.physioStaff.email, { ip: '10.5.0.1' });
  const c = h.client({ cookie });
  assert.equal((await c.get('/api/auth/session')).status, 200);
  await h.sql("update auth.users set status = 'disabled' where id = $1", [USER.physioStaff.id]);
  const r = await c.get('/api/auth/session');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'session_revoked');
  await h.sql("update auth.users set status = 'active' where id = $1", [USER.physioStaff.id]);
  assert.equal((await c.get('/api/auth/session')).status, 200, 're-enabled, same version');
  await h.sql('update auth.users set session_version = session_version + 1 where id = $1', [USER.physioStaff.id]);
  assert.equal((await c.get('/api/auth/session')).status, 401, 'version bump revokes');
  // data routes enforce it too
  const d = await h.client({ cookie, slug: 'demo-physio' }).data({ table: 'patients' });
  assert.equal(d.status, 401);
});

test('profile update changes the name in auth.users metadata', async () => {
  const { cookie } = await h.login(USER.dentalAdmin.email, { ip: '10.6.0.1' });
  const c = h.client({ cookie });
  const bad = await c.patch('/api/auth/profile', { name: '   ' });
  assert.equal(bad.status, 400);
  const res = await c.patch('/api/auth/profile', { name: 'د. منى' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: { id: USER.dentalAdmin.id, email: USER.dentalAdmin.email, name: 'د. منى' } });
  assert.equal((await c.get('/api/auth/session')).body.user.name, 'د. منى');
  const { rows } = await h.sql('select raw_user_meta_data from auth.users where id = $1', [USER.dentalAdmin.id]);
  assert.equal(rows[0].raw_user_meta_data.name, 'د. منى');
});

test('logout clears the cookie with 204', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email, { ip: '10.7.0.1' });
  const res = await h.client({ cookie }).post('/api/auth/logout', {});
  assert.equal(res.status, 204);
  const cleared = sessionCookie(res);
  assert.match(cleared.header, /cs_session=;/);
  assert.match(cleared.header, /Expires=Thu, 01 Jan 1970/);
  assert.equal((await h.client({ csrf: false }).post('/api/auth/logout', {})).status, 403, 'logout needs the CSRF header');
});

test('password reset: 204 always, hashed single-use token valid 1 hour, link to APP_BASE_DOMAIN', async () => {
  const before = h.outbox().length;
  const unknown = await h.client({ ip: '10.8.0.1' }).post('/api/auth/reset/request', { email: 'nobody@clinicsys.test' });
  assert.equal(unknown.status, 204);
  const invalid = await h.client({ ip: '10.8.0.1' }).post('/api/auth/reset/request', { email: 'not an email' });
  assert.equal(invalid.status, 204, 'always 204');

  const { cookie: oldSession } = await h.login(USER.resetter.email, { ip: '10.8.0.2' });
  const res = await h.client({ ip: '10.8.0.1' }).post('/api/auth/reset/request', { email: USER.resetter.email.toUpperCase() });
  assert.equal(res.status, 204);
  await h.app.locals.drain();
  const mails = await waitFor(() => (h.outbox().length > before ? h.outbox() : null));
  assert.ok(mails, 'reset e-mail written to the outbox');
  assert.equal(mails.length, before + 1, 'no e-mail for the unknown address');
  const mail = mails[mails.length - 1];
  assert.equal(mail.to, USER.resetter.email);
  const m = mail.text.match(new RegExp(`http://localhost:${h.port}/\\?reset=([A-Za-z0-9_-]+)`));
  assert.ok(m, `link in ${mail.text}`);
  const token = m[1];

  const { rows } = await h.sql(
    "select token_hash, used_at, expires_at - now() between interval '59 minutes' and interval '61 minutes' as one_hour from auth.password_reset_tokens where user_id = $1",
    [USER.resetter.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'), 'only the SHA-256 is stored');
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].one_hour, true);

  const weak = await h.client().post('/api/auth/reset/confirm', { token, password: '1' });
  assert.equal(weak.status, 400);
  const ok = await h.client().post('/api/auth/reset/confirm', { token, password: 'Reset#Pass1' });
  assert.equal(ok.status, 204);
  const again = await h.client().post('/api/auth/reset/confirm', { token, password: 'Reset#Pass2' });
  assert.equal(again.status, 400, 'single use');
  assert.equal(again.body.error.code, 'invalid_token');

  assert.equal((await h.client({ cookie: oldSession }).get('/api/auth/session')).status, 401, 'reset revokes sessions');
  assert.equal((await h.login(USER.resetter.email, { password: 'Reset#Pass1', ip: '10.8.0.3' })).res.status, 200);
});

test('password reset: expired and unknown tokens are refused', async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  await h.sql("insert into auth.password_reset_tokens (token_hash, user_id, expires_at) values ($1, $2, now() - interval '1 minute')", [
    crypto.createHash('sha256').update(token).digest('hex'),
    USER.physioDoctor.id,
  ]);
  const expired = await h.client().post('/api/auth/reset/confirm', { token, password: 'Whatever#1' });
  assert.equal(expired.status, 400);
  const unknown = await h.client().post('/api/auth/reset/confirm', { token: crypto.randomBytes(32).toString('base64url'), password: 'Whatever#1' });
  assert.equal(unknown.status, 400);
});

test('COOKIE_SECURE and COOKIE_DOMAIN are applied to the session cookie', async () => {
  const { createApp } = require('../src/create-app');
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: h.config.databaseUrl, COOKIE_SECURE: 'true', COOKIE_DOMAIN: '.clinicsyseg.test' });
  const app = createApp(cfg);
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const { rawRequest } = require('./helpers');
    const res = await rawRequest(server.address().port, 'POST', '/api/auth/login', {
      headers: { 'x-requested-with': 'clinicsys' },
      json: { email: USER.physioAdmin.email, password: PASSWORD },
    });
    assert.equal(res.status, 200);
    const c = sessionCookie(res).header;
    assert.match(c, /; Secure/);
    assert.match(c, /Domain=\.clinicsyseg\.test/);
    assert.match(res.headers['strict-transport-security'] || '', /max-age=/);
  } finally {
    await new Promise((r) => server.close(r));
    await app.locals.close();
  }
});

