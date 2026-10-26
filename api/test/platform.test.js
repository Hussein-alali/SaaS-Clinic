'use strict';
// /api/platform/* (Super Admin), against the real schema + seed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rawRequest, freePort, TEST_DB_URL, USER, ORG, BRANCH } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/create-app');

let h;
let sa; // Super Admin client in the platform context (X-Platform: 1)
before(async () => {
  h = await setup();
  sa = await h.as('superAdmin', { platform: true });
});
after(async () => {
  await h.close();
});

const PHYSIO_ACTIVE = [
  'core.appointments', 'core.billing', 'core.branches', 'core.files', 'core.patients', 'core.reports',
  'core.settings', 'core.staff', 'physio.sessions', 'physio.templates', 'physio.treatment_plans',
];
const audits = async (action, orgId) =>
  (await h.asSystem(
    `select * from audit_events where action = $1 and organization_id is not distinct from $2 order by id`,
    [action, orgId === undefined ? null : orgId],
  )).rows;
const tokenFor = (email) => {
  const mails = h.outbox().filter((m) => m.to === email);
  assert.ok(mails.length, `e-mail to ${email}`);
  return /[?&]invite=([A-Za-z0-9_-]+)/.exec(mails[mails.length - 1].text)[1];
};

const ROUTES = [
  ['GET', '/api/platform/stats'],
  ['GET', '/api/platform/organizations'],
  ['POST', '/api/platform/organizations'],
  ['GET', `/api/platform/organizations/${ORG.physio}`],
  ['PATCH', `/api/platform/organizations/${ORG.physio}`],
  ['POST', `/api/platform/organizations/${ORG.physio}/status`],
  ['PUT', `/api/platform/organizations/${ORG.physio}/modules`],
  ['PUT', `/api/platform/organizations/${ORG.physio}/subscription`],
  ['GET', `/api/platform/organizations/${ORG.physio}/invitations`],
  ['POST', `/api/platform/organizations/${ORG.physio}/invitations`],
  ['GET', '/api/platform/slug-available?slug=abc'],
  ['GET', '/api/platform/specialties'],
  ['GET', '/api/platform/modules'],
  ['GET', '/api/platform/plans'],
  ['POST', '/api/platform/plans'],
  ['PATCH', '/api/platform/plans/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/platform/audit'],
];

test('access: 401 without a session, 403 not_super_admin for every clinic role on every route', async () => {
  for (const [method, p] of ROUTES) {
    const anon = await h.request(method, p, { headers: { 'x-requested-with': 'clinicsys', 'x-platform': '1' }, json: {} });
    assert.equal(anon.status, 401, `${method} ${p}`);
  }
  for (const who of ['physioAdmin', 'dentalAdmin', 'physioReception', 'multi']) {
    const { cookie } = await h.login(USER[who].email);
    for (const [method, p] of ROUTES) {
      const res = await h.request(method, p, {
        headers: { 'x-requested-with': 'clinicsys', 'x-platform': '1', cookie: cookie.value, host: `admin.localhost:${h.port}` },
        json: { name: 'Hack', slug: 'apitest-hack', specialty_code: 'physio', admin_email: 'x@x.test', status: 'suspended', reason: 'x', codes: [] },
      });
      assert.equal(res.status, 403, `${who} ${method} ${p}`);
      assert.equal(res.body.error.code, 'not_super_admin');
    }
  }
  const { rowCount } = await h.sql("select 1 from organizations where slug = 'apitest-hack'");
  assert.equal(rowCount, 0);
  const { rows: [physio] } = await h.sql('select status from organizations where id = $1', [ORG.physio]);
  assert.equal(physio.status, 'active');
});

