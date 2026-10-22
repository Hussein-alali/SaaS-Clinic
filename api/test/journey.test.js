'use strict';
// J1 + J2 end to end through the API only (docs/03-App-Flow.md "J1 — Super
// Admin ينشئ عيادة", "J2 — أول دخول لمدير العيادة", "مدير العيادة يدعو موظفًا"):
// Super Admin creates a clinic → invitation e-mail in the outbox → the first
// admin accepts (signed in, clinic active) → the admin adds a branch and
// invites a receptionist for one branch → the receptionist accepts and reads
// only that branch's rows. Plan limits (branches, users) and suspension are
// checked on the way.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, sessionCookie } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

const SLUG = 'apitest-j1';
const OWNER = 'owner@apitest-j1.test';
const RECEPTION = 'reception@apitest-j1.test';

function inviteToken(email) {
  const mails = h.outbox().filter((m) => m.to === email);
  assert.equal(mails.length, 1, `one e-mail to ${email}`);
  const link = /(http:\/\/[^\s]+)/.exec(mails[0].text)[1];
  const url = new URL(link);
  assert.equal(url.hostname, `${SLUG}.localhost`);
  assert.equal(url.port, String(h.port));
  assert.equal(url.searchParams.get('org'), SLUG);
  return url.searchParams.get('invite');
}

