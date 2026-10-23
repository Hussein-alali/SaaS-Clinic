// Plan limits (plan task 2.4; docs/05 "Data validation"): a branch, an
// activated membership or a pending invitation beyond the plan's
// max_branches / max_users raises SQLSTATE PL422 with the message
// 'plan_limit:branches' / 'plan_limit:users'. NULL limit = unlimited.
//
// Each test builds its own clinic inside a rolled-back transaction, so it
// never touches (or waits on) the seeded demo clinics.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

// A clinic on a plan with the given limits, with `members` active members
// (the first one is its admin). Returns ids.
async function makeClinic(c, { maxBranches = null, maxUsers = null, members = 1, branches = 0 } = {}) {
  const s = suffix();
  await setContext(c, { system: true });
  const { rows: [plan] } = await c.query(
    `insert into subscription_plans (code, name, max_branches, max_users) values ($1, 'test', $2, $3) returning id`,
    [`test-${s}`, maxBranches, maxUsers]);
  const { rows: [org] } = await c.query(`
    insert into organizations (name, slug, primary_specialty_id, status, plan_id, created_by)
    select 'Limits clinic', $1, s.id, 'active', $2, $3 from specialties s where s.code = 'physio'
    returning id`, [`limits-${s}`, plan.id, fx.superAdmin]);
  const users = [];
  for (let i = 0; i < members; i++) {
    users.push(await addMember(c, org.id, i === 0 ? 'admin' : 'receptionist', 'active'));
  }
  const branchIds = [];
  for (let i = 0; i < branches; i++) branchIds.push(await addBranch(c, org.id));
  return { s, planId: plan.id, orgId: org.id, adminId: users[0] && users[0].userId, users, branchIds };
}

async function addUser(c) {
  const { rows: [u] } = await c.query(`insert into auth.users (email) values ($1) returning id`,
    [`limits-${suffix()}@clinicsys.test`]);
  return u.id;
}

async function addMember(c, orgId, role, status) {
  const userId = await addUser(c);
  const { rows: [m] } = await c.query(
    `insert into organization_members (organization_id, user_id, role, status) values ($1, $2, $3, $4) returning id`,
    [orgId, userId, role, status]);
  return { userId, memberId: m.id };
}

async function addBranch(c, orgId, status = 'active') {
  const id = `br-limits-${suffix()}`;
  await c.query(`insert into branches (id, organization_id, name, status) values ($1, $2, $3, $4)`,
    [id, orgId, `فرع ${id}`, status]);
  return id;
}

async function invite(c, orgId, extra = '') {
  const { rows: [i] } = await c.query(
    `insert into invitations (organization_id, email, token_hash, role ${extra ? ', expires_at' : ''})
     values ($1, $2, $3, 'receptionist' ${extra ? `, ${extra}` : ''}) returning id`,
    [orgId, `invite-${suffix()}@clinicsys.test`, suffix() + suffix()]);
  return i.id;
}

test('branches: the clinic admin cannot add an active branch beyond max_branches (PL422 plan_limit:branches)', async () => {
  await inTx(async (c) => {
    const k = await makeClinic(c, { maxBranches: 2 });
    // As the clinic admin through RLS (what /api/data does for Settings).
    await setContext(c, { user: k.adminId, org: k.orgId });
    await c.query(`insert into branches (id, name) values ($1, 'الفرع الرئيسي')`, [`br-a-${k.s}`]);
    await c.query(`insert into branches (id, name) values ($1, 'فرع 2')`, [`br-b-${k.s}`]);
    const err = await expectError(c, `insert into branches (id, name) values ($1, 'فرع 3')`, [`br-c-${k.s}`]);
    assert.equal(err.code, 'PL422');
    assert.equal(err.message, 'plan_limit:branches');
    assert.match(err.detail, /allows 2 active branch/);

    // Inactive branches do not count; re-activating one is checked.
    await c.query(`insert into branches (id, name, status) values ($1, 'فرع مغلق', 'inactive')`, [`br-d-${k.s}`]);
    await c.query(`update branches set status = 'inactive' where id = $1`, [`br-b-${k.s}`]);
    await c.query(`insert into branches (id, name) values ($1, 'فرع 3')`, [`br-c-${k.s}`]);
    const re = await expectError(c, `update branches set status = 'active' where id = $1`, [`br-b-${k.s}`]);
    assert.deepEqual([re.code, re.message], ['PL422', 'plan_limit:branches']);
    // Editing an active branch is not a new branch.
    await c.query(`update branches set name = 'الفرع الرئيسي (معدل)' where id = $1`, [`br-a-${k.s}`]);

    // The system context (Super Admin routes) is bound by the same limit.
    await setContext(c, { system: true });
    const sys = await expectError(c, `insert into branches (id, organization_id, name) values ($1, $2, 'x')`,
      [`br-e-${k.s}`, k.orgId]);
    assert.equal(sys.code, 'PL422');

    // Raising the limit (or NULL = unlimited) lets it through.
    await c.query(`update subscription_plans set max_branches = null where id = $1`, [k.planId]);
    for (let i = 0; i < 5; i++) await addBranch(c, k.orgId);
  });
});