test('platform context: admin.<base> host or X-Platform: 1 (not in production); a clinic host is refused', async () => {
  const { cookie } = await h.login(USER.superAdmin.email);
  const viaHost = await h.client({ cookie, host: `admin.localhost:${h.port}` }).get('/api/platform/stats');
  assert.equal(viaHost.status, 200);
  const viaHeader = await h.client({ cookie, platform: true }).get('/api/platform/stats');
  assert.equal(viaHeader.status, 200);
  for (const opts of [{ slug: 'demo-physio' }, { host: `demo-physio.localhost:${h.port}` }, {}]) {
    const r = await h.client({ cookie, ...opts }).get('/api/platform/stats');
    assert.equal(r.status, 403, JSON.stringify(opts));
    assert.equal(r.body.error.code, 'platform_required');
  }
  // Production ignores X-Platform: only the admin host is the platform.
  const config = loadConfig({
    NODE_ENV: 'production', DATABASE_URL: TEST_DB_URL, APP_BASE_DOMAIN: 'localhost',
    JWT_SECRET: h.config.jwtSecret, FILES_SIGNING_SECRET: 'another-secret-for-files-0123456789abcdef',
    FILES_DIR: h.config.filesDir, MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: h.config.mailOutboxDir, DIST_DIR: h.config.distDir,
  });
  const app = createApp(config);
  const port = await freePort();
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  try {
    const header = await rawRequest(port, 'GET', '/api/platform/stats', { headers: { cookie: cookie.value, 'x-platform': '1' } });
    assert.equal(header.status, 403);
    assert.equal(header.body.error.code, 'platform_required');
    const host = await rawRequest(port, 'GET', '/api/platform/stats', { headers: { cookie: cookie.value, host: 'admin.localhost' } });
    assert.equal(host.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  }
});

test('stats, catalogs (specialties, modules) and slug-available', async () => {
  const stats = await sa.get('/api/platform/stats');
  assert.deepEqual(stats.body, {
    organizations: { draft: 1, pending_activation: 1, active: 2, suspended: 1, closed: 1, total: 6 },
    pending_invitations: 0,
    retention_overdue: 0,
    open_errors: 0,
    jobs_queued: 0,
    jobs_failed: 0,
  });
  const specialties = await sa.get('/api/platform/specialties');
  assert.deepEqual(specialties.body.map((s) => s.code), ['dental', 'general', 'physio']);
  const physio = specialties.body.find((s) => s.code === 'physio');
  assert.ok(physio.default_modules.includes('physio.sessions') && physio.default_modules.includes('core.branches'));
  const modules = await sa.get('/api/platform/modules');
  assert.equal(modules.body.length, 16);
  assert.deepEqual(modules.body.find((m) => m.code === 'physio.sessions').depends_on, ['core.patients', 'core.appointments']);

  const cases = {
    'apitest-new-clinic': [true, null],
    'abc': [true, null],
    [`a${'b'.repeat(30)}c`]: [true, null], // 32 characters
    'demo-physio': [false, 'taken'],
    'admin': [false, 'reserved'],
    'www': [false, 'reserved'],
    'api': [false, 'reserved'],
    'staging': [false, 'reserved'],
    'DEMO-PHYSIO': [false, 'invalid_format'],
    'ab': [false, 'invalid_format'],
    '-abc': [false, 'invalid_format'],
    'abc-': [false, 'invalid_format'],
    'a_bc': [false, 'invalid_format'],
    'a.bc': [false, 'invalid_format'],
    [`a${'b'.repeat(31)}c`]: [false, 'invalid_format'], // 33 characters
    '': [false, 'invalid_format'],
  };
  for (const [slug, [available, reason]] of Object.entries(cases)) {
    const r = await sa.get(`/api/platform/slug-available?slug=${encodeURIComponent(slug)}`);
    assert.deepEqual(r.body, { available, reason }, slug);
  }
});

test('plans: list, create (validated, audited), duplicate code 409, patch', async () => {
  const list = await sa.get('/api/platform/plans');
  assert.deepEqual(list.body.map((p) => p.code).sort(), ['default', 'tiny']);
  assert.equal(list.body.find((p) => p.code === 'default').organizations >= 2, true);
  const bad = [
    [{ code: 'Bad Code', name: 'x' }, 'invalid_code'],
    [{ code: 'ok', name: '' }, 'invalid_name'],
    [{ code: 'ok', name: 'x', max_users: -1 }, 'invalid_limit'],
    [{ code: 'ok', name: 'x', max_branches: 1.5 }, 'invalid_limit'],
    [{ code: 'ok', name: 'x', included_modules: ['nope.mod'] }, 'unknown_module'],
    [{ code: 'ok', name: 'x', status: 'deleted' }, 'invalid_status'],
  ];
  for (const [body, code] of bad) {
    const r = await sa.post('/api/platform/plans', body);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.error.code, code);
  }
  const created = await sa.post('/api/platform/plans', {
    code: 'basic', name: 'أساسية', max_users: 5, max_branches: 1, max_storage_mb: 1024, included_modules: ['physio.sessions'],
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.code, 'basic');
  assert.equal(created.body.status, 'active');
  assert.deepEqual(created.body.included_modules, ['physio.sessions']);
  const dup = await sa.post('/api/platform/plans', { code: 'basic', name: 'again' });
  assert.equal(dup.status, 409);
  const patched = await sa.patch(`/api/platform/plans/${created.body.id}`, { max_users: null, status: 'archived' });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.max_users, null);
  assert.equal(patched.body.status, 'archived');
  assert.equal(patched.body.max_branches, 1, 'untouched fields stay');
  assert.equal((await sa.patch(`/api/platform/plans/${created.body.id}`, {})).status, 400);
  assert.equal((await sa.patch('/api/platform/plans/00000000-0000-4000-8000-000000000000', { name: 'x' })).status, 404);
  const [a] = await audits('plan.create');
  assert.equal(a.actor_uid, USER.superAdmin.id);
  assert.equal(a.actor_role, 'super_admin');
  assert.equal(a.organization_id, null);
  assert.equal((await audits('plan.update')).length, 1);
  assert.deepEqual((await audits('plan.update'))[0].payload.changes.status, { from: 'active', to: 'archived' });
});

