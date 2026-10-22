'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const { setup, newRecordId, USER, ORG, BRANCH } = require('./helpers');
const { RPC_FUNCTIONS, RPC_WHITELIST } = require('../src/rpc-whitelist');

// Every RPC of the real schema returns one jsonb value. The generic result
// shapes /api/rpc also supports (set of rows, set of scalars, void, one
// composite row, int8, overloads) are exercised with test-only functions
// that are added to the whitelist for this file only.
const TEST_FUNCTIONS = ['apitest_rows', 'apitest_names', 'apitest_void', 'apitest_patient', 'apitest_int8', 'apitest_overload', 'apitest_raise'];

let h;
let admin; // physio admin, X-Branch-Id: branch 2
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio', branch: BRANCH.physio2 });
  await h.sql(`
    create function public.apitest_rows(p_limit int default 200)
    returns table (patient_id text, name text)
    language sql stable security definer set search_path = public as $$
      select p.patient_id, p.name from patients p order by p.patient_id limit p_limit $$;
    create function public.apitest_names(p_males_only boolean default false) returns setof text
    language sql stable security definer set search_path = public as $$
      select p.patient_id from patients p where not p_males_only or p.gender = 'M' order by 1 $$;
    create function public.apitest_void(p_x text) returns void language plpgsql as $$ begin perform 1; end $$;
    create function public.apitest_patient(p_id text) returns patients
    language sql stable security definer set search_path = public as $$
      select * from patients where patient_id = p_id $$;
    create function public.apitest_int8(p_add int default 0) returns bigint
    language sql immutable as $$ select 9007199254740000::bigint + p_add $$;
    create function public.apitest_overload(p_id text, p_patch jsonb) returns text
    language sql immutable as $$ select 'patch:' || p_id || ':' || (p_patch ->> 'status') $$;
    create function public.apitest_overload(p_id text, p_status text, p_note text default null) returns text
    language sql immutable as $$ select 'status:' || p_id || ':' || p_status || ':' || coalesce(p_note, '-') $$;
    create function public.apitest_raise(p_code text) returns jsonb language plpgsql as $$
    begin
      if p_code = 'PL422' then raise exception 'plan_limit:users' using errcode = 'PL422'; end if;
      raise exception 'raised %', p_code using errcode = p_code;
    end $$;`);
  TEST_FUNCTIONS.forEach((fn) => RPC_WHITELIST.add(fn));
});
after(async () => {
  TEST_FUNCTIONS.forEach((fn) => RPC_WHITELIST.delete(fn));
  await h.close();
});

