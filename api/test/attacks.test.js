'use strict';
// The attack catalogue of the security audit of 25 Oct 2026: each test
// sends the requests an attacker would, by CWE, against the real schema,
// and asserts they are refused or come back empty. A failing test here is
// a vulnerability, not a broken feature. (The fixed findings of the audit
// have their own regression tests next to the code they cover.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { setup, sessionCookie, USER, ORG, PASSWORD } = require('./helpers');

let h, physioAdmin, recep, therapist, doctor, dentalAdmin;
before(async () => {
  h = await setup();
  physioAdmin = await h.as('physioAdmin', { slug: 'demo-physio' });
  recep = await h.as('physioReception', { slug: 'demo-physio' });
  therapist = await h.as('physioTherapist', { slug: 'demo-physio' });
  doctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  dentalAdmin = await h.as('dentalAdmin', { slug: 'demo-dental' });
});
after(() => h.close());

const noServerError = (r, what) => assert.ok(r.status < 500, `${what}: ${r.status} ${r.text}`);

// ── CWE-89 SQL injection ───────────────────────────────────────────────

test('CWE-89: identifiers in /api/data and /api/rpc are refused unless plain names; values are bound', async () => {
  const idents = [
    { table: 'patients; drop table patients' },
    { table: 'patients"--' },
    { table: 'patients', columns: 'name, (select 1)' },
    { table: 'patients', columns: 'count(*)' },
    { table: 'patients', columns: 'name"' },
    { table: 'patients', filters: [{ column: 'name" or 1=1 --', op: 'eq', value: 'x' }] },
    { table: 'patients', filters: [{ column: 'name', op: '= any(array[1]) or', value: 'x' }] },
    { table: 'patients', order: [{ column: 'name desc; select pg_sleep(5)--' }] },
    { table: 'patients', action: 'upsert', values: { patient_id: 'P-X', name: 'x' }, onConflict: 'patient_id) do nothing; --' },
    { table: 'patients', action: 'insert', values: { 'name") values (1); --': 'x' } },
    { table: 'auth.users' },
    { table: 'pg_shadow' },
  ];
  for (const body of idents) {
    const r = await physioAdmin.data(body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.status} ${r.text}`);
  }
  // Values never become SQL: a classic payload is just a string that matches nothing.
  for (const value of ["' or '1'='1", "x'; drop table patients; --", "\\' or 1=1 --"]) {
    const r = await physioAdmin.data({ table: 'patients', filters: [{ column: 'patient_id', op: 'eq', value }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.data, []);
  }
  const rpcs = [
    ['get_treatment"(); drop table patients; --', {}],
    ['pg_sleep', { seconds: 1 }],
    ['get_treatment', { 'p_id" => 1); select 1; --': 'x' }],
  ];
  for (const [fn, args] of rpcs) {
    const r = await physioAdmin.rpc(encodeURIComponent(fn), args);
    assert.ok([400, 404].includes(r.status), `${fn}: ${r.status} ${r.text}`);
  }
  assert.ok((await h.asSystem('select count(*)::int n from patients')).rows[0].n > 0, 'patients still there');
});

// ── CWE-862/863/639 broken access control between clinics ─────────────

test('CWE-863: a clinic\'s admin reads, writes and calls nothing of another clinic', async () => {
  const { rows: [den] } = await h.asSystem(`select patient_id from patients where organization_id = $1 limit 1`, [ORG.dental]);
  assert.ok(den, 'a dental patient');
  // Picking the other clinic by header: not a member.
  const other = await physioAdmin.data({ table: 'patients' }, { 'x-org-slug': 'demo-dental' });
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, 'not_a_member');
  // Its rows by id: invisible, and writes touch nothing.
  const read = await physioAdmin.data({ table: 'patients', filters: [{ column: 'patient_id', op: 'eq', value: den.patient_id }] });
  assert.deepEqual(read.body.data, []);
  const upd = await physioAdmin.data({ table: 'patients', action: 'update', values: { name: 'pwned' }, filters: [{ column: 'patient_id', op: 'eq', value: den.patient_id }] });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.body.data, []);
  const del = await physioAdmin.data({ table: 'patients', action: 'delete', filters: [{ column: 'patient_id', op: 'eq', value: den.patient_id }] });
  assert.deepEqual(del.body.data, []);
  const { rows: [still] } = await h.asSystem('select name from patients where patient_id = $1', [den.patient_id]);
  assert.notEqual(still.name, 'pwned');
  // Writing a row into it: refused.
  const ins = await physioAdmin.data({ table: 'patients', action: 'insert', values: { patient_id: `P-ATK-${Date.now()}`, name: 'x', organization_id: ORG.dental } });
  assert.equal(ins.status, 403);
  // Moving an own row there: refused.
  const move = await physioAdmin.data({ table: 'patients', action: 'update', values: { organization_id: ORG.dental }, filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-01' }] });
  assert.equal(move.status, 403);
  // Its members and invitations by id.
  const { rows: [m] } = await h.sql('select id from organization_members where organization_id = $1 limit 1', [ORG.dental]);
  const patch = await physioAdmin.patch(`/api/org/members/${m.id}`, { role: 'receptionist' });
  assert.ok([403, 404].includes(patch.status), `${patch.status} ${patch.text}`);
  const { rows: [inv] } = await h.sql('select id from invitations where organization_id = $1 limit 1', [ORG.dental]);
  if (inv) {
    const revoke = await physioAdmin.del(`/api/org/invitations/${inv.id}`);
    assert.ok([403, 404].includes(revoke.status), `${revoke.status} ${revoke.text}`);
  }
});

test('CWE-639: a clinic\'s files are not reachable from another clinic, by any path spelling', async () => {
  const up = await dentalAdmin.upload({ bucket: 'patient-files', path: 'P-DEN-01/secret.pdf' }, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 dental') });
  assert.equal(up.status, 200, up.text);
  const own = await dentalAdmin.get('/api/files/object/patient-files/P-DEN-01/secret.pdf');
  assert.equal(own.status, 200, 'the control: its own clinic reads it');
  assert.equal(String(own.raw), '%PDF-1.4 dental');
  const paths = [
    '/api/files/object/patient-files/P-DEN-01/secret.pdf',
    `/api/files/object/patient-files/../../${ORG.dental}/patient-files/P-DEN-01/secret.pdf`,
    `/api/files/object/patient-files/..%2f..%2f${ORG.dental}%2fpatient-files%2fP-DEN-01%2fsecret.pdf`,
    `/api/files/object/patient-files/%2e%2e/%2e%2e/${ORG.dental}/patient-files/P-DEN-01/secret.pdf`,
    '/api/files/object/patient-files/P-DEN-01/secret.pdf%00.png',
    `/api/files/object/patient-files/..\\..\\${ORG.dental}\\patient-files\\P-DEN-01\\secret.pdf`,
  ];
  for (const p of paths) {
    const r = await physioAdmin.get(p);
    assert.ok([400, 403, 404].includes(r.status), `${p}: ${r.status}`);
    assert.equal(String(r.raw || '').includes('dental'), false, p);
  }
  for (const path of ['../x.pdf', '/etc/passwd', 'a/../../b.pdf', 'P-1/\u0000.pdf', '.hidden/x.pdf']) {
    const r = await physioAdmin.upload({ bucket: 'patient-files', path }, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF') });
    assert.equal(r.status, 400, `upload ${JSON.stringify(path)}: ${r.status}`);
  }
});

// ── CWE-269/862 privilege escalation inside a clinic ───────────────────

test('CWE-269: staff below admin cannot invite, change roles, manage accounts or reach platform tables', async () => {
  for (const who of [recep, therapist, doctor]) {
    const inv = await who.post('/api/org/invitations', { email: `atk-${crypto.randomBytes(3).toString('hex')}@x.test`, role: 'admin' });
    assert.equal(inv.status, 403, inv.text);
    const { rows: [self] } = await h.sql('select id from organization_members where organization_id = $1 and role <> $2 limit 1', [ORG.physio, 'admin']);
    const role = await who.patch(`/api/org/members/${self.id}`, { role: 'admin' });
    assert.equal(role.status, 403, role.text);
    for (const p of ['/api/admin/create-user', '/api/admin/reset-password', '/api/admin/set-status']) {
      const r = await who.post(p, { email: 'x@x.test', password: 'Zz9!longpassword', staff_id: 'ST-PHY-ADMIN', auth_uid: USER.physioAdmin.id, active: false });
      assert.equal(r.status, 403, `${p}: ${r.status}`);
    }
  }
  // Tables that decide who is who are not /api/data tables at all, for anyone.
  for (const table of ['organization_members', 'member_branches', 'platform_admins', 'invitations', 'organizations', 'subscriptions', 'organization_modules', 'error_groups', 'jobs', 'rate_limits', 'idempotency_keys']) {
    const r = await physioAdmin.data({ table, action: 'insert', values: { id: 'x' } });
    assert.equal(r.status, 400, `${table}: ${r.status}`);
  }
  // The staff table's role is display data, and only the admin writes it.
  const staff = await recep.data({ table: 'staff', action: 'update', values: { role: 'admin' }, filters: [{ column: 'auth_uid', op: 'eq', value: USER.physioReception.id }] });
  assert.ok(staff.status === 403 || (staff.status === 200 && staff.body.data.length === 0), staff.text);
  // A clinic admin is no Super Admin.
  for (const p of ['/api/platform/stats', '/api/platform/organizations', '/api/platform/errors']) {
    const r = await physioAdmin.get(p, { 'x-platform': '1' });
    assert.equal(r.status, 403, `${p}: ${r.status}`);
  }
});

// ── CWE-306/287 missing or improper authentication ─────────────────────

test('CWE-306: every data, file, clinic and platform route needs a session', async () => {
  const anon = h.client({ slug: 'demo-physio' });
  const routes = [
    ['POST', '/api/data', { table: 'patients' }], ['POST', '/api/rpc/get_treatment', { args: {} }],
    ['POST', '/api/files/sign', { bucket: 'patient-files', path: 'P-1/a.pdf' }], ['GET', '/api/files/object/patient-files/P-1/a.pdf'],
    ['GET', '/api/org/members'], ['GET', '/api/org/usage'], ['POST', '/api/org/invitations', {}],
    ['POST', '/api/admin/create-user', {}], ['GET', '/api/platform/stats'], ['GET', '/api/platform/organizations'],
    ['POST', '/api/auth/password', { password: 'Zz9!longpassword' }], ['PATCH', '/api/auth/profile', { name: 'x' }],
  ];
  for (const [method, p, json] of routes) {
    const r = method === 'GET' ? await anon.get(p) : await h.request(method, p, { headers: { 'x-requested-with': 'clinicsys', 'x-org-slug': 'demo-physio' }, json });
    assert.equal(r.status, 401, `${method} ${p}: ${r.status}`);
  }
});

test('CWE-287: forged, unsigned, expired, other-secret and revoked session tokens are refused', async () => {
  const sign = (payload, secret = h.config.jwtSecret, opts = {}) => jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: 600, ...opts });
  const { rows: [u] } = await h.sql('select session_version from auth.users where id = $1', [USER.physioAdmin.id]);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokens = {
    none: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: USER.superAdmin.id, sv: 0 })}.`,
    otherSecret: sign({ sub: USER.superAdmin.id, sv: 0 }, 'x'.repeat(40)),
    expired: sign({ sub: USER.physioAdmin.id, sv: u.session_version }, h.config.jwtSecret, { expiresIn: -10 }),
    oldVersion: sign({ sub: USER.physioAdmin.id, sv: u.session_version - 1 }),
    unknownUser: sign({ sub: crypto.randomUUID(), sv: 0 }),
    hs512: jwt.sign({ sub: USER.physioAdmin.id, sv: u.session_version }, h.config.jwtSecret, { algorithm: 'HS512' }),
    garbage: 'not.a.jwt',
  };
  for (const [name, token] of Object.entries(tokens)) {
    const r = await h.request('GET', '/api/auth/session', { headers: { cookie: `cs_session=${token}` } });
    assert.equal(r.status, 401, `${name}: ${r.status}`);
  }
  // The real secret and version work (the control).
  const good = await h.request('GET', '/api/auth/session', { headers: { cookie: `cs_session=${sign({ sub: USER.physioAdmin.id, sv: u.session_version })}` } });
  assert.equal(good.status, 200);
});