const NEW_ORG = {
  name: 'عيادة الاختبار', slug: 'apitest-alpha', specialty_code: 'physio', admin_email: 'owner@apitest-alpha.test',
};

test('create organization: validation errors leave nothing behind', async () => {
  const { rows: [{ id: archived }] } = await h.sql("select id from subscription_plans where code = 'basic'");
  const cases = [
    [{ ...NEW_ORG, name: 'x' }, 400, 'invalid_name'],
    [{ ...NEW_ORG, slug: 'Apitest-Alpha' }, 400, 'invalid_slug'],
    [{ ...NEW_ORG, slug: 'admin' }, 400, 'slug_reserved'],
    [{ ...NEW_ORG, slug: 'demo-dental' }, 409, 'slug_taken'],
    [{ ...NEW_ORG, specialty_code: 'cardio' }, 400, 'invalid_specialty'],
    [{ ...NEW_ORG, modules: ['core.patients', 'physio.sessions'] }, 400, 'module_dependency'],
    [{ ...NEW_ORG, modules: ['core.patients', 'dental.chart'] }, 400, 'module_unavailable'],
    [{ ...NEW_ORG, modules: ['core.nope'] }, 400, 'unknown_module'],
    [{ ...NEW_ORG, plan_id: 'nope' }, 400, 'invalid_plan'],
    [{ ...NEW_ORG, plan_id: archived }, 400, 'invalid_plan'],
    [{ ...NEW_ORG, admin_email: 'not-an-email' }, 400, 'invalid_email'],
  ];
  for (const [body, status, code] of cases) {
    const r = await sa.post('/api/platform/organizations', body);
    assert.equal(r.status, status, `${code}: ${r.text}`);
    assert.equal(r.body.error.code, code);
  }
  // A plan that only includes physio.sessions cannot have the templates module.
  const { rows: [restricted] } = await h.sql(
    "insert into subscription_plans (code, name, included_modules) values ('restricted', 'r', '{physio.sessions}') returning id",
  );
  const r = await sa.post('/api/platform/organizations', { ...NEW_ORG, plan_id: restricted.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'plan_limit_modules');

  // Atomic: a failure in a late step (the main branch or the invitation hits
  // the plan limit) rolls back the organization and everything before it.
  for (const limits of [{ max_branches: 0 }, { max_users: 0 }]) {
    const { rows: [plan] } = await h.sql(
      'insert into subscription_plans (code, name, max_branches, max_users) values ($1, $1, $2, $3) returning id',
      [`zero-${Object.keys(limits)[0].replace('_', '-')}`, limits.max_branches ?? null, limits.max_users ?? null],
    );
    const res = await sa.post('/api/platform/organizations', { ...NEW_ORG, plan_id: plan.id });
    assert.equal(res.status, 422, res.text);
    assert.match(res.body.error.message, /^plan_limit:(branches|users)$/);
  }
  const { rowCount } = await h.sql("select 1 from organizations where slug = 'apitest-alpha'");
  assert.equal(rowCount, 0);
  const { rows: [left] } = await h.asSystem(
    `select (select count(*) from branches where name = 'الفرع الرئيسي' and organization_id not in (select id from organizations))::int as branches,
            (select count(*) from invitations where email = 'owner@apitest-alpha.test')::int as invitations,
            (select count(*) from audit_events where action = 'organization.create')::int as audits`,
  );
  assert.deepEqual(left, { branches: 0, invitations: 0, audits: 0 });
  assert.equal(h.outbox().filter((m) => m.to === NEW_ORG.admin_email).length, 0);
});

test('create organization: pending_activation + main branch + settings + modules + subscription + admin invitation (atomic, audited)', async () => {
  const res = await sa.post('/api/platform/organizations', { ...NEW_ORG, admin_email: ' Owner@ApiTest-Alpha.test ' });
  assert.equal(res.status, 201, res.text);
  const { organization: org, branches, modules, members, invitations, subscription, invitation, usage } = res.body;
  assert.equal(org.slug, 'apitest-alpha');
  assert.equal(org.name, 'عيادة الاختبار');
  assert.equal(org.status, 'pending_activation');
  assert.equal(org.specialty_code, 'physio');
  assert.equal(org.created_by, USER.superAdmin.id);
  assert.equal(org.plan.code, 'default', 'no plan_id → the default plan');
  assert.equal(branches.length, 1);
  assert.equal(branches[0].name, 'الفرع الرئيسي');
  assert.match(branches[0].id, /^br_[0-9a-z]{12,}$/);
  assert.deepEqual(modules.filter((m) => m.enabled).map((m) => m.code).sort(), PHYSIO_ACTIVE, 'specialty defaults');
  assert.deepEqual(members, []);
  assert.equal(invitations.length, 1);
  assert.equal(invitation.email, 'owner@apitest-alpha.test');
  assert.equal(invitation.role, 'admin');
  assert.equal(invitation.status, 'pending');
  assert.equal(res.body.email_sent, true);
  // The delivery state is stored (0008) and the detail is read after sending.
  assert.equal(invitation.email_status, 'sent');
  assert.ok(Date.parse(invitation.email_status_at) > 0);
  assert.deepEqual([invitations[0].email_status, invitations[0].email_status_at], ['sent', invitation.email_status_at]);
  assert.equal(subscription.plan_id, org.plan_id);
  assert.equal(subscription.status, 'active');
  assert.deepEqual(usage, { active_members: 0, pending_invitations: 1, active_branches: 1 });

  const { rows: [settings] } = await h.asSystem('select name from clinic_settings where organization_id = $1', [org.id]);
  assert.equal(settings.name, 'عيادة الاختبار');
  const token = tokenFor('owner@apitest-alpha.test');
  assert.ok(h.outbox().find((m) => m.to === 'owner@apitest-alpha.test').text.includes(`http://apitest-alpha.localhost:${h.port}/?invite=${token}&org=apitest-alpha`));
  const resolve = await h.client().get('/api/orgs/resolve?slug=apitest-alpha');
  assert.equal(resolve.body.status, 'pending_activation');
  assert.deepEqual(resolve.body.modules, PHYSIO_ACTIVE);

  const [created] = await audits('organization.create', org.id);
  assert.equal(created.actor_uid, USER.superAdmin.id);
  assert.equal(created.payload.slug, 'apitest-alpha');
  assert.equal(created.payload.admin_email, 'owner@apitest-alpha.test');
  assert.equal((await audits('invitation.create', org.id)).length, 1);
  const again = await sa.post('/api/platform/organizations', NEW_ORG);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'slug_taken');

  // Chosen modules: dependencies satisfied; specialty defaults not chosen stay as disabled rows.
  const beta = await sa.post('/api/platform/organizations', {
    name: 'Beta', slug: 'apitest-beta', specialty_code: 'physio', admin_email: 'owner@apitest-beta.test',
    modules: ['core.patients', 'core.branches', 'core.appointments', 'core.settings'],
  });
  assert.equal(beta.status, 201, beta.text);
  assert.deepEqual(beta.body.modules.filter((m) => m.enabled).map((m) => m.code).sort(), ['core.appointments', 'core.branches', 'core.patients', 'core.settings']);
  const { rows: [{ n }] } = await h.sql(
    'select count(*)::int as n from organization_modules where organization_id = $1 and not enabled', [beta.body.organization.id],
  );
  assert.equal(n, PHYSIO_ACTIVE.length - 4);
});

