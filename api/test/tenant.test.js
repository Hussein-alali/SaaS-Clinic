'use strict';
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

// Every active module of the specialty is enabled by db/seed/dev.sql.
const PHYSIO_MODULES = [
  'core.appointments', 'core.billing', 'core.branches', 'core.files', 'core.patients', 'core.reports',
  'core.settings', 'core.staff', 'physio.sessions', 'physio.templates', 'physio.treatment_plans',
];
const CORE_MODULES = PHYSIO_MODULES.filter((m) => m.startsWith('core.'));
// The tooth chart and prescriptions are active since 0018; dental.procedures is still 'planned'.
const DENTAL_MODULES = [...CORE_MODULES, 'dental.chart', 'general.prescriptions'];

test('resolve: active clinic → id, status, specialty, enabled modules, public settings', async () => {
  const res = await h.client().get('/api/orgs/resolve?slug=demo-physio');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: ORG.physio,
    slug: 'demo-physio',
    name: 'عيادة العلاج الطبيعي التجريبية',
    status: 'active',
    specialty_code: 'physio',
    diagnosis_form: 'physio',
    modules: PHYSIO_MODULES,
    settings: { display_name: 'عيادة العلاج الطبيعي التجريبية', subtitle: 'بيانات تجريبية', logo: null, primary_color: '#7BBDE8' },
  });
  // public route: no cookie, no CSRF header needed
  const plain = await h.request('GET', '/api/orgs/resolve?slug=DEMO-PHYSIO');
  assert.equal(plain.status, 200);
  assert.equal(plain.body.id, ORG.physio);
  // dental: core.* + the tooth chart and prescriptions (dental.procedures is 'planned', so not listed)
  const dental = await h.client().get('/api/orgs/resolve?slug=demo-dental');
  assert.equal(dental.body.specialty_code, 'dental');
  assert.equal(dental.body.diagnosis_form, 'dental');
  assert.deepEqual(dental.body.modules, DENTAL_MODULES);
});

test('resolve: disabled modules and modules that are not active in the catalog are left out', async () => {
  await h.sql(
    `update organization_modules set enabled = false
      where organization_id = $1 and module_id = (select id from modules where code = 'core.reports')`,
    [ORG.physio],
  );
  // enabled for the clinic, but 'planned' in the catalog
  await h.sql(
    `update organization_modules set enabled = true
      where organization_id = $1 and module_id = (select id from modules where code = 'dental.procedures')`,
    [ORG.dental],
  );
  try {
    const physio = await h.client().get('/api/orgs/resolve?slug=demo-physio');
    assert.deepEqual(physio.body.modules, PHYSIO_MODULES.filter((m) => m !== 'core.reports'));
    const dental = await h.client().get('/api/orgs/resolve?slug=demo-dental');
    assert.deepEqual(dental.body.modules, DENTAL_MODULES);
  } finally {
    await h.sql(
      `update organization_modules set enabled = (m.code <> 'dental.procedures')
         from modules m
        where m.id = organization_modules.module_id and m.code in ('core.reports', 'dental.procedures')`,
    );
  }
});

test('resolve never leaks details of suspended, closed, draft or unknown clinics', async () => {
  const suspended = await h.client().get('/api/orgs/resolve?slug=demo-suspended');
  assert.equal(suspended.status, 200);
  assert.deepEqual(suspended.body, { slug: 'demo-suspended', status: 'suspended' });
  for (const slug of ['demo-closed', 'demo-draft', 'no-such-clinic', 'bad_slug!', '']) {
    const r = await h.client().get(`/api/orgs/resolve?slug=${encodeURIComponent(slug)}`);
    assert.equal(r.status, 404, slug);
    assert.deepEqual(Object.keys(r.body), ['error']);
  }
  const pending = await h.client().get('/api/orgs/resolve?slug=demo-pending');
  assert.equal(pending.status, 200, 'pending_activation is shown so the first admin can accept the invitation');
  assert.equal(pending.body.status, 'pending_activation');
  assert.equal(pending.body.specialty_code, 'general');
  assert.equal(pending.body.settings.display_name, 'عيادة قيد التفعيل', 'clinic_settings read without a role');
});