test('CWE-204: login and reset answer the same for a wrong password and an unknown e-mail', async () => {
  const wrong = await h.client().post('/api/auth/login', { email: USER.physioDoctor.email, password: 'Wrong-password-1' });
  const unknown = await h.client().post('/api/auth/login', { email: 'nobody-here@x.test', password: 'Wrong-password-1' });
  assert.equal(wrong.status, unknown.status);
  assert.deepEqual(wrong.body, unknown.body);
  const a = await h.client().post('/api/auth/reset/request', { email: USER.physioDoctor.email });
  const b = await h.client().post('/api/auth/reset/request', { email: 'nobody-here@x.test' });
  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);
});

// ── CWE-384 session fixation ───────────────────────────────────────────

test('CWE-384: a cookie set before login is replaced, not adopted; the session cookie is HttpOnly and SameSite', async () => {
  const planted = 'attacker-chosen-value';
  const res = await h.request('POST', '/api/auth/login', {
    headers: { 'x-requested-with': 'clinicsys', cookie: `cs_session=${planted}` },
    json: { email: USER.physioDoctor.email, password: PASSWORD },
  });
  assert.equal(res.status, 200, res.text);
  const set = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('cs_session='));
  assert.ok(set, 'a new session cookie');
  assert.equal(set.includes(planted), false);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.notEqual(sessionCookie(res).value, `cs_session=${planted}`);
});

