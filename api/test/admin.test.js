'use strict';
// /api/admin/* — the Edge Function replacements (admin-create-user,
// admin-reset-password, admin-set-status), against the real schema + seed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG, BRANCH, PASSWORD } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

const physioAdmin = () => h.as('physioAdmin', { slug: 'demo-physio' });
const audits = async (action, orgId = ORG.physio) =>
  (await h.asSystem('select * from audit_events where action = $1 and organization_id = $2 order by id', [action, orgId])).rows;

async function member(orgId, email) {
  const { rows } = await h.sql(
    `select m.id, m.role, m.status, m.invited_by,
            coalesce((select array_agg(mb.branch_id order by mb.branch_id) from member_branches mb where mb.member_id = m.id), '{}') as branches
       from organization_members m join auth.users u on u.id = m.user_id
      where m.organization_id = $1 and lower(u.email) = lower($2)`,
    [orgId, email],
  );
  return rows[0] || null;
}

async function staffRow(orgId, where, params) {
  const { rows } = await h.asSystem(`select * from staff where organization_id = $1 and ${where}`, [orgId, ...params]);
  return rows[0] || null;
}

async function withPlan(orgId, limits, fn) {
  const { rows: [plan] } = await h.sql(
    `insert into subscription_plans (code, name, max_users, max_branches) values ($1, 'test plan', $2, $3) returning id`,
    [`admin-test-${Date.now()}`, limits.max_users ?? null, limits.max_branches ?? null],
  );
  const { rows: [org] } = await h.sql('select plan_id from organizations where id = $1', [orgId]);
  await h.sql('update organizations set plan_id = $2 where id = $1', [orgId, plan.id]);
  try {
    await fn();
  } finally {
    await h.sql('update organizations set plan_id = $2 where id = $1', [orgId, org.plan_id]);
  }
}

// ── create-user ──────────────────────────────────────────────────────────