test('resolve without ?slug uses the Host subdomain, then X-Org-Slug', async () => {
  const byHost = await h.client({ host: `demo-dental.localhost:${h.port}` }).get('/api/orgs/resolve');
  assert.equal(byHost.status, 200);
  assert.equal(byHost.body.id, ORG.dental);
  const byHeader = await h.client({ slug: 'demo-physio' }).get('/api/orgs/resolve');
  assert.equal(byHeader.body.id, ORG.physio);
  const root = await h.client({ host: `localhost:${h.port}` }).get('/api/orgs/resolve');
  assert.equal(root.status, 404);
});

test('current: org from Host <slug>.localhost (dev base domain), role, branches, current branch', async () => {
  const c = await h.as('physioAdmin', { host: `demo-physio.localhost:${h.port}` });
  const res = await c.get('/api/orgs/current');
  assert.equal(res.status, 200);
  assert.equal(res.body.organization.id, ORG.physio);
  assert.equal(res.body.organization.slug, 'demo-physio');
  assert.deepEqual(res.body.organization.modules, PHYSIO_MODULES);
  assert.equal(res.body.role, 'admin');
  assert.deepEqual(res.body.branches.map((b) => b.id), [BRANCH.physio1, BRANCH.physio2], 'admin: every branch, oldest first');
  assert.equal(res.body.branches[0].name, 'الفرع الرئيسي');
  assert.equal(res.body.branches[0].status, 'active');
  assert.deepEqual(res.body.branches[0].working_hours, { sat: ['09:00', '21:00'], sun: ['09:00', '21:00'] });
  assert.equal(res.body.current_branch_id, BRANCH.physio1);
});

test('current: X-Org-Slug works when the host carries no clinic; Host wins over the header', async () => {
  const { cookie } = await h.login(USER.multi.email);
  const viaHeader = await h.client({ cookie, slug: 'demo-dental' }).get('/api/orgs/current');
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.body.organization.id, ORG.dental);
  assert.equal(viaHeader.body.role, 'receptionist');
  assert.deepEqual(viaHeader.body.branches.map((b) => b.id), [BRANCH.dental2]);

  const hostWins = await h.client({ cookie, slug: 'demo-dental', host: `demo-physio.localhost:${h.port}` }).get('/api/orgs/current');
  assert.equal(hostWins.body.organization.id, ORG.physio);
  assert.equal(hostWins.body.role, 'therapist');
});