test('J1/J2: Super Admin creates a clinic → first admin accepts → admin invites a receptionist → branch-scoped access', async () => {
  // ── Super Admin (platform context) ────────────────────────────────────
  const sa = await h.as('superAdmin', { platform: true });
  const plan = await sa.post('/api/platform/plans', { code: 'j1-plan', name: 'J1', max_users: 2, max_branches: 2 });
  assert.equal(plan.status, 201, plan.text);
  assert.deepEqual((await sa.get(`/api/platform/slug-available?slug=${SLUG}`)).body, { available: true, reason: null });
  const created = await sa.post('/api/platform/organizations', {
    name: 'عيادة الرحلة الأولى', slug: SLUG, specialty_code: 'physio', plan_id: plan.body.id, admin_email: OWNER,
  });
  assert.equal(created.status, 201, created.text);
  const orgId = created.body.organization.id;
  const mainBranch = created.body.branches[0].id;
  assert.equal(created.body.organization.status, 'pending_activation');
  assert.deepEqual((await sa.get(`/api/platform/slug-available?slug=${SLUG}`)).body, { available: false, reason: 'taken' });
  assert.equal((await h.client().get(`/api/orgs/resolve?slug=${SLUG}`)).body.status, 'pending_activation');

  // ── J2: the invitation e-mail → accept → signed in, clinic active ─────
  const ownerToken = inviteToken(OWNER);
  const view = await h.client().get(`/api/invitations/${ownerToken}`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.organization, { name: 'عيادة الرحلة الأولى', slug: SLUG });
  assert.equal(view.body.role, 'admin');
  const accepted = await h.client().post(`/api/invitations/${ownerToken}/accept`, { password: 'Owner#2026', name: 'مدير الرحلة' });
  assert.equal(accepted.status, 200, accepted.text);
  const ownerCookie = sessionCookie(accepted);
  assert.ok(ownerCookie);
  assert.deepEqual(accepted.body.memberships.map((m) => [m.slug, m.role, m.status]), [[SLUG, 'admin', 'active']]);
  assert.equal(accepted.body.organization.status, 'active');
  assert.equal((await h.client().get(`/api/orgs/resolve?slug=${SLUG}`)).body.status, 'active');
  // The login screen works too.
  await h.login(OWNER, { password: 'Owner#2026' });

  const admin = h.client({ cookie: ownerCookie, slug: SLUG });
  const current = await admin.get('/api/orgs/current');
  assert.equal(current.status, 200, current.text);
  assert.equal(current.body.role, 'admin');
  assert.deepEqual(current.body.branches.map((b) => b.id), [mainBranch]);
  const settings = await admin.data({ table: 'clinic_settings', action: 'select', single: 'single' });
  assert.equal(settings.body.data.name, 'عيادة الرحلة الأولى');
  const staff = await admin.data({ table: 'staff', action: 'select', columns: 'email,role,status' });
  assert.deepEqual(staff.body.data, [{ email: OWNER, role: 'admin', status: 'active' }]);

  // ── branches: the plan allows 2 ───────────────────────────────────────
  const second = await admin.data({ table: 'branches', action: 'insert', values: { id: 'br_apitest_j1_2', name: 'فرع ثانٍ' } });
  assert.equal(second.status, 200, second.text);
  const third = await admin.data({ table: 'branches', action: 'insert', values: { id: 'br_apitest_j1_3', name: 'فرع ثالث' } });
  assert.equal(third.status, 422);
  assert.deepEqual(third.body.error, { message: 'plan_limit:branches', code: 'PL422' });

  // Rows in both branches.
  assert.equal((await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-APITEST-J1', name: 'مريض الرحلة' } })).status, 200);
  for (const [id, branch] of [['BK-APITEST-J1-MAIN', mainBranch], ['BK-APITEST-J1-SECOND', 'br_apitest_j1_2']]) {
    const r = await admin.data({
      table: 'bookings', action: 'insert',
      values: { booking_id: id, patient_id: 'P-APITEST-J1', date: '2026-10-25', time: '10:00', status: 'confirmed', branch_id: branch },
    });
    assert.equal(r.status, 200, r.text);
  }

  // ── the admin invites a receptionist for the main branch ──────────────
  const invite = await admin.post('/api/org/invitations', { email: RECEPTION, role: 'receptionist', branch_ids: [mainBranch] });
  assert.equal(invite.status, 201, invite.text);
  // users: 1 active + 1 pending invitation = the plan's 2
  const overInvite = await admin.post('/api/org/invitations', { email: 'third@apitest-j1.test', role: 'doctor', branch_ids: [mainBranch] });
  assert.equal(overInvite.status, 422);
  assert.deepEqual(overInvite.body.error, { message: 'plan_limit:users', code: 'PL422' });
  const overCreate = await admin.post('/api/admin/create-user', { email: 'third@apitest-j1.test', password: 'Third#2026', name: 'Third', role: 'doctor' });
  assert.equal(overCreate.status, 422);
  assert.equal(overCreate.body.error, 'plan_limit_users');

  const recToken = inviteToken(RECEPTION);
  const recAccepted = await h.client().post(`/api/invitations/${recToken}/accept`, { password: 'Reception#2026', name: 'استقبال الرحلة' });
  assert.equal(recAccepted.status, 200, recAccepted.text);
  assert.deepEqual(recAccepted.body.memberships.map((m) => [m.slug, m.role]), [[SLUG, 'receptionist']]);
  const rec = h.client({ cookie: sessionCookie(recAccepted), slug: SLUG });

  // ── the receptionist sees only the allowed branch ─────────────────────
  const recCurrent = await rec.get('/api/orgs/current');
  assert.equal(recCurrent.body.role, 'receptionist');
  assert.deepEqual(recCurrent.body.branches.map((b) => b.id), [mainBranch]);
  const bookings = await rec.data({ table: 'bookings', action: 'select', columns: 'booking_id,branch_id', count: 'exact' });
  assert.equal(bookings.status, 200, bookings.text);
  assert.deepEqual(bookings.body.data, [{ booking_id: 'BK-APITEST-J1-MAIN', branch_id: mainBranch }]);
  const asked = await h.client({ cookie: sessionCookie(recAccepted), slug: SLUG, branch: 'br_apitest_j1_2' })
    .data({ table: 'bookings', action: 'select', columns: 'booking_id' });
  assert.deepEqual(asked.body.data, [{ booking_id: 'BK-APITEST-J1-MAIN' }], 'X-Branch-Id of a branch not assigned changes nothing');
  const patients = await rec.data({ table: 'patients', action: 'select', columns: 'patient_id' });
  assert.deepEqual(patients.body.data, [{ patient_id: 'P-APITEST-J1' }], 'patients are clinic-level, only this clinic');
  const writeOther = await rec.data({
    table: 'bookings', action: 'insert',
    values: { booking_id: 'BK-APITEST-J1-X', patient_id: 'P-APITEST-J1', date: '2026-10-26', time: '11:00', branch_id: 'br_apitest_j1_2' },
  });
  assert.equal(writeOther.status, 403, 'no writes into a branch that is not assigned');
  const otherClinic = await h.client({ cookie: sessionCookie(recAccepted), slug: 'demo-physio' }).data({ table: 'patients', action: 'select' });
  assert.equal(otherClinic.status, 403);
  assert.equal(otherClinic.body.error.code, 'not_a_member');
  assert.equal((await rec.get('/api/org/invitations')).status, 403, 'receptionists do not manage invitations');

  // ── the Super Admin sees the clinic, its members and the audit trail ──
  const detail = await sa.get(`/api/platform/organizations/${orgId}`);
  assert.deepEqual(detail.body.members.map((m) => [m.email, m.role, m.status, m.branch_ids]).sort(), [
    [OWNER, 'admin', 'active', []],
    [RECEPTION, 'receptionist', 'active', [mainBranch]],
  ]);
  assert.deepEqual(detail.body.usage, { active_members: 2, pending_invitations: 0, active_branches: 2 });
  const trail = await sa.get(`/api/platform/audit?organization_id=${orgId}&limit=200`);
  const actions = trail.body.data.map((a) => a.action).reverse();
  assert.deepEqual(
    actions.filter((a) => /^(organization|invitation|user)\./.test(a)),
    ['organization.create', 'invitation.create', 'user.create', 'invitation.accept', 'organization.activate',
      'invitation.create', 'user.create', 'invitation.accept'],
  );

  // ── suspension: the open sessions lose the clinic immediately ─────────
  const suspended = await sa.post(`/api/platform/organizations/${orgId}/status`, { status: 'suspended', reason: 'اختبار الإيقاف' });
  assert.equal(suspended.status, 200);
  for (const c of [rec, admin]) {
    const r = await c.data({ table: 'bookings', action: 'select' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'org_inactive');
  }
  assert.deepEqual((await h.client().get(`/api/orgs/resolve?slug=${SLUG}`)).body, { slug: SLUG, status: 'suspended' });
  const { rows: [org] } = await h.sql('select status, retention_until > now() + interval \'5 months\' as kept from organizations where id = $1', [orgId]);
  assert.deepEqual(org, { status: 'suspended', kept: true });
});