test('create-user: new account + active membership + staff row (same role) + branch, audited', async () => {
  const admin = await physioAdmin();
  const res = await admin.post('/api/admin/create-user', {
    email: '  New.Reception@Demo-Physio.test ', password: 'Secret#123', name: 'استقبال جديد', role: 'receptionist', phone: '0100',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.match(res.body.uid, /^[0-9a-f-]{36}$/);
  assert.match(res.body.staff_id, /^U-[0-9a-z]{12,}$/);
  assert.equal(res.body.linked, false);

  const { rows: [user] } = await h.sql('select email, status, raw_user_meta_data, email_confirmed_at from auth.users where id = $1', [res.body.uid]);
  assert.equal(user.email, 'new.reception@demo-physio.test');
  assert.equal(user.status, 'active');
  assert.equal(user.raw_user_meta_data.name, 'استقبال جديد');
  assert.ok(user.email_confirmed_at);

  const m = await member(ORG.physio, 'new.reception@demo-physio.test');
  assert.equal(m.role, 'receptionist');
  assert.equal(m.status, 'active');
  assert.equal(m.invited_by, USER.physioAdmin.id);
  assert.deepEqual(m.branches, [BRANCH.physio1], "default: the admin's current branch");

  const staff = await staffRow(ORG.physio, 'staff_id = $2', [res.body.staff_id]);
  assert.equal(staff.role, 'receptionist');
  assert.equal(staff.auth_uid, res.body.uid);
  assert.equal(staff.status, 'active');
  assert.equal(staff.phone, '0100');
  assert.equal(staff.created_by, USER.physioAdmin.id);

  const [a] = await audits('staff.create');
  assert.equal(a.actor_uid, USER.physioAdmin.id);
  assert.equal(a.actor_role, 'admin');
  assert.equal(a.row_pk, res.body.staff_id);
  assert.equal(a.target_type, 'member');
  assert.equal(a.target_id, m.id);
  assert.equal(a.result, 'success');
  assert.equal(a.payload.account, 'created');

  // The new account works in its clinic, in its branch.
  const { cookie } = await h.login('new.reception@demo-physio.test', { password: 'Secret#123' });
  const current = await h.client({ cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(current.body.role, 'receptionist');
  assert.equal(current.body.current_branch_id, BRANCH.physio1);
});

test('create-user: explicit branch_ids; admin role gets no member_branches rows', async () => {
  const admin = await physioAdmin();
  const doc = await admin.post('/api/admin/create-user', {
    email: 'second.doctor@demo-physio.test', password: 'Secret#123', name: 'Second doctor', role: 'doctor', branch_ids: [BRANCH.physio2],
  });
  assert.equal(doc.status, 200, doc.text);
  assert.deepEqual((await member(ORG.physio, 'second.doctor@demo-physio.test')).branches, [BRANCH.physio2]);
  const adm = await admin.post('/api/admin/create-user', {
    email: 'second.admin@demo-physio.test', password: 'Secret#123', name: 'Second admin', role: 'admin', branch_ids: [BRANCH.physio2],
  });
  assert.equal(adm.status, 200, adm.text);
  assert.deepEqual((await member(ORG.physio, 'second.admin@demo-physio.test')).branches, []);
  const foreign = await admin.post('/api/admin/create-user', {
    email: 'x1@demo-physio.test', password: 'Secret#123', name: 'X', role: 'doctor', branch_ids: [BRANCH.dental1],
  });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error, 'invalid_branch');
  assert.equal(await member(ORG.physio, 'x1@demo-physio.test'), null);
  const { rowCount } = await h.sql("select 1 from auth.users where email = 'x1@demo-physio.test'");
  assert.equal(rowCount, 0, 'the transaction rolled back: no account left behind');
});

test('create-user: Edge Function validation errors, same codes and order', async () => {
  const admin = await physioAdmin();
  const base = { email: 'valid@demo-physio.test', password: 'Secret#123', name: 'Valid', role: 'therapist' };
  const cases = [
    [{ ...base, email: 'not-an-email' }, 'invalid_email'],
    [{ ...base, email: 'not-an-email', password: '1' }, 'invalid_email'],
    [{ ...base, password: '12345' }, 'weak_password'],
    [{ ...base, password: 'ب'.repeat(37) }, 'weak_password'], // 74 bytes > bcrypt's 72
    [{ ...base, role: 'staff' }, 'invalid_role'],
    [{ ...base, role: 'owner' }, 'invalid_role'],
    [{ ...base, name: '   ' }, 'missing_name'],
  ];
  for (const [body, error] of cases) {
    const res = await admin.post('/api/admin/create-user', body);
    assert.equal(res.status, 400, `${error}: ${res.text}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, error);
    assert.equal(typeof res.body.detail, 'string');
  }
  // role defaults to receptionist, like the Edge Function
  const dflt = await admin.post('/api/admin/create-user', { ...base, role: undefined });
  assert.equal(dflt.status, 200, dflt.text);
  assert.equal((await member(ORG.physio, base.email)).role, 'receptionist');
});

test('create-user: an existing member, another clinic\'s account or the Super Admin → 409 email_exists', async () => {
  const admin = await physioAdmin();
  for (const email of [USER.physioReception.email, USER.dentalAdmin.email, USER.superAdmin.email, USER.multi.email]) {
    const res = await admin.post('/api/admin/create-user', { email, password: 'Other#123', name: 'Dup', role: 'doctor' });
    assert.equal(res.status, 409, email);
    assert.equal(res.body.error, 'email_exists');
  }
  // passwords untouched
  await h.login(USER.dentalAdmin.email);
  await h.login(USER.superAdmin.email);
  assert.equal((await member(ORG.physio, USER.dentalAdmin.email)), null);
});

test('create-user: a former member of this clinic only is re-linked (password set, membership re-activated)', async () => {
  const admin = await physioAdmin();
  const res = await admin.post('/api/admin/create-user', {
    email: USER.former.email, password: 'Back#2026', name: 'Former again', role: 'doctor', branch_ids: [BRANCH.physio2],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.uid, USER.former.id);
  assert.equal(res.body.linked, true);
  const m = await member(ORG.physio, USER.former.email);
  assert.equal(m.status, 'active');
  assert.equal(m.role, 'doctor');
  assert.deepEqual(m.branches, [BRANCH.physio2]);
  await h.login(USER.former.email, { password: 'Back#2026' });
  const old = await h.client().post('/api/auth/login', { email: USER.former.email, password: PASSWORD });
  assert.equal(old.status, 401);
  const staff = await staffRow(ORG.physio, 'auth_uid = $2', [USER.former.id]);
  assert.equal(staff.role, 'doctor');
});

test('create-user: plan user limit → 422 plan_limit_users; pending invitations hold seats; nothing is written', async () => {
  const { rows: [{ n }] } = await h.sql("select count(*)::int as n from organization_members where organization_id = $1 and status = 'active'", [ORG.physio]);
  const admin = await physioAdmin();
  await withPlan(ORG.physio, { max_users: n }, async () => {
    const res = await admin.post('/api/admin/create-user', { email: 'over@demo-physio.test', password: 'Secret#123', name: 'Over', role: 'doctor' });
    assert.equal(res.status, 422, res.text);
    assert.deepEqual(res.body, { ok: false, error: 'plan_limit_users', detail: 'plan_limit:users' });
    const { rowCount } = await h.sql("select 1 from auth.users where email = 'over@demo-physio.test'");
    assert.equal(rowCount, 0);
  });
  await withPlan(ORG.physio, { max_users: n + 1 }, async () => {
    await h.sql(
      `insert into invitations (organization_id, email, token_hash, role, invited_by)
       values ($1, 'seat@demo-physio.test', 'seat-hash', 'doctor', $2)`,
      [ORG.physio, USER.physioAdmin.id],
    );
    try {
      const res = await admin.post('/api/admin/create-user', { email: 'over2@demo-physio.test', password: 'Secret#123', name: 'Over', role: 'doctor' });
      assert.equal(res.status, 422, 'the pending invitation holds the last seat');
      // ... but the invited person can be created directly: their invitation is superseded.
      const same = await admin.post('/api/admin/create-user', { email: 'seat@demo-physio.test', password: 'Secret#123', name: 'Seat', role: 'doctor' });
      assert.equal(same.status, 200, same.text);
      const { rows: [inv] } = await h.sql("select status from invitations where token_hash = 'seat-hash'");
      assert.equal(inv.status, 'revoked');
    } finally {
      await h.sql("delete from invitations where token_hash = 'seat-hash'");
    }
  });
});

test('/api/admin: auth and role checks answer in the Edge Function shape', async () => {
  const body = { email: 'nope@demo-physio.test', password: 'Secret#123', name: 'Nope', role: 'doctor' };
  const anon = await h.client({ slug: 'demo-physio' }).post('/api/admin/create-user', body);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error, 'missing_token');
  const bad = await h.client({ slug: 'demo-physio', cookie: 'cs_session=garbage' }).post('/api/admin/set-status', { staff_id: 'x', active: false });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'invalid_token');
  for (const who of ['physioReception', 'physioDoctor', 'physioTherapist', 'physioStaff']) {
    const c = await h.as(who, { slug: 'demo-physio' });
    for (const p of ['/api/admin/create-user', '/api/admin/reset-password', '/api/admin/set-status']) {
      const res = await c.post(p, { ...body, staff_id: 'ST-PHY-DOCTOR', active: false });
      assert.equal(res.status, 403, `${who} ${p}`);
      assert.deepEqual(res.body, { ok: false, error: 'forbidden', detail: 'Clinic admin only' });
    }
  }
  const dentalAdmin = await h.as('dentalAdmin', { slug: 'demo-physio' });
  const other = await dentalAdmin.post('/api/admin/set-status', { staff_id: 'ST-PHY-DOCTOR', active: false });
  assert.equal(other.status, 403);
  assert.equal(other.body.error, 'not_a_member');
  const noOrg = await h.as('physioAdmin');
  const none = await noOrg.post('/api/admin/set-status', { staff_id: 'ST-PHY-DOCTOR', active: false });
  assert.equal(none.status, 403);
  assert.equal(none.body.error, 'org_required');
  assert.equal((await audits('staff.deactivate')).length, 0);
});

// ── reset-password ───────────────────────────────────────────────────────

test('reset-password: sets the password, ends the target\'s sessions, audited', async () => {
  const target = await h.login(USER.physioDoctor.email);
  const admin = await physioAdmin();
  const res = await admin.post('/api/admin/reset-password', { staff_id: 'ST-PHY-DOCTOR', password: 'Reset#2026' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { ok: true, staff_id: 'ST-PHY-DOCTOR' });
  const stale = await h.client({ cookie: target.cookie }).get('/api/auth/session');
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, 'session_revoked');
  await h.login(USER.physioDoctor.email, { password: 'Reset#2026' });
  const [a] = await audits('staff.password_reset');
  assert.equal(a.row_pk, 'ST-PHY-DOCTOR');
  assert.equal(a.payload.staff_email, USER.physioDoctor.email);
  assert.ok(!JSON.stringify(a.payload).includes('Reset#2026'), 'the password is never logged');
  // by auth_uid too
  const byUid = await admin.post('/api/admin/reset-password', { auth_uid: USER.physioDoctor.id, password: PASSWORD });
  assert.equal(byUid.status, 200, byUid.text);
  await h.login(USER.physioDoctor.email);
});

test('reset-password: own password keeps the caller signed in', async () => {
  const { cookie } = await h.login(USER.changer.email);
  await h.asSystem(
    `insert into staff (staff_id, organization_id, name, role, email, auth_uid, status)
     values ('ST-CHANGER', $1, 'Changer', 'admin', $2, $3, 'active')`,
    [ORG.physio, USER.changer.email, USER.changer.id],
  );
  const c = h.client({ cookie, slug: 'demo-physio' });
  const res = await c.post('/api/admin/reset-password', { staff_id: 'ST-CHANGER', password: 'Mine#2026' });
  assert.equal(res.status, 200, res.text);
  const fresh = res.headers['set-cookie'].find((l) => l.startsWith('cs_session='));
  assert.ok(fresh, 'cookie re-issued');
  const still = await h.client({ cookie: fresh.split(';')[0] }).get('/api/auth/session');
  assert.equal(still.status, 200);
  assert.equal((await h.client({ cookie }).get('/api/auth/session')).status, 401, 'the old cookie ended');
});

test('reset-password: refused for other clinics, shared accounts, forged auth_uid, rows without account', async () => {
  const admin = await physioAdmin();
  const cases = [
    [{ staff_id: 'ST-DEN-ADMIN', password: 'Hack#2026' }, 404, 'staff_not_found'],
    [{ auth_uid: USER.dentalAdmin.id, password: 'Hack#2026' }, 404, 'staff_not_found'],
    [{ password: 'Hack#2026' }, 400, 'missing_target'],
    [{ staff_id: 'ST-PHY-DOCTOR', password: '123' }, 400, 'weak_password'],
  ];
  const check = async () => {
    for (const [body, status, error] of cases.splice(0)) {
      const res = await admin.post('/api/admin/reset-password', body);
      assert.equal(res.status, status, `${error}: ${res.text}`);
      assert.equal(res.body.error, error);
    }
  };
  await check();
  // A staff row is admin-editable data: pointing auth_uid at another clinic's
  // account must not let this admin set that account's password.
  await admin.data({
    table: 'staff', action: 'insert',
    values: { staff_id: 'ST-FORGED', name: 'Forged', role: 'doctor', email: 'forged@demo-physio.test', auth_uid: USER.dentalAdmin.id },
  });
  cases.push([{ staff_id: 'ST-FORGED', password: 'Hack#2026' }, 400, 'no_auth_account']);
  cases.push([{ auth_uid: USER.dentalAdmin.id, password: 'Hack#2026' }, 400, 'no_auth_account']);
  await admin.data({ table: 'staff', action: 'insert', values: { staff_id: 'ST-NOACCOUNT', name: 'Roster only', role: 'therapist' } });
  cases.push([{ staff_id: 'ST-NOACCOUNT', password: 'Hack#2026' }, 400, 'no_auth_account']);
  // multi@ works in both demo clinics: only its owner may change its password.
  await admin.data({
    table: 'staff', action: 'insert',
    values: { staff_id: 'ST-MULTI', name: 'Two clinics', role: 'therapist', email: USER.multi.email, auth_uid: USER.multi.id },
  });
  cases.push([{ staff_id: 'ST-MULTI', password: 'Hack#2026' }, 403, 'shared_account']);
  await check();
  await h.login(USER.dentalAdmin.email);
  await h.login(USER.multi.email);
});

// ── set-status ───────────────────────────────────────────────────────────

test('set-status: deactivate disables the membership + staff row and ends sessions; activate restores', async () => {
  const target = await h.login(USER.physioReception2.email);
  const tc = h.client({ cookie: target.cookie, slug: 'demo-physio' });
  assert.equal((await tc.data({ table: 'patients', action: 'select', columns: 'patient_id' })).status, 200);

  const admin = await physioAdmin();
  const off = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-RECEPTIONIST2', active: false, status: 'inactive' });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body, { ok: true, staff_id: 'ST-PHY-RECEPTIONIST2', status: 'inactive' });
  assert.equal((await member(ORG.physio, USER.physioReception2.email)).status, 'disabled');
  assert.equal((await staffRow(ORG.physio, 'staff_id = $2', ['ST-PHY-RECEPTIONIST2'])).status, 'inactive');
  assert.equal((await tc.get('/api/auth/session')).status, 401, 'open session ended');

  // The account itself stays active (it is not the clinic's to lock): it signs
  // in, but has no clinic and no data.
  const { rows: [acc] } = await h.sql('select status from auth.users where id = $1', [USER.physioReception2.id]);
  assert.equal(acc.status, 'active');
  const again = await h.login(USER.physioReception2.email);
  assert.deepEqual(again.res.body.memberships, []);
  const denied = await h.client({ cookie: again.cookie, slug: 'demo-physio' }).data({ table: 'patients', action: 'select' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'not_a_member');

  const on = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-RECEPTIONIST2', status: 'active' });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.status, 'active');
  assert.equal((await member(ORG.physio, USER.physioReception2.email)).status, 'active');
  const ok = await h.client({ cookie: again.cookie, slug: 'demo-physio' }).data({ table: 'patients', action: 'select', columns: 'patient_id' });
  assert.equal(ok.status, 200, 'activation does not end sessions');

  const [d] = await audits('staff.deactivate');
  assert.equal(d.row_pk, 'ST-PHY-RECEPTIONIST2');
  assert.equal(d.payload.prev_status, 'active');
  assert.equal(d.payload.new_status, 'inactive');
  assert.equal(d.payload.sessions_ended, true);
  assert.equal((await audits('staff.activate')).length, 1);
});

test('set-status: guards (self, missing target, unknown staff, no status) and the plan limit on re-activation', async () => {
  const admin = await physioAdmin();
  const self = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-ADMIN', active: false });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'cannot_deactivate_self');
  const missing = await admin.post('/api/admin/set-status', { active: false });
  assert.equal(missing.body.error, 'missing_target');
  const foreign = await admin.post('/api/admin/set-status', { staff_id: 'ST-DEN-RECEPTIONIST', active: false });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, 'staff_not_found');
  const noStatus = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST' });
  assert.equal(noStatus.status, 400);
  assert.equal(noStatus.body.error, 'invalid_status');
  assert.equal((await member(ORG.physio, USER.physioTherapist.email)).status, 'active', 'nothing changed');
  const { rows: [den] } = await h.sql("select status from organization_members where organization_id = $1 and user_id = $2", [ORG.dental, USER.dentalReception.id]);
  assert.equal(den.status, 'active');

  // Re-activation needs a free seat.
  const off = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST', active: false });
  assert.equal(off.status, 200);
  const { rows: [{ n }] } = await h.sql("select count(*)::int as n from organization_members where organization_id = $1 and status = 'active'", [ORG.physio]);
  await withPlan(ORG.physio, { max_users: n }, async () => {
    const on = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST', active: true });
    assert.equal(on.status, 422, on.text);
    assert.equal(on.body.error, 'plan_limit_users');
    assert.equal((await member(ORG.physio, USER.physioTherapist.email)).status, 'disabled');
    assert.equal((await staffRow(ORG.physio, 'staff_id = $2', ['ST-PHY-THERAPIST'])).status, 'inactive', 'rolled back');
  });
  const on = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST', active: true });
  assert.equal(on.status, 200);
});
