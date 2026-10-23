'use strict';
// /api/org/members, /api/org/members/:id and /api/org/usage (the clinic
// admin's C06 / C07 screens), plus the branch rules the C07 screen relies
// on (0005: deactivate, never delete), against the real schema + seed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG, BRANCH } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

const physioAdmin = () => h.as('physioAdmin', { slug: 'demo-physio' });

async function memberRow(orgId, email) {
  const { rows } = await h.sql(
    `select m.id, m.role, m.status,
            coalesce((select array_agg(mb.branch_id order by mb.branch_id) from member_branches mb where mb.member_id = m.id), '{}') as branches
       from organization_members m join auth.users u on u.id = m.user_id
      where m.organization_id = $1 and lower(u.email) = lower($2)`,
    [orgId, email],
  );
  return rows[0] || null;
}

async function withPlan(orgId, limits, fn) {
  const { rows: [plan] } = await h.sql(
    `insert into subscription_plans (code, name, max_users, max_branches) values ($1, 'org test plan', $2, $3) returning id`,
    [`org-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, limits.max_users ?? null, limits.max_branches ?? null],
  );
  const { rows: [org] } = await h.sql('select plan_id from organizations where id = $1', [orgId]);
  await h.sql('update organizations set plan_id = $2 where id = $1', [orgId, plan.id]);
  try {
    await fn(plan);
  } finally {
    await h.sql('update organizations set plan_id = $2 where id = $1', [orgId, org.plan_id]);
  }
}

const audits = async (action, orgId = ORG.physio) =>
  (await h.asSystem('select * from audit_events where action = $1 and organization_id = $2 order by id', [action, orgId])).rows;

// ── GET /api/org/members ─────────────────────────────────────────────────
test('members: the clinic admin lists this clinic\'s members with role, status, branches and staff row', async () => {
  const admin = await physioAdmin();
  const res = await admin.get('/api/org/members');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  const list = res.body;
  const byEmail = Object.fromEntries(list.map((m) => [m.email, m]));
  const { rows: [{ n }] } = await h.sql('select count(*)::int as n from organization_members where organization_id = $1', [ORG.physio]);
  assert.equal(list.length, n, 'every membership of the clinic');
  assert.ok(!list.some((m) => /demo-dental/.test(m.email)), 'no other clinic');

  const me = byEmail[USER.physioAdmin.email];
  assert.deepEqual(
    { role: me.role, status: me.status, branch_ids: me.branch_ids, staff_id: me.staff_id, is_self: me.is_self, name: me.name },
    { role: 'admin', status: 'active', branch_ids: [], staff_id: 'ST-PHY-ADMIN', is_self: true, name: 'مدير العيادة — PHY' },
  );
  assert.deepEqual(byEmail[USER.physioReception2.email].branch_ids, [BRANCH.physio1, BRANCH.physio2]);
  assert.equal(byEmail[USER.physioReception2.email].is_self, false);
  assert.equal(byEmail[USER.physioReception.email].staff_id, 'ST-PHY-RECEPTIONIST');
  assert.equal(byEmail[USER.physioReception.email].staff_status, 'active');
  assert.equal(byEmail[USER.physioStaff.email].role, 'staff');
  assert.equal(byEmail[USER.former.email].status, 'disabled');
  // Active members first.
  const firstDisabled = list.findIndex((m) => m.status !== 'active');
  assert.ok(firstDisabled > 0 && list.slice(firstDisabled).every((m) => m.status !== 'active'));
  for (const m of list) {
    assert.deepEqual(Object.keys(m).sort(), ['branch_ids', 'created_at', 'email', 'id', 'is_self', 'joined_at', 'name',
      'phone', 'role', 'staff_id', 'staff_status', 'status', 'user_id']);
  }
  assert.ok(!res.text.includes('encrypted_password') && !res.text.includes('session_version'));
});

test('members / usage: other roles → 403 forbidden, no session → 401, no clinic → 403', async () => {
  for (const key of ['physioReception', 'physioDoctor', 'physioTherapist']) {
    const c = await h.as(key, { slug: 'demo-physio' });
    for (const path of ['/api/org/members', '/api/org/usage']) {
      const r = await c.get(path);
      assert.equal(r.status, 403, `${key} ${path}`);
      assert.equal(r.body.error.code, 'forbidden');
    }
    const p = await c.patch('/api/org/members/de000000-0000-4000-8000-0000000b0012', { role: 'doctor' });
    assert.equal(p.status, 403);
  }
  assert.equal((await h.client({ slug: 'demo-physio' }).get('/api/org/members')).status, 401);
  const noOrg = await h.as('physioAdmin');
  assert.equal((await noOrg.get('/api/org/usage')).status, 403);
  // The physio admin on the dental clinic: not a member.
  const cross = await h.as('physioAdmin', { slug: 'demo-dental' });
  const r = await cross.get('/api/org/members');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'not_a_member');
});

// ── GET /api/org/usage ───────────────────────────────────────────────────
test('usage: plan limits (null = none), seats = active members + pending invitations, active branches, staff per branch', async () => {
  const admin = await physioAdmin();
  const res = await admin.get('/api/org/usage');
  assert.equal(res.status, 200, res.text);
  const { rows: [plan] } = await h.sql(
    'select p.code, p.max_users, p.max_branches from organizations o join subscription_plans p on p.id = o.plan_id where o.id = $1', [ORG.physio]);
  assert.equal(res.body.plan.code, plan.code);
  assert.equal(res.body.users.max, null);
  assert.equal(res.body.branches.max, null);
  const { rows: [counts] } = await h.sql(
    `select (select count(*) from organization_members where organization_id = $1 and status = 'active')::int as active,
            (select count(*) from invitations where organization_id = $1 and status = 'pending' and expires_at > now())::int as pending`,
    [ORG.physio]);
  assert.deepEqual(res.body.users, { active: counts.active, pending_invitations: counts.pending, used: counts.active + counts.pending, max: null });
  assert.deepEqual(res.body.branches, { active: 2, inactive: 0, total: 2, max: null });
  // Staff per branch: active members with a member_branches row (the
  // disabled former@ member of branch 1 is not counted).
  const { rows } = await h.sql(
    `select mb.branch_id, count(*)::int as n from member_branches mb join organization_members m on m.id = mb.member_id
      where mb.organization_id = $1 and m.status = 'active' group by mb.branch_id`, [ORG.physio]);
  assert.deepEqual(res.body.branch_staff, Object.fromEntries(rows.map((r) => [r.branch_id, r.n])));
  assert.ok(res.body.branch_staff[BRANCH.physio2] >= 1);

  await withPlan(ORG.physio, { max_users: 40, max_branches: 3 }, async () => {
    const inv = await admin.post('/api/org/invitations', { email: 'usage.count@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    assert.equal(inv.status, 201, inv.text);
    const u = (await admin.get('/api/org/usage')).body;
    assert.equal(u.plan.max_users, 40);
    assert.equal(u.plan.max_branches, 3);
    assert.deepEqual(u.users, { active: counts.active, pending_invitations: counts.pending + 1, used: counts.active + counts.pending + 1, max: 40 });
    assert.equal(u.branches.max, 3);
    assert.equal((await admin.del(`/api/org/invitations/${inv.body.invitation.id}`)).status, 204);
    assert.equal((await admin.get('/api/org/usage')).body.users.pending_invitations, counts.pending);
  });
});

// ── Branches through /api/data (C07) ─────────────────────────────────────
test('branches: the admin adds, edits, deactivates and re-activates (plan limit 422); a DELETE removes nothing (0005)', async () => {
  const admin = await physioAdmin();
  const id = `br-orgtest-${Date.now().toString(36)}`;
  const add = await admin.data({
    table: 'branches', action: 'insert',
    values: { id, name: 'فرع الاختبار', address: 'الجيزة', phone: '0230000000', rooms: 3, working_hours: { sat: ['09:00', '17:00'] } },
    returning: true,
  });
  assert.equal(add.status, 200, add.text);
  const dup = await admin.data({ table: 'branches', action: 'insert', values: { id: `${id}-dup`, name: 'فرع الاختبار' } });
  assert.equal(dup.status, 409, 'the name is unique per clinic');
  assert.equal(dup.body.error.code, '23505');

  const off = await admin.data({ table: 'branches', action: 'update', values: { status: 'inactive' }, filters: [{ column: 'id', op: 'eq', value: id }] });
  assert.equal(off.status, 200, off.text);
  let u = (await admin.get('/api/org/usage')).body;
  assert.deepEqual([u.branches.active, u.branches.inactive], [2, 1]);

  const del = await admin.data({ table: 'branches', action: 'delete', filters: [{ column: 'id', op: 'eq', value: id }], count: 'exact' });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.body.count, 0, 'nothing deleted');
  const { rows } = await h.asSystem('select status from branches where id = $1', [id]);
  assert.deepEqual(rows, [{ status: 'inactive' }]);

  await withPlan(ORG.physio, { max_branches: 2 }, async () => {
    const back = await admin.data({ table: 'branches', action: 'update', values: { status: 'active' }, filters: [{ column: 'id', op: 'eq', value: id }] });
    assert.equal(back.status, 422, back.text);
    assert.deepEqual(back.body.error, { message: 'plan_limit:branches', code: 'PL422' });
  });
  const back = await admin.data({ table: 'branches', action: 'update', values: { status: 'active' }, filters: [{ column: 'id', op: 'eq', value: id }] });
  assert.equal(back.status, 200, back.text);
  u = (await admin.get('/api/org/usage')).body;
  assert.deepEqual([u.branches.active, u.branches.inactive], [3, 0]);

  // A receptionist cannot change a branch.
  const rec = await h.as('physioReception', { slug: 'demo-physio' });
  const r = await rec.data({ table: 'branches', action: 'update', values: { status: 'inactive' }, filters: [{ column: 'id', op: 'eq', value: id }], count: 'exact' });
  assert.equal(r.body.count, 0);
  await h.asSystem("update branches set status = 'inactive' where id = $1", [id]);
});

// ── PATCH /api/org/members/:id ───────────────────────────────────────────
test('patch member: role + branches; the staff row follows, the member\'s sessions end, audited', async () => {
  const admin = await physioAdmin();
  const target = await memberRow(ORG.physio, USER.resetter.email); // receptionist, branch 1
  // test/fixtures/extras.sql gives this member no staff row: link one.
  await h.asSystem(
    `insert into staff (staff_id, organization_id, name, email, role, auth_uid, status)
     values ('U-ORGTEST-RESET', $1, 'موظف الاختبار', $2, 'receptionist', $3, 'active')`,
    [ORG.physio, USER.resetter.email, USER.resetter.id]);
  const { cookie } = await h.login(USER.resetter.email);
  const before = h.client({ cookie, slug: 'demo-physio' });
  assert.equal((await before.get('/api/orgs/current')).status, 200);

  const res = await admin.patch(`/api/org/members/${target.id}`, { role: 'doctor', branch_ids: [BRANCH.physio2] });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.id, target.id);
  assert.equal(res.body.role, 'doctor');
  assert.deepEqual(res.body.branch_ids, [BRANCH.physio2]);
  const m = await memberRow(ORG.physio, USER.resetter.email);
  assert.deepEqual([m.role, m.branches], ['doctor', [BRANCH.physio2]]);
  const { rows: [staff] } = await h.asSystem('select role from staff where organization_id = $1 and auth_uid = $2', [ORG.physio, USER.resetter.id]);
  assert.equal(staff.role, 'doctor');
  assert.equal((await before.get('/api/orgs/current')).status, 401, 'a role change ends the open sessions');
  const [a] = (await audits('member.update')).filter((r) => r.row_pk === target.id && r.result === 'success');
  assert.equal(a.actor_uid, USER.physioAdmin.id);
  assert.deepEqual(
    { prev: a.payload.prev_role, next: a.payload.new_role, pb: a.payload.prev_branch_ids, nb: a.payload.new_branch_ids },
    { prev: 'receptionist', next: 'doctor', pb: [BRANCH.physio1], nb: [BRANCH.physio2] },
  );

  // Branches only: kept role, sessions untouched.
  const { cookie: c2 } = await h.login(USER.resetter.email);
  const again = h.client({ cookie: c2, slug: 'demo-physio' });
  const br = await admin.patch(`/api/org/members/${target.id}`, { branch_ids: [BRANCH.physio1, BRANCH.physio2] });
  assert.equal(br.status, 200, br.text);
  assert.deepEqual(br.body.branch_ids, [BRANCH.physio1, BRANCH.physio2]);
  assert.equal(br.body.role, 'doctor');
  assert.equal((await again.get('/api/orgs/current')).status, 200);
  const cur = (await again.get('/api/orgs/current')).body;
  assert.deepEqual(cur.branches.map((b) => b.id).sort(), [BRANCH.physio1, BRANCH.physio2]);

  // To admin: no branch rows (every branch).
  const up = await admin.patch(`/api/org/members/${target.id}`, { role: 'admin' });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(up.body.branch_ids, []);
  // Back to receptionist without branches → a branch is required.
  const need = await admin.patch(`/api/org/members/${target.id}`, { role: 'receptionist' });
  assert.equal(need.status, 400);
  assert.equal(need.body.error.code, 'branch_required');
  const ok = await admin.patch(`/api/org/members/${target.id}`, { role: 'receptionist', branch_ids: [BRANCH.physio1] });
  assert.equal(ok.status, 200, ok.text);

  // The 'staff' role has a staff.role value since 0006.
  const st = await admin.patch(`/api/org/members/${target.id}`, { role: 'staff', branch_ids: [BRANCH.physio1] });
  assert.equal(st.status, 200, st.text);
  const { rows: [s2] } = await h.asSystem('select role from staff where organization_id = $1 and auth_uid = $2', [ORG.physio, USER.resetter.id]);
  assert.equal(s2.role, 'staff');
  assert.equal((await admin.patch(`/api/org/members/${target.id}`, { role: 'receptionist', branch_ids: [BRANCH.physio1] })).status, 200);
});

test('patch member: refusals (own role, unknown/other clinic member, bad branches, Super Admin role → denied audit)', async () => {
  const admin = await physioAdmin();
  const me = await memberRow(ORG.physio, USER.physioAdmin.email);
  const own = await admin.patch(`/api/org/members/${me.id}`, { role: 'receptionist', branch_ids: [BRANCH.physio1] });
  assert.equal(own.status, 400);
  assert.equal(own.body.error.code, 'cannot_change_own_role');
  assert.equal((await memberRow(ORG.physio, USER.physioAdmin.email)).role, 'admin');

  const target = await memberRow(ORG.physio, USER.legacy.email); // receptionist, branch 1
  for (const [body, code] of [
    [{}, 'invalid_request'],
    [{ branch_ids: [] }, 'branch_required'],
    [{ branch_ids: 'br-demo-physio-1' }, 'invalid_branch_ids'],
    [{ branch_ids: [BRANCH.dental1] }, 'invalid_branch'],
  ]) {
    const r = await admin.patch(`/api/org/members/${target.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, code, JSON.stringify(body));
  }
  // An inactive branch cannot be assigned.
  await h.asSystem("update branches set status = 'inactive' where id = $1", [BRANCH.physio2]);
  try {
    const r = await admin.patch(`/api/org/members/${target.id}`, { branch_ids: [BRANCH.physio2] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_branch');
  } finally {
    await h.asSystem("update branches set status = 'active' where id = $1", [BRANCH.physio2]);
  }

  for (const id of ['not-a-uuid', 'de000000-0000-4000-8000-0000000b0099']) {
    const r = await admin.patch(`/api/org/members/${id}`, { role: 'doctor' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'member_not_found');
  }
  const dentalMember = await memberRow(ORG.dental, USER.dentalReception.email);
  const cross = await admin.patch(`/api/org/members/${dentalMember.id}`, { role: 'doctor', branch_ids: [BRANCH.physio1] });
  assert.equal(cross.status, 404, 'another clinic\'s member does not exist here');
  assert.equal((await memberRow(ORG.dental, USER.dentalReception.email)).role, 'receptionist');

  // AT-09: a Super Admin (or any unknown) role is refused and recorded as denied.
  const before = (await audits('member.update')).length;
  for (const role of ['super_admin', 'platform_admin']) {
    const r = await admin.patch(`/api/org/members/${target.id}`, { role });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_role');
  }
  const rows = (await audits('member.update')).slice(before);
  assert.deepEqual(rows.map((r) => [r.result, r.payload.requested_role, r.actor_uid]),
    [['denied', 'super_admin', USER.physioAdmin.id], ['denied', 'platform_admin', USER.physioAdmin.id]]);
  assert.equal((await memberRow(ORG.physio, USER.legacy.email)).role, 'receptionist');
  const { rowCount } = await h.sql('select 1 from platform_admins where user_id = $1', [USER.legacy.id]);
  assert.equal(rowCount, 0);
});

test('members list follows set-status (deactivate / re-activate) and invitations accepted later', async () => {
  const admin = await physioAdmin();
  const off = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST', active: false });
  assert.equal(off.status, 200, off.text);
  let list = (await admin.get('/api/org/members')).body;
  let t = list.find((m) => m.email === USER.physioTherapist.email);
  assert.deepEqual([t.status, t.staff_status], ['disabled', 'inactive']);
  const on = await admin.post('/api/admin/set-status', { staff_id: 'ST-PHY-THERAPIST', active: true });
  assert.equal(on.status, 200, on.text);
  list = (await admin.get('/api/org/members')).body;
  t = list.find((m) => m.email === USER.physioTherapist.email);
  assert.deepEqual([t.status, t.staff_status], ['active', 'active']);
});