test('organizations list (search, filters, pagination) and detail (404 for unknown ids)', async () => {
  const all = await sa.get('/api/platform/organizations');
  assert.equal(all.body.count, 8);
  assert.equal(all.body.data[0].slug, 'apitest-beta', 'newest first');
  const physio = await sa.get('/api/platform/organizations?specialty=physio&status=active');
  assert.deepEqual(physio.body.data.map((o) => o.slug), ['demo-physio']);
  assert.equal(physio.body.data[0].active_members >= 5, true);
  const q = await sa.get(`/api/platform/organizations?q=${encodeURIComponent('apitest')}`);
  assert.deepEqual(q.body.data.map((o) => o.slug).sort(), ['apitest-alpha', 'apitest-beta']);
  assert.equal(q.body.data.find((o) => o.slug === 'apitest-alpha').pending_invitations, 1);
  const pct = await sa.get(`/api/platform/organizations?q=${encodeURIComponent('%')}`);
  assert.equal(pct.body.count, 0, 'LIKE wildcards are literal');
  const pageTwo = await sa.get('/api/platform/organizations?limit=3&offset=3');
  assert.equal(pageTwo.body.data.length, 3);
  assert.equal(pageTwo.body.count, 8);
  assert.equal((await sa.get('/api/platform/organizations?status=gone')).status, 400);
  assert.equal((await sa.get('/api/platform/organizations?limit=0')).status, 400);

  const detail = await sa.get(`/api/platform/organizations/${ORG.physio}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.organization.slug, 'demo-physio');
  assert.deepEqual(detail.body.branches.map((b) => b.id), [BRANCH.physio1, BRANCH.physio2]);
  const recep2 = detail.body.members.find((m) => m.email === USER.physioReception2.email);
  assert.deepEqual(recep2.branch_ids, [BRANCH.physio1, BRANCH.physio2]);
  assert.equal(recep2.role, 'receptionist');
  assert.ok(!JSON.stringify(detail.body).includes('P-PHY-'), 'no patient data');
  for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    const r = await sa.get(`/api/platform/organizations/${id}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'org_not_found');
  }
});