// ── CWE-352/942 CSRF and CORS ──────────────────────────────────────────

test('CWE-942: no CORS: another origin gets no Access-Control-Allow-* header, preflights included', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  const evil = { origin: 'https://evil.example', cookie: cookie.value };
  const get = await h.request('GET', '/api/auth/session', { headers: evil });
  assert.equal(get.headers['access-control-allow-origin'], undefined);
  assert.equal(get.headers['access-control-allow-credentials'], undefined);
  const pre = await h.request('OPTIONS', '/api/data', { headers: { ...evil, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with,content-type' } });
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  assert.equal(pre.headers['access-control-allow-headers'], undefined);
  // A cross-site form post (no custom header) is refused before anything runs.
  const form = await h.request('POST', '/api/data', { headers: { ...evil, 'content-type': 'application/x-www-form-urlencoded' }, body: 'table=patients' });
  assert.equal(form.status, 403);
});

// ── Business logic (CWE-840) ───────────────────────────────────────────

test('CWE-840: a quick payment cannot be negative, zero, or for another clinic\'s invoice', async () => {
  const pay = (allocations) => recep.rpc('record_quick_payment', { p_patient_id: 'P-PHY-01', p_allocations: allocations, p_method: 'cash' });
  const state = async () => (await h.asSystem(
    `select (select paid from invoices where invoice_id = 'INV-PHY-B1-1') phy, (select paid from invoices where invoice_id = 'INV-DEN-B1-1') den,
            (select count(*)::int from payments) n`)).rows[0];
  const before = await state();
  for (const amount of [-50, 0, 'abc', null]) {
    const r = await pay([{ type: 'invoice', id: 'INV-PHY-B1-1', amount }]);
    assert.ok(r.status >= 400 && r.status < 500, `amount ${amount}: ${r.status} ${r.text}`);
  }
  const den = await pay([{ type: 'invoice', id: 'INV-DEN-B1-1', amount: 1 }]);
  assert.ok(den.status >= 400 && den.status < 500, `other clinic's invoice: ${den.status} ${den.text}`);
  assert.deepEqual(await state(), before, 'no payment and no invoice changed');
  const ok = await pay([{ type: 'invoice', id: 'INV-PHY-B1-1', amount: 1 }]);
  assert.equal(ok.status, 200, `the control: a real payment works: ${ok.text}`);
});

// ── Error handling (CWE-209) ───────────────────────────────────────────

test('CWE-209: database errors reach the client as message + SQLSTATE only, never the query or a stack', async () => {
  const r = await physioAdmin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-PHY-01', name: 'dup' } });
  assert.equal(r.status, 409);
  assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message']);
  assert.doesNotMatch(r.text, /insert into|stack|at \w+ \(|node_modules/i);
  noServerError(r, 'duplicate');
});