test('branch selection: X-Branch-Id when accessible, else the first accessible active branch', async () => {
  const admin = await h.login(USER.physioAdmin.email);
  const second = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: BRANCH.physio2 }).get('/api/orgs/current');
  assert.equal(second.body.current_branch_id, BRANCH.physio2);
  const foreign = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: BRANCH.dental1 }).get('/api/orgs/current');
  assert.equal(foreign.body.current_branch_id, BRANCH.physio1, 'a branch of another clinic is ignored');
  const placeholder = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: 'br_main' }).get('/api/orgs/current');
  assert.equal(placeholder.body.current_branch_id, BRANCH.physio1, "the frontend's placeholder id falls back");

  const recep = await h.login(USER.physioReception.email);
  const r = await h.client({ cookie: recep.cookie, slug: 'demo-physio', branch: BRANCH.physio2 }).get('/api/orgs/current');
  assert.equal(r.body.role, 'receptionist');
  assert.deepEqual(r.body.branches.map((b) => b.id), [BRANCH.physio1]);
  assert.equal(r.body.current_branch_id, BRANCH.physio1, 'member_branches limit non-admins');

  const recep2 = await h.login(USER.physioReception2.email);
  const r2 = await h.client({ cookie: recep2.cookie, slug: 'demo-physio', branch: BRANCH.physio2 }).get('/api/orgs/current');
  assert.deepEqual(r2.body.branches.map((b) => b.id), [BRANCH.physio1, BRANCH.physio2]);
  assert.equal(r2.body.current_branch_id, BRANCH.physio2);

  const multi = await h.login(USER.multi.email);
  const m2 = await h.client({ cookie: multi.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(m2.body.current_branch_id, BRANCH.physio1);

  const staff = await h.login(USER.physioStaff.email);
  const s = await h.client({ cookie: staff.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(s.status, 200);
  assert.equal(s.body.role, 'staff');
  assert.deepEqual(s.body.branches, []);
  assert.equal(s.body.current_branch_id, null);
});

test('an inactive branch is never chosen by default, but can still be asked for', async () => {
  await h.asSystem("update branches set status = 'inactive' where id = $1", [BRANCH.physio1]);
  try {
    const admin = await h.login(USER.physioAdmin.email);
    const res = await h.client({ cookie: admin.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
    assert.equal(res.body.current_branch_id, BRANCH.physio2);
    assert.deepEqual(res.body.branches.map((b) => b.id), [BRANCH.physio2, BRANCH.physio1], 'active branches first');
    const asked = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: BRANCH.physio1 }).get('/api/orgs/current');
    assert.equal(asked.body.current_branch_id, BRANCH.physio1);
  } finally {
    await h.asSystem("update branches set status = 'active' where id = $1", [BRANCH.physio1]);
  }
});

test('an inactive X-Branch-Id is kept: reads and updates work, new rows → 409 branch_inactive (0009); an active branch can still settle its invoices', async () => {
  const BRANCH_INACTIVE = { error: { message: 'Branch is inactive', code: 'branch_inactive' } };
  const eq = (column, value) => [{ column, op: 'eq', value }];
  const invoicePaid = async () =>
    Number((await h.asSystem("select paid from invoices where invoice_id = 'INV-PHY-B1-1'")).rows[0].paid);
  await h.asSystem("update branches set status = 'inactive' where id = $1", [BRANCH.physio1]);
  try {
    // The receptionist works only in branch 1: it stays her branch, with or
    // without X-Branch-Id (never silently switched).
    for (const branch of [BRANCH.physio1, undefined]) {
      const recep = await h.as('physioReception', { slug: 'demo-physio', branch });
      assert.equal((await recep.get('/api/orgs/current')).body.current_branch_id, BRANCH.physio1);
      const read = await recep.data({ table: 'bookings', filters: eq('booking_id', 'BK-PHY-B1-1') });
      assert.equal(read.status, 200);
      assert.equal(read.body.data.length, 1, 'the history of the branch is readable');
    }
    const recep = await h.as('physioReception', { slug: 'demo-physio', branch: BRANCH.physio1 });

    // New rows: /api/data (insert, upsert of a new key) and an inserting RPC.
    const ins = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: 'BK-INACTIVE-1', patient_id: 'P-PHY-01', date: '2026-10-25', time: '10:00', price: 100 } });
    assert.equal(ins.status, 409, ins.text);
    assert.deepEqual(ins.body, BRANCH_INACTIVE);
    const ups = await recep.data({ table: 'bookings', action: 'upsert', values: { booking_id: 'BK-INACTIVE-2', patient_id: 'P-PHY-01' } });
    assert.equal(ups.status, 409);
    assert.deepEqual(ups.body, BRANCH_INACTIVE);
    const before = await invoicePaid();
    const pay = await recep.rpc('record_quick_payment', {
      p_patient_id: 'P-PHY-01', p_allocations: [{ type: 'invoice', id: 'INV-PHY-B1-1', amount: 10 }], p_method: 'cash',
    });
    assert.equal(pay.status, 409, pay.text);
    assert.deepEqual(pay.body, BRANCH_INACTIVE);
    assert.equal(await invoicePaid(), before, 'the RPC rolled back as a whole');
    assert.equal((await h.asSystem("select count(*)::int as n from bookings where booking_id like 'BK-INACTIVE-%'")).rows[0].n, 0);

    // Existing rows: update, and upsert of an existing key (how the screens save).
    const upd = await recep.data({ table: 'bookings', action: 'update', values: { notes: 'inactive branch' }, filters: eq('booking_id', 'BK-PHY-B1-1'), returning: true });
    assert.equal(upd.status, 200, upd.text);
    const save = await recep.data({ table: 'bookings', action: 'upsert', values: { booking_id: 'BK-PHY-B1-1', patient_id: 'P-PHY-01', status: 'cancelled' } });
    assert.equal(save.status, 200, save.text);
    const { rows: [bk] } = await h.asSystem("select branch_id, status, notes from bookings where booking_id = 'BK-PHY-B1-1'");
    assert.deepEqual(bk, { branch_id: BRANCH.physio1, status: 'cancelled', notes: 'inactive branch' });

    // The admin, in an active branch (the default now), settles the old
    // branch-1 invoice: the payment is a new row of branch 2.
    const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
    assert.equal((await admin.get('/api/orgs/current')).body.current_branch_id, BRANCH.physio2);
    const settled = await admin.rpc('record_quick_payment', {
      p_patient_id: 'P-PHY-01', p_allocations: [{ type: 'invoice', id: 'INV-PHY-B1-1', amount: 10 }], p_method: 'cash',
    });
    assert.equal(settled.status, 200, settled.text);
    assert.equal(await invoicePaid(), before + 10);
    const { rows: [p] } = await h.asSystem('select branch_id from payments where payment_id = $1', [settled.body.payment_id]);
    assert.equal(p.branch_id, BRANCH.physio2);
  } finally {
    await h.asSystem("update branches set status = 'active' where id = $1", [BRANCH.physio1]);
  }
  // Active again: new rows are accepted.
  const recep = await h.as('physioReception', { slug: 'demo-physio', branch: BRANCH.physio1 });
  const ok = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: 'BK-ACTIVE-AGAIN', patient_id: 'P-PHY-01' } });
  assert.equal(ok.status, 200, ok.text);
});

