'use strict';
// Regression tests for the issues found by the security review of
// 22 Oct 2026 (clinic isolation, admin routes, configuration). Each test
// reproduces the attack that worked before the fix.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG, PASSWORD, TEST_DB_URL } = require('./helpers');
const { loadConfig } = require('../src/config');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

// ── audit_events through /api/data (0004_audit_integrity.sql) ───────────

test('a clinic member cannot forge audit rows or squat audit ids that block other clinics', async () => {
  const { rows: [seq] } = await h.sql('select last_value from audit_events_id_seq');
  const next = Number(seq.last_value) + 1;
  const ahead = next + 100000;
  const reception = await h.as('physioReception', { slug: 'demo-physio' });
  const res = await reception.data({
    table: 'audit_events',
    action: 'insert',
    returning: false,
    values: [
      // the next ids of the shared sequence (the denial of service) ...
      { id: next, actor_uid: USER.superAdmin.id, actor_role: 'super_admin', action: 'sec.forged', table_name: 'organizations', created_at: '2020-01-01T00:00:00Z' },
      { id: next + 1, actor_uid: USER.dentalAdmin.id, actor_role: 'admin', action: 'sec.forged', table_name: 'staff' },
      // ... and one far ahead
      { id: ahead, actor_uid: USER.dentalAdmin.id, actor_role: 'admin', action: 'sec.forged', table_name: 'staff' },
    ],
  });
  assert.equal(res.status, 200, res.text);
  const { rows } = await h.asSystem("select id, actor_uid, actor_role, created_at, organization_id from audit_events where action = 'sec.forged'");
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.organization_id, ORG.physio);
    assert.equal(r.actor_uid, USER.physioReception.id, 'actor is the caller, not the forged one');
    assert.equal(r.actor_role, 'receptionist');
    assert.ok(Date.now() - Date.parse(r.created_at) < 60 * 60 * 1000, 'not back-dated');
    assert.notEqual(Number(r.id), ahead, 'caller-chosen ids are replaced by the sequence');
  }
  // Before the fix the next audit writes of EVERY clinic failed with 23505
  // on audit_events_pkey: here the dental admin's invitations.
  const dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
  for (const email of ['sec-victim1@demo-dental.test', 'sec-victim2@demo-dental.test']) {
    const inv = await dental.post('/api/org/invitations', { email, role: 'doctor', branch_ids: ['br-demo-dental-1'] });
    assert.equal(inv.status, 201, inv.text);
  }
});

// ── /api/admin/create-user ─────────────────────────────────────────────

test('create-user cannot take over an account that is in no clinic (409, password unchanged)', async () => {
  // outsider@ (test fixtures) has an account but no membership anywhere,
  // like an imported account without a staff row.
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const res = await admin.post('/api/admin/create-user', {
    email: USER.outsider.email, password: 'Hijack#123', name: 'hijacked', role: 'receptionist',
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.error, 'email_exists');
  const bad = await h.client().post('/api/auth/login', { email: USER.outsider.email, password: 'Hijack#123' });
  assert.equal(bad.status, 401);
  await h.login(USER.outsider.email, { password: PASSWORD });
  const { rows } = await h.sql('select 1 from organization_members where user_id = $1', [USER.outsider.id]);
  assert.equal(rows.length, 0, 'no membership was created');
});

test('create-user rejects an oversized e-mail at once (no regex backtracking on the event loop)', async () => {
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  // ~1 MB: the old check (regex before the length limit) needed minutes here
  // (32 KB already took ~0.8 s and the cost grows with the square).
  const email = `a@${'.a'.repeat(500000)}@`;
  const started = Date.now();
  const res = await admin.post('/api/admin/create-user', { email, password: 'Secret#123', name: 'x', role: 'receptionist' });
  const ms = Date.now() - started;
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_email');
  assert.ok(ms < 2000, `took ${ms} ms`);
});

// ── configuration ───────────────────────────────────────────────────────

test('config: the session cookie is Secure by default in production (TRD), and can be turned off explicitly', () => {
  const strong = 'x'.repeat(40);
  const base = { NODE_ENV: 'production', JWT_SECRET: strong, FILES_SIGNING_SECRET: `y${strong}`, DATABASE_URL: TEST_DB_URL, APP_BASE_DOMAIN: 'clinicsyseg.com' };
  assert.equal(loadConfig(base).cookieSecure, true);
  assert.equal(loadConfig({ ...base, COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.equal(loadConfig({}).cookieSecure, false, 'development (http://localhost) stays without Secure');
});

test('config: the public development secrets are refused outside local domains', () => {
  // NODE_ENV not production (e.g. cPanel "Development" mode) on a real domain:
  // the built-in JWT secret would let anyone sign a Super Admin session.
  assert.throws(() => loadConfig({ NODE_ENV: 'development', APP_BASE_DOMAIN: 'clinicsyseg.com' }), /JWT_SECRET and FILES_SIGNING_SECRET must be set/);
  assert.throws(
    () => loadConfig({ APP_BASE_DOMAIN: 'clinicsyseg.com', JWT_SECRET: 'j'.repeat(40) }),
    /FILES_SIGNING_SECRET must be set/,
  );
  const own = loadConfig({ APP_BASE_DOMAIN: 'staging.clinicsyseg.com', JWT_SECRET: 'j'.repeat(40), FILES_SIGNING_SECRET: 'f'.repeat(40) });
  assert.equal(own.appBaseDomain, 'staging.clinicsyseg.com');
  for (const domain of ['localhost', 'demo.localhost', 'clinicsys.test', '127.0.0.1']) {
    assert.equal(loadConfig({ APP_BASE_DOMAIN: domain }).appBaseDomain, domain);
  }
});