test('the whitelist is exactly the functions src/*.jsx calls with .rpc(), and all of them exist', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const out = execSync(`grep -ohE "\\.rpc\\(\\s*['\\"][a-z_0-9]+" ${path.join(root, 'src')}/*.jsx`, { encoding: 'utf8' });
  const called = [...new Set(out.split('\n').filter(Boolean).map((l) => l.replace(/^\.rpc\(\s*['"]/, '')))].sort();
  assert.deepEqual([...RPC_FUNCTIONS].sort(), called);
  const { rows } = await h.sql(
    "select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)",
    [RPC_FUNCTIONS],
  );
  assert.deepEqual(rows.map((r) => r.proname).sort(), [...RPC_FUNCTIONS].sort(), 'one function per whitelisted name');
  assert.ok(rows.every((r) => r.prosecdef), 'all are security definer (convention 12)');
});

test('not whitelisted → 404 even if the function exists; whitelisted but missing → 404', async () => {
  const exists = await admin.rpc('create_treatment_method', {});
  assert.equal(exists.status, 404);
  assert.equal(exists.body.error.code, 'rpc_not_allowed');
  for (const fn of ['app_role', 'can_access_branch', 'enforce_branch_limit', 'pg_sleep', 'set_config', 'get_treatment;drop', 'GET_TREATMENT']) {
    const r = await admin.rpc(encodeURIComponent(fn), {});
    assert.equal(r.status, 404, fn);
  }
  await h.sql('alter function public.duplicate_treatment_template(text, text) rename to duplicate_treatment_template_off');
  try {
    const missing = await admin.rpc('duplicate_treatment_template', { p_template_id: 'x', p_new_name: 'y' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'function_not_found');
  } finally {
    await h.sql('alter function public.duplicate_treatment_template_off(text, text) rename to duplicate_treatment_template');
  }
});

test('runs inside the request context: clinic, branch and user reach the rows the RPC writes', async () => {
  const id = newRecordId('TRT-');
  const res = await admin.rpc('create_treatment', {
    p_treatment_id: id,
    p_payload: { patient_id: 'P-PHY-03', therapist_id: 'TH-PHY-2', name: 'خطة من الاختبار', goals: ['مرونة'] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.treatment_id, id);
  assert.equal(res.body.organization_id, ORG.physio, 'DEFAULT app_org_id()');
  assert.equal(res.body.branch_id, BRANCH.physio2, 'DEFAULT app_branch_id() = X-Branch-Id');
  assert.equal(res.body.created_by, USER.physioAdmin.id, 'auth.uid()');
  assert.equal(res.body.created_by_name, 'مدير العيادة — PHY');
  assert.deepEqual(res.body.goals, ['مرونة']);
  const audit = await admin.data({ table: 'audit_events', filters: [{ column: 'row_pk', op: 'eq', value: id }], single: 'single' });
  assert.equal(audit.body.data.actor_role, 'admin', 'app_role() inside the RPC');
  assert.equal(audit.body.data.organization_id, ORG.physio);
});

test('named arguments are validated against pg_proc', async () => {
  const unknown = await admin.rpc('get_treatment', { p_treatment_id: 'TRT-PHY-B1-1', p_extra: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'invalid_args');
  const missing = await admin.rpc('get_treatment', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'invalid_args');
  const badName = await admin.rpc('get_treatment', { 'p_treatment_id") or (1=1': 'x' });
  assert.equal(badName.status, 400);
  const notObject = await admin.post('/api/rpc/get_treatment', { args: ['TRT-PHY-B1-1'] });
  assert.equal(notObject.status, 400);
  const withDefaults = await admin.rpc('list_treatments', {});
  assert.equal(withDefaults.status, 200, 'arguments with defaults may be omitted');
  assert.equal(withDefaults.body.limit, 200);
});

test('RLS still applies inside security definer RPCs: other clinics and other branches are invisible', async () => {
  const mine = await admin.rpc('list_treatments', { p_limit: 50 });
  assert.equal(mine.status, 200);
  const ids = mine.body.rows.map((r) => r.treatment_id);
  assert.ok(ids.includes('TRT-PHY-B1-1') && ids.includes('TRT-PHY-B2-1'));
  assert.ok(ids.every((t) => !t.startsWith('TRT-DEN-')), ids.join());
  const cross = await admin.rpc('list_treatments', { p_patient_id: 'P-DEN-01' });
  assert.deepEqual(cross.body.rows, [], "another clinic's patient is invisible");
  const crossGet = await admin.rpc('get_treatment', { p_treatment_id: 'TRT-DEN-B1-1' });
  assert.equal(crossGet.status, 200);
  assert.equal(crossGet.body, null, "another clinic's treatment reads as not found");

  const dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
  const d = await dental.rpc('list_treatments', {});
  assert.deepEqual(d.body.rows.map((r) => r.treatment_id).sort(), ['TRT-DEN-B1-1', 'TRT-DEN-B2-1']);

  // the therapist works in branch 1 only (branch_scope)
  const therapist = await h.as('physioTherapist', { slug: 'demo-physio' });
  const t = await therapist.rpc('list_treatments', {});
  assert.deepEqual(t.body.rows.map((r) => r.treatment_id), ['TRT-PHY-B1-1']);

  // global template library + the clinic's own templates, never the other clinic's
  const tpl = await admin.rpc('list_treatment_templates', { p_limit: 500 });
  assert.equal(tpl.status, 200);
  const tplIds = tpl.body.rows.map((r) => r.template_id);
  assert.ok(tplIds.includes('TPL-PHY-1') && tplIds.includes('TPL-SEED-SPN-01'));
  assert.ok(!tplIds.includes('TPL-DEN-1'));
});

test('role guards inside the RPCs answer 400 with their message', async () => {
  const recep = await h.as('physioReception', { slug: 'demo-physio' });
  const denied = await recep.rpc('list_treatments', {});
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.body, { error: { message: 'غير مصرح', code: 'P0001' } });
});

test('record_quick_payment: jsonb allocations arrive as JSON; payment lands in the clinic and branch', async () => {
  const recep = await h.as('physioReception', { slug: 'demo-physio' });
  const allocations = [{ type: 'invoice', id: 'INV-PHY-B1-1', amount: 100.5 }];
  const res = await recep.rpc('record_quick_payment', {
    p_patient_id: 'P-PHY-01',
    p_allocations: allocations,
    p_method: 'cash',
    p_cashier_name: 'موظف الاستقبال',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.amount, 100.5);
  assert.match(res.body.payment_id, /^PMT-/);
  const pay = await recep.data({ table: 'payments', filters: [{ column: 'payment_id', op: 'eq', value: res.body.payment_id }], single: 'single' });
  assert.deepEqual(pay.body.data.allocations, allocations, 'a JSON array, not a PostgreSQL array');
  assert.equal(pay.body.data.organization_id, ORG.physio);
  assert.equal(pay.body.data.branch_id, BRANCH.physio1);
  const inv = await recep.data({ table: 'invoices', filters: [{ column: 'invoice_id', op: 'eq', value: 'INV-PHY-B1-1' }], single: 'single' });
  assert.equal(inv.body.data.paid, 100.5);
  assert.equal(inv.body.data.status, 'partial');

  const tooMuch = await recep.rpc('record_quick_payment', { p_patient_id: 'P-PHY-01', p_allocations: [{ type: 'invoice', id: 'INV-PHY-B1-1', amount: 10000 }], p_method: 'cash' });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error.message, /exceeds remaining/);
  // the other clinic's invoice does not exist here
  const cross = await recep.rpc('record_quick_payment', { p_patient_id: 'P-DEN-01', p_allocations: [{ type: 'invoice', id: 'INV-DEN-B1-1', amount: 1 }], p_method: 'cash' });
  assert.equal(cross.status, 400);
  assert.match(cross.body.error.message, /patient P-DEN-01 not found/);
});

test('generic shapes: set of rows → array; set of scalars → array; void → null; composite → object or null; int8', async () => {
  const rows = await admin.rpc('apitest_rows', { p_limit: 2 });
  assert.equal(rows.status, 200);
  assert.deepEqual(rows.body, [
    { patient_id: 'P-PHY-01', name: 'مريض أول — PHY' },
    { patient_id: 'P-PHY-02', name: 'مريضة ثانية — PHY' },
  ]);
  assert.deepEqual((await admin.rpc('apitest_names', { p_males_only: true })).body, ['P-PHY-01', 'P-PHY-03']);
  const v = await admin.rpc('apitest_void', { p_x: 'x' });
  assert.equal(v.status, 200);
  assert.equal(v.body, null);
  const row = await admin.rpc('apitest_patient', { p_id: 'P-PHY-02' });
  assert.equal(row.body.patient_id, 'P-PHY-02');
  assert.equal(row.body.organization_id, ORG.physio);
  const none = await admin.rpc('apitest_patient', { p_id: 'P-DEN-01' });
  assert.equal(none.status, 200);
  assert.equal(none.body, null, 'a row of another clinic is a NULL row');
  assert.equal((await admin.rpc('apitest_int8', { p_add: 5 })).body, 9007199254740005, 'int8 → JSON number while exact');
  assert.equal((await admin.rpc('apitest_int8', { p_add: 1000 })).body, '9007199254741000', 'int8 beyond 2^53 stays a string');
});

test('overloads are chosen by argument names', async () => {
  assert.equal((await admin.rpc('apitest_overload', { p_id: 'T-9', p_patch: { status: 'done' } })).body, 'patch:T-9:done');
  assert.equal((await admin.rpc('apitest_overload', { p_id: 'T-9', p_status: 'paused' })).body, 'status:T-9:paused:-');
  assert.equal((await admin.rpc('apitest_overload', { p_id: 'T-9', p_status: 'paused', p_note: 'n' })).body, 'status:T-9:paused:n');
  assert.equal((await admin.rpc('apitest_overload', { p_id: 'T-9' })).status, 400);
});

test('error mapping: PL422 → 422, 23505 → 409, 42501 → 403, 23503 → 400, RAISE → 400', async () => {
  const call = (code) => admin.rpc('apitest_raise', { p_code: code });
  const limit = await call('PL422');
  assert.equal(limit.status, 422);
  assert.deepEqual(limit.body, { error: { message: 'plan_limit:users', code: 'PL422' } });
  assert.equal((await call('23505')).status, 409);
  assert.equal((await call('42501')).status, 403);
  assert.equal((await call('23503')).status, 400);
  const business = await call('P0001');
  assert.equal(business.status, 400);
  assert.deepEqual(business.body, { error: { message: 'raised P0001', code: 'P0001' } });
  // server-side classes never leak their message
  const server = await call('XX000');
  assert.equal(server.status, 500);
  assert.deepEqual(server.body, { error: { message: 'Database error', code: 'XX000' } });
});

test('rpc needs the CSRF header, a session and a clinic membership', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  assert.equal((await h.client({ cookie, slug: 'demo-physio', csrf: false }).rpc('get_treatment', { p_treatment_id: 'x' })).status, 403);
  assert.equal((await h.client({ slug: 'demo-physio' }).rpc('get_treatment', { p_treatment_id: 'x' })).status, 401);
  const outsider = await h.as('outsider', { slug: 'demo-physio' });
  assert.equal((await outsider.rpc('get_treatment', { p_treatment_id: 'x' })).status, 403);
  const get = await h.client({ cookie, slug: 'demo-physio' }).get('/api/rpc/get_treatment');
  assert.equal(get.status, 404, 'POST only');
});