test('a non-member gets 403, whatever the route', async () => {
  const outsider = await h.login(USER.outsider.email);
  const c = h.client({ cookie: outsider.cookie, slug: 'demo-physio' });
  for (const res of [
    await c.get('/api/orgs/current'),
    await c.data({ table: 'patients' }),
    await c.rpc('get_treatment', { p_treatment_id: 'TRT-PHY-B1-1' }),
    await c.post('/api/files/sign', { bucket: 'patient-files', path: 'a/b.pdf' }),
    await c.get('/api/files/object/patient-files/a/b.pdf'),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'not_a_member');
  }
  // a member of another clinic is a non-member here
  const dental = await h.login(USER.dentalAdmin.email);
  const cross = await h.client({ cookie: dental.cookie, slug: 'demo-physio' }).data({ table: 'patients' });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'not_a_member');
  // a Super Admin is not a clinic member either (BR-008)
  const sa = await h.login(USER.superAdmin.email);
  assert.equal((await h.client({ cookie: sa.cookie, slug: 'demo-physio' }).data({ table: 'patients' })).status, 403);
});

test('disabled membership, suspended clinic, platform host and missing clinic → 403; no session → 401', async () => {
  const former = await h.login(USER.former.email);
  const f = await h.client({ cookie: former.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(f.status, 403);
  assert.equal(f.body.error.code, 'not_a_member');

  const susp = await h.login(USER.suspendedAdmin.email);
  const s = await h.client({ cookie: susp.cookie, slug: 'demo-suspended' }).data({ table: 'patients' });
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'org_inactive');

  const admin = await h.login(USER.physioAdmin.email);
  const platform = await h.client({ cookie: admin.cookie, host: `admin.localhost:${h.port}`, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(platform.status, 403, 'admin.<base> is platform context: X-Org-Slug is ignored');
  assert.equal(platform.body.error.code, 'org_required');
  const none = await h.client({ cookie: admin.cookie }).get('/api/orgs/current');
  assert.equal(none.status, 403);
  assert.equal(none.body.error.code, 'org_required');

  const anon = await h.client({ slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(anon.status, 401);
});

test('suspending a clinic blocks its members on the next request', async () => {
  const admin = await h.login(USER.dentalAdmin.email);
  const c = h.client({ cookie: admin.cookie, slug: 'demo-dental' });
  assert.equal((await c.data({ table: 'patients' })).status, 200);
  await h.sql("update organizations set status = 'suspended', status_reason = 'test' where id = $1", [ORG.dental]);
  try {
    const r = await c.data({ table: 'patients' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'org_inactive');
    const resolve = await h.client().get('/api/orgs/resolve?slug=demo-dental');
    assert.deepEqual(resolve.body, { slug: 'demo-dental', status: 'suspended' });
  } finally {
    await h.sql("update organizations set status = 'active', status_reason = null where id = $1", [ORG.dental]);
  }
});

test('the database agrees: app_role() is NULL wherever the API answers 403', async () => {
  // The API's membership check and the database's app_role() are two
  // implementations of convention 7; they must give the same answer.
  const cases = [
    [USER.physioAdmin.id, ORG.physio, 'admin'],
    [USER.multi.id, ORG.dental, 'receptionist'],
    [USER.former.id, ORG.physio, null], // disabled membership
    [USER.dentalAdmin.id, ORG.physio, null], // other clinic
    [USER.suspendedAdmin.id, ORG.suspended, null], // suspended clinic
    [USER.superAdmin.id, ORG.physio, null], // BR-008
  ];
  for (const [user, org, role] of cases) {
    const { rows } = await h.asUser(user, org, 'select public.app_role() as role');
    assert.equal(rows[0].role, role, `${user} in ${org}`);
  }
});