test('users: activating a membership beyond max_users raises PL422 plan_limit:users', async () => {
  await inTx(async (c) => {
    const k = await makeClinic(c, { maxUsers: 3, members: 3 });
    const err = await expectError(c,
      `insert into organization_members (organization_id, user_id, role, status) values ($1, $2, 'doctor', 'active')`,
      [k.orgId, await addUser(c)]);
    assert.deepEqual([err.code, err.message], ['PL422', 'plan_limit:users']);
    assert.match(err.detail, /allows 3 user/);

    // Invited / disabled memberships do not count; activating one is checked.
    const invited = await addMember(c, k.orgId, 'doctor', 'invited');
    const act = await expectError(c, `update organization_members set status = 'active' where id = $1`, [invited.memberId]);
    assert.equal(act.code, 'PL422');
    await c.query(`update organization_members set status = 'disabled' where id = $1`, [k.users[2].memberId]);
    await c.query(`update organization_members set status = 'active' where id = $1`, [invited.memberId]);
    // Changing the role of an active member is not a new user.
    await c.query(`update organization_members set role = 'therapist' where id = $1`, [invited.memberId]);
    const back = await expectError(c, `update organization_members set status = 'active' where id = $1`, [k.users[2].memberId]);
    assert.equal(back.code, 'PL422');

    // Other clinics are not counted.
    const other = await makeClinic(c, { maxUsers: 1, members: 1 });
    await addMember(c, other.orgId, 'doctor', 'disabled');
    await c.query(`update subscription_plans set max_users = 3 where id = $1`, [other.planId]);
    await addMember(c, other.orgId, 'doctor', 'active');
  });
});

test('users: a pending invitation reserves a seat (PL422 when the plan is full); accepting it is allowed', async () => {
  await inTx(async (c) => {
    const k = await makeClinic(c, { maxUsers: 3, members: 2 });
    const first = await invite(c, k.orgId); // 2 active + 1 pending = 3
    const full = await expectError(c,
      `insert into invitations (organization_id, email, token_hash, role) values ($1, 'x@clinicsys.test', $2, 'doctor')`,
      [k.orgId, suffix()]);
    assert.deepEqual([full.code, full.message], ['PL422', 'plan_limit:users']);
    assert.match(full.detail, /active members: 2, pending invitations: 1/);

    // Expired and revoked invitations do not count.
    await invite(c, k.orgId, `now() - interval '1 day'`);
    await c.query(`update invitations set status = 'revoked' where id = $1`, [first]);
    const second = await invite(c, k.orgId);
    // Re-opening the revoked one is a new reservation.
    const reopen = await expectError(c, `update invitations set status = 'pending' where id = $1`, [first]);
    assert.equal(reopen.code, 'PL422');

    // Accepting `second`: the membership becomes active while the invitation
    // is still pending (API order) — its seat is not counted twice.
    const accepted = await addMember(c, k.orgId, 'receptionist', 'active');
    await c.query(`update invitations set status = 'accepted' where id = $1`, [second]);
    assert.ok(accepted.memberId);
    const { rows: [n] } = await c.query(
      `select count(*)::int as n from organization_members where organization_id = $1 and status = 'active'`, [k.orgId]);
    assert.equal(n.n, 3);
    // Now full: neither a new invitation nor a new member.
    assert.equal((await expectError(c,
      `insert into invitations (organization_id, email, token_hash, role) values ($1, 'y@clinicsys.test', $2, 'doctor')`,
      [k.orgId, suffix()])).code, 'PL422');
  });
});

test('NULL limits (the default plan) and a clinic without a plan are unlimited', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    const { rows: [p] } = await c.query(
      `select max_branches, max_users, max_storage_mb from subscription_plans where code = 'default'`);
    assert.deepEqual(p, { max_branches: null, max_users: null, max_storage_mb: null });

    const k = await makeClinic(c, { members: 1 });
    await c.query(`update organizations set plan_id = (select id from subscription_plans where code = 'default') where id = $1`, [k.orgId]);
    for (let i = 0; i < 6; i++) await addBranch(c, k.orgId);
    for (let i = 0; i < 6; i++) await addMember(c, k.orgId, 'doctor', 'active');
    for (let i = 0; i < 6; i++) await invite(c, k.orgId);

    await c.query(`update organizations set plan_id = null where id = $1`, [k.orgId]);
    await addBranch(c, k.orgId);
    await addMember(c, k.orgId, 'doctor', 'active');
    await invite(c, k.orgId);

    // The seeded clinics are on the default plan.
    const { rows } = await c.query(`
      select o.slug, p.code from organizations o join subscription_plans p on p.id = o.plan_id
       where o.slug in ('demo-physio', 'demo-dental') order by 1`);
    assert.deepEqual(rows, [{ slug: 'demo-dental', code: 'default' }, { slug: 'demo-physio', code: 'default' }]);
  });
});
