'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

test('resolve: active clinic → id, status, specialty, enabled modules, public settings', async () => {
  const res = await h.client().get('/api/orgs/resolve?slug=demo-physio');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: ORG.physio,
    slug: 'demo-physio',
    name: 'Demo Physio',
    status: 'active',
    specialty_code: 'physio',
    // disabled (core.branches) and platform-inactive (legacy.reports) modules are left out
    modules: ['core.appointments', 'core.patients', 'physio.sessions'],
    settings: { display_name: 'عيادة العلاج الطبيعي', subtitle: 'نظام العيادة', logo: null, primary_color: '#123456' },
  });
  // public route: no cookie, no CSRF header needed
  const plain = await h.request('GET', '/api/orgs/resolve?slug=DEMO-PHYSIO');
  assert.equal(plain.status, 200);
  assert.equal(plain.body.id, ORG.physio);
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
  assert.deepEqual(res.body.organization.modules, ['core.appointments', 'core.patients', 'physio.sessions']);
  assert.equal(res.body.role, 'admin');
  assert.deepEqual(res.body.branches.map((b) => b.id), ['br-physio-main', 'br-physio-east'], 'admin: every branch, oldest first');
  assert.equal(res.body.branches[0].name, 'الفرع الرئيسي');
  assert.equal(res.body.current_branch_id, 'br-physio-main');
});

test('current: X-Org-Slug works when the host carries no clinic; Host wins over the header', async () => {
  const { cookie } = await h.login(USER.multi.email);
  const viaHeader = await h.client({ cookie, slug: 'demo-dental' }).get('/api/orgs/current');
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.body.organization.id, ORG.dental);
  assert.equal(viaHeader.body.role, 'receptionist');
  assert.deepEqual(viaHeader.body.branches.map((b) => b.id), ['br-dental-west']);

  const hostWins = await h.client({ cookie, slug: 'demo-dental', host: `demo-physio.localhost:${h.port}` }).get('/api/orgs/current');
  assert.equal(hostWins.body.organization.id, ORG.physio);
  assert.equal(hostWins.body.role, 'therapist');
});

test('branch selection: X-Branch-Id when accessible, else the first accessible branch', async () => {
  const admin = await h.login(USER.physioAdmin.email);
  const east = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: 'br-physio-east' }).get('/api/orgs/current');
  assert.equal(east.body.current_branch_id, 'br-physio-east');
  const foreign = await h.client({ cookie: admin.cookie, slug: 'demo-physio', branch: 'br-dental-main' }).get('/api/orgs/current');
  assert.equal(foreign.body.current_branch_id, 'br-physio-main', 'a branch of another clinic is ignored');

  const recep = await h.login(USER.physioReception.email);
  const r = await h.client({ cookie: recep.cookie, slug: 'demo-physio', branch: 'br-physio-main' }).get('/api/orgs/current');
  assert.equal(r.body.role, 'receptionist');
  assert.deepEqual(r.body.branches.map((b) => b.id), ['br-physio-east']);
  assert.equal(r.body.current_branch_id, 'br-physio-east', 'member_branches limit non-admins');

  const multi = await h.login(USER.multi.email);
  const m = await h.client({ cookie: multi.cookie, slug: 'demo-physio', branch: 'br-physio-east' }).get('/api/orgs/current');
  assert.equal(m.body.current_branch_id, 'br-physio-east');
  const m2 = await h.client({ cookie: multi.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(m2.body.current_branch_id, 'br-physio-main');

  const staff = await h.login(USER.physioStaff.email);
  const s = await h.client({ cookie: staff.cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.branches, []);
  assert.equal(s.body.current_branch_id, null);
});

test('a non-member gets 403, whatever the route', async () => {
  const outsider = await h.login(USER.outsider.email);
  const c = h.client({ cookie: outsider.cookie, slug: 'demo-physio' });
  for (const res of [
    await c.get('/api/orgs/current'),
    await c.data({ table: 'patients' }),
    await c.rpc('get_treatment', { p_treatment_id: 'T1' }),
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
  await h.sql("update organizations set status = 'suspended' where id = $1", [ORG.dental]);
  try {
    const r = await c.data({ table: 'patients' });
    assert.equal(r.status, 403);
    const resolve = await h.client().get('/api/orgs/resolve?slug=demo-dental');
    assert.deepEqual(resolve.body, { slug: 'demo-dental', status: 'suspended' });
  } finally {
    await h.sql("update organizations set status = 'active' where id = $1", [ORG.dental]);
  }
});