test('PATCH organization: name, specialty, plan; validated; audited with the changes', async () => {
  const { rows: [tiny] } = await h.sql("select id from subscription_plans where code = 'tiny'");
  const res = await sa.patch(`/api/platform/organizations/${ORG.pending}`, { name: 'Demo Pending 2', specialty_code: 'dental', plan_id: tiny.id });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.organization.name, 'Demo Pending 2');
  assert.equal(res.body.organization.specialty_code, 'dental');
  assert.equal(res.body.organization.plan.code, 'tiny');
  const [a] = await audits('organization.update', ORG.pending);
  assert.deepEqual(a.payload.changes.name, { from: 'Demo Pending', to: 'Demo Pending 2' });
  assert.deepEqual(a.payload.changes.specialty_code, { from: 'general', to: 'dental' });
  for (const [body, code] of [[{}, 'nothing_to_update'], [{ name: 'x' }, 'invalid_name'], [{ specialty_code: 'x' }, 'invalid_specialty'], [{ plan_id: 'x' }, 'invalid_plan']]) {
    const r = await sa.patch(`/api/platform/organizations/${ORG.pending}`, body);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.error.code, code);
  }
  const same = await sa.patch(`/api/platform/organizations/${ORG.pending}`, { name: 'Demo Pending 2' });
  assert.equal(same.status, 200);
  assert.equal((await audits('organization.update', ORG.pending)).length, 1, 'no change, no audit row');
});

test('status: suspension needs a reason, sets retention_until = +6 months and ends access at once; transitions enforced', async () => {
  const recep = await h.as('dentalReception', { slug: 'demo-dental' });
  assert.equal((await recep.data({ table: 'patients', action: 'select', columns: 'patient_id' })).status, 200);
  const filesSigned = await h.asSystem("select count(*)::int as n from patients where organization_id = $1", [ORG.dental]);
  assert.ok(filesSigned.rows[0].n > 0);

  const noReason = await sa.post(`/api/platform/organizations/${ORG.dental}/status`, { status: 'suspended' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'reason_required');
  const blank = await sa.post(`/api/platform/organizations/${ORG.dental}/status`, { status: 'suspended', reason: '   ' });
  assert.equal(blank.body.error.code, 'reason_required');

  const res = await sa.post(`/api/platform/organizations/${ORG.dental}/status`, { status: 'suspended', reason: 'لم يتم السداد' });
  assert.equal(res.status, 200, res.text);
  const o = res.body.organization;
  assert.equal(o.status, 'suspended');
  assert.equal(o.status_reason, 'لم يتم السداد');
  const months = (Date.parse(o.retention_until) - Date.parse(o.suspended_at)) / (86400000 * 30.44);
  assert.ok(months > 5.9 && months < 6.1, `retention ${months} months`);
  const { rows: [{ ok }] } = await h.sql(
    "select retention_until = suspended_at + interval '6 months' as ok from organizations where id = $1", [ORG.dental],
  );
  assert.equal(ok, true);

  // The receptionist's EXISTING session loses the clinic immediately.
  const denied = await recep.data({ table: 'patients', action: 'select' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'org_inactive');
  assert.equal((await recep.get('/api/orgs/current')).status, 403);
  assert.deepEqual((await recep.get('/api/auth/session')).body.memberships, []);
  assert.deepEqual((await h.client().get('/api/orgs/resolve?slug=demo-dental')).body, { slug: 'demo-dental', status: 'suspended' });
  const { rows: [{ role }] } = await h.asUser(USER.dentalAdmin.id, ORG.dental, 'select public.app_role() as role');
  assert.equal(role, null, 'app_role() is NULL in a suspended clinic');

  const bad = await sa.post(`/api/platform/organizations/${ORG.dental}/status`, { status: 'pending_activation' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, 'invalid_transition');

  const back = await sa.post(`/api/platform/organizations/${ORG.dental}/status`, { status: 'active' });
  assert.equal(back.status, 200);
  assert.equal(back.body.organization.status, 'active');
  assert.equal(back.body.organization.retention_until, null);
  assert.equal(back.body.organization.suspended_at, null);
  assert.equal((await recep.data({ table: 'patients', action: 'select', columns: 'patient_id' })).status, 200, 'access returns');

  const transitions = [
    [ORG.pending, 'suspended', 'x', 409],
    [ORG.draft, 'active', null, 409],
    [ORG.closed, 'active', null, 409],
    [ORG.physio, 'closed', 'x', 409],
    [ORG.draft, 'pending_activation', null, 200],
    [ORG.suspended, 'closed', 'غلق نهائي', 200],
    [ORG.physio, 'unknown', null, 400],
  ];
  for (const [id, status, reason, expected] of transitions) {
    const r = await sa.post(`/api/platform/organizations/${id}/status`, { status, reason: reason || undefined });
    assert.equal(r.status, expected, `${id} → ${status}: ${r.text}`);
  }
  const statuses = (await audits('organization.status', ORG.dental)).map((a) => [a.payload.from, a.payload.to]);
  assert.deepEqual(statuses, [['active', 'suspended'], ['suspended', 'active']]);
  assert.equal((await audits('organization.status', ORG.dental))[0].payload.reason, 'لم يتم السداد');
});

test('modules: dependency validation; disabling keeps rows; audited diff', async () => {
  const url = `/api/platform/organizations/${ORG.physio}/modules`;
  const without = PHYSIO_ACTIVE.filter((c) => c !== 'core.appointments');
  const dep = await sa.put(url, { codes: without });
  assert.equal(dep.status, 400);
  assert.equal(dep.body.error.code, 'module_dependency');
  assert.match(dep.body.error.message, /physio\.sessions needs core\.appointments/);
  assert.equal((await sa.put(url, { codes: 'core.patients' })).status, 400);
  assert.equal((await sa.put(url, { codes: [...PHYSIO_ACTIVE, 'dental.chart'] })).body.error.code, 'module_unavailable');

  const fewer = PHYSIO_ACTIVE.filter((c) => !c.startsWith('physio.') && c !== 'core.reports');
  const res = await sa.put(url, { codes: fewer });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.modules.filter((m) => m.enabled).map((m) => m.code).sort(), fewer);
  const resolve = await h.client().get('/api/orgs/resolve?slug=demo-physio');
  assert.deepEqual(resolve.body.modules, fewer);
  const { rows: [{ n }] } = await h.sql('select count(*)::int as n from organization_modules where organization_id = $1', [ORG.physio]);
  assert.equal(n, 11, 'disabled modules keep their rows (BR-007)');
  const [a] = await audits('organization.modules', ORG.physio);
  assert.deepEqual(a.payload.disabled.sort(), ['core.reports', 'physio.sessions', 'physio.templates', 'physio.treatment_plans']);
  assert.deepEqual(a.payload.enabled, []);

  const restore = await sa.put(url, { codes: PHYSIO_ACTIVE });
  assert.equal(restore.status, 200);
  assert.deepEqual((await audits('organization.modules', ORG.physio))[1].payload.enabled.sort(), ['core.reports', 'physio.sessions', 'physio.templates', 'physio.treatment_plans']);
});

test('subscription (manual): validated, history kept, plan_id updated, audited', async () => {
  const url = `/api/platform/organizations/${ORG.dental}/subscription`;
  const { rows: [tiny] } = await h.sql("select id from subscription_plans where code = 'tiny'");
  const bad = [
    [{ plan_id: 'x' }, 'invalid_plan'],
    [{ plan_id: tiny.id, status: 'free' }, 'invalid_status'],
    [{ plan_id: tiny.id, period_start: '2026-13-01' }, 'invalid_date'],
    [{ plan_id: tiny.id, period_start: '2026-10-22', period_end: '2026-10-01' }, 'invalid_date'],
    [{ plan_id: tiny.id, notes: 5 }, 'invalid_notes'],
  ];
  for (const [body, code] of bad) {
    const r = await sa.put(url, body);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.error.code, code);
  }
  const res = await sa.put(url, { plan_id: tiny.id, status: 'trial', period_start: '2026-10-22', period_end: '2026-11-21', notes: 'تجربة شهر' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.organization.plan.code, 'tiny');
  assert.deepEqual(
    { ...res.body.subscription, id: undefined, created_at: undefined },
    { id: undefined, created_at: undefined, plan_id: tiny.id, status: 'trial', period_start: '2026-10-22', period_end: '2026-11-21', notes: 'تجربة شهر', set_by: USER.superAdmin.id },
  );
  const { rows } = await h.sql('select status from subscriptions where organization_id = $1 order by created_at', [ORG.dental]);
  assert.deepEqual(rows.map((r) => r.status), ['active', 'trial'], 'history kept');
  const [a] = await audits('subscription.set', ORG.dental);
  assert.equal(a.payload.plan_code, 'tiny');
});

test('platform invitations for any clinic: first admin of a pending clinic activates it', async () => {
  const url = `/api/platform/organizations/${ORG.pending}/invitations`;
  const susp = await sa.post(`/api/platform/organizations/${ORG.closed}/invitations`, { email: 'a@demo-closed.test', role: 'admin' });
  assert.equal(susp.status, 409);
  assert.equal(susp.body.error.code, 'org_inactive');
  const res = await sa.post(url, { email: 'first.admin@demo-pending.test', role: 'admin' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.invitation.invited_by, USER.superAdmin.id);
  assert.equal(res.body.invitation.email_status, 'sent');
  const list = await sa.get(url);
  assert.deepEqual(list.body.map((i) => i.email), ['first.admin@demo-pending.test']);
  assert.deepEqual(list.body.map((i) => i.email_status), ['sent']);
  // A re-send whose e-mail fails is stored as 'failed' (0008), seen in the list.
  const real = h.app.locals.mailer;
  const origError = console.error;
  h.app.locals.mailer = { send: async () => { throw new Error('SMTP down'); } };
  console.error = () => {};
  try {
    const failed = await sa.post(`${url}/${res.body.invitation.id}/resend`, {});
    assert.equal(failed.status, 200);
    assert.deepEqual([failed.body.email_sent, failed.body.invitation.email_status], [false, 'failed']);
  } finally {
    h.app.locals.mailer = real;
    console.error = origError;
  }
  assert.deepEqual((await sa.get(url)).body.map((i) => i.email_status), ['failed']);
  const resent = await sa.post(`${url}/${res.body.invitation.id}/resend`, {}, { 'x-lang': 'en' });
  assert.equal(resent.status, 200);
  assert.deepEqual([resent.body.email_sent, resent.body.invitation.email_status], [true, 'sent']);
  // Bilingual e-mails, the Super Admin's interface language (X-Lang) first.
  const [firstMail, resentMail] = h.outbox().filter((m) => m.to === 'first.admin@demo-pending.test');
  assert.match(firstMail.subject, /^دعوة للانضمام إلى .+ \/ Invitation to join .+ — ClinicSystem EG$/);
  assert.match(firstMail.text, /بدور: مدير العيادة\.[\s\S]* as Clinic admin\./);
  assert.match(resentMail.subject, /^Invitation to join .+ \/ دعوة للانضمام إلى .+ — ClinicSystem EG$/);
  assert.match(resentMail.html, /^<div dir="ltr" lang="en"/);
  assert.equal((await sa.get(`/api/platform/organizations/${ORG.pending}`)).body.invitations[0].email_status, 'sent');
  const token = tokenFor('first.admin@demo-pending.test');
  assert.equal(h.outbox().filter((m) => m.to === 'first.admin@demo-pending.test').length, 2);

  const accept = await h.client().post(`/api/invitations/${token}/accept`, { password: 'First#2026', name: 'المدير الأول' });
  assert.equal(accept.status, 200, accept.text);
  assert.equal(accept.body.organization.status, 'active');
  assert.deepEqual(accept.body.memberships.map((m) => m.slug), ['demo-pending']);
  const { rows: [org] } = await h.sql('select status from organizations where id = $1', [ORG.pending]);
  assert.equal(org.status, 'active');
  const [act] = await audits('organization.activate', ORG.pending);
  assert.equal(act.payload.from, 'pending_activation');

  const other = await sa.post(url, { email: 'gone@demo-pending.test', role: 'staff', branch_ids: [] });
  assert.equal(other.status, 400, 'non-admin roles need a branch');
  assert.equal(other.body.error.code, 'branch_required');
  const revoke = await sa.post(url, { email: 'gone@demo-pending.test', role: 'admin' });
  assert.equal((await sa.del(`${url}/${revoke.body.invitation.id}`)).status, 204);
  assert.equal((await sa.del(`${url}/${revoke.body.invitation.id}`)).status, 409);
  assert.equal((await sa.del(`/api/platform/organizations/${ORG.physio}/invitations/${revoke.body.invitation.id}`)).status, 404);
});

test('audit: filters (organization, actor, action, prefix, dates), pagination, payload hidden for clinic RPC rows', async () => {
  await h.asSystem(
    `insert into audit_events (organization_id, actor_uid, actor_role, action, table_name, row_pk, payload)
     values ($1, $2, 'receptionist', 'payment_receipt.delete', 'payment_receipts', 'RCT-1', '{"patient":"secret diagnosis"}')`,
    [ORG.physio, USER.physioReception.id],
  );
  const all = await sa.get('/api/platform/audit?limit=200');
  assert.equal(all.status, 200);
  assert.equal(all.body.count, all.body.data.length);
  assert.ok(all.body.count >= 20, `${all.body.count} rows`);
  const times = all.body.data.map((a) => Date.parse(a.created_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

  const rpcRow = all.body.data.find((a) => a.action === 'payment_receipt.delete');
  assert.equal(rpcRow.payload, null, 'clinic RPC payloads may hold patient data: hidden');
  assert.equal(rpcRow.actor_email, USER.physioReception.email);
  assert.equal(rpcRow.organization_slug, 'demo-physio');
  assert.ok(!all.text.includes('secret diagnosis'));
  const platformRow = all.body.data.find((a) => a.action === 'organization.status');
  assert.ok(platformRow.payload && platformRow.payload.to, 'platform payloads are shown');

  const byOrg = await sa.get(`/api/platform/audit?organization_id=${ORG.dental}`);
  assert.ok(byOrg.body.data.length > 0 && byOrg.body.data.every((a) => a.organization_id === ORG.dental));
  const byEmail = await sa.get(`/api/platform/audit?actor=${encodeURIComponent(USER.physioReception.email)}`);
  assert.deepEqual(byEmail.body.data.map((a) => a.action), ['payment_receipt.delete']);
  const byUid = await sa.get(`/api/platform/audit?actor=${USER.superAdmin.id}&action=organization.status`);
  assert.ok(byUid.body.count >= 4);
  assert.ok(byUid.body.data.every((a) => a.action === 'organization.status' && a.actor_uid === USER.superAdmin.id));
  const prefix = await sa.get('/api/platform/audit?action=invitation.*');
  assert.deepEqual([...new Set(prefix.body.data.map((a) => a.action))].sort(), ['invitation.accept', 'invitation.create', 'invitation.resend', 'invitation.revoke']);
  const literal = await sa.get(`/api/platform/audit?action=${encodeURIComponent('invitation_*')}`);
  assert.equal(literal.body.count, 0, '_ is not a wildcard');

  const today = new Date().toISOString().slice(0, 10);
  const day = await sa.get(`/api/platform/audit?from=${today}&to=${today}`);
  assert.equal(day.body.count, all.body.count, 'to=<date> covers the whole day');
  const future = await sa.get('/api/platform/audit?from=2999-01-01');
  assert.equal(future.body.count, 0);
  const pageOne = await sa.get('/api/platform/audit?limit=2');
  const pageTwo = await sa.get('/api/platform/audit?limit=2&offset=2');
  assert.equal(pageOne.body.data.length, 2);
  assert.notEqual(pageOne.body.data[0].id, pageTwo.body.data[0].id);
  assert.equal(pageTwo.body.count, all.body.count);
  for (const q of ['organization_id=x', 'from=yesterday', 'limit=500', 'offset=-1']) {
    assert.equal((await sa.get(`/api/platform/audit?${q}`)).status, 400, q);
  }
  // A clinic admin still reads only their own clinic's rows through /api/data.
  const admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  const own = await admin.data({ table: 'audit_events', action: 'select', columns: 'organization_id' });
  assert.ok(own.body.data.every((r) => r.organization_id === ORG.physio));
});

test('every platform write above wrote audit rows as the Super Admin', async () => {
  const { rows } = await h.asSystem(
    `select action, count(*)::int as n from audit_events
      where actor_role = 'super_admin' and actor_uid = $1 and created_at > now() - interval '1 hour'
        and action not in ('organization_seeded', 'dev_seed_applied')
      group by action order by action`,
    [USER.superAdmin.id],
  );
  const actions = rows.map((r) => r.action);
  for (const a of ['invitation.create', 'invitation.resend', 'invitation.revoke', 'organization.create', 'organization.modules',
    'organization.status', 'organization.update', 'plan.create', 'plan.update', 'subscription.set']) {
    assert.ok(actions.includes(a), `audit ${a}`);
  }
});
