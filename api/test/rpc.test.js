'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const { setup, USER, ORG } = require('./helpers');
const { RPC_FUNCTIONS } = require('../src/rpc-whitelist');

let h;
let admin;
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio', branch: 'br-physio-east' });
});
after(async () => {
  await h.close();
});

test('the whitelist is exactly the functions src/*.jsx calls with .rpc()', () => {
  const root = path.resolve(__dirname, '..', '..');
  const out = execSync(`grep -ohE "\\.rpc\\(\\s*['\\"][a-z_0-9]+" ${path.join(root, 'src')}/*.jsx`, { encoding: 'utf8' });
  const called = [...new Set(out.split('\n').filter(Boolean).map((l) => l.replace(/^\.rpc\(\s*['"]/, '')))].sort();
  assert.deepEqual([...RPC_FUNCTIONS].sort(), called);
});

test('not whitelisted → 404 even if the function exists; whitelisted but missing → 404', async () => {
  const exists = await admin.rpc('create_treatment_method', {});
  assert.equal(exists.status, 404);
  assert.equal(exists.body.error.code, 'rpc_not_allowed');
  for (const fn of ['app_role', 'pg_sleep', 'set_config', 'get_treatment;drop', 'GET_TREATMENT']) {
    const r = await admin.rpc(encodeURIComponent(fn), {});
    assert.equal(r.status, 404, fn);
  }
  const missing = await admin.rpc('duplicate_treatment_template', { p_template_id: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'function_not_found');
});

test('runs inside the request context (user, clinic, branch, role)', async () => {
  const res = await admin.rpc('get_treatment', { p_treatment_id: 'T-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    treatment_id: 'T-1',
    user_id: USER.physioAdmin.id,
    org_id: ORG.physio,
    branch_id: 'br-physio-east',
    role: 'admin',
  });
});

test('named arguments are validated against pg_proc', async () => {
  const unknown = await admin.rpc('get_treatment', { p_treatment_id: 'T-1', p_extra: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'invalid_args');
  const missing = await admin.rpc('get_treatment', {});
  assert.equal(missing.status, 400);
  const badName = await admin.rpc('get_treatment', { 'p_treatment_id") or (1=1': 'x' });
  assert.equal(badName.status, 400);
  const notObject = await admin.post('/api/rpc/get_treatment', { args: ['T-1'] });
  assert.equal(notObject.status, 400);
  const withDefaults = await admin.rpc('list_treatments', {});
  assert.equal(withDefaults.status, 200, 'arguments with defaults may be omitted');
});

test('set-returning functions → array of rows; RLS still applies inside security definer', async () => {
  const res = await admin.rpc('list_treatments', { p_limit: 2 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    { patient_id: 'P-PHY-1', name: 'Ahmed Ali' },
    { patient_id: 'P-PHY-2', name: 'Mona Hassan' },
  ]);
  const cross = await admin.rpc('list_treatments', { p_patient_id: 'P-DEN-1' });
  assert.deepEqual(cross.body, [], 'another clinic\'s patient is invisible');
  const dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
  assert.deepEqual((await dental.rpc('list_treatments', {})).body, [{ patient_id: 'P-DEN-1', name: 'Dental Only' }]);
});

test('setof scalar → array of values; scalar → value; void → null; composite → object or null', async () => {
  const names = await admin.rpc('list_template_categories', {});
  assert.deepEqual(names.body, ['Mona Hassan', 'Omar Said']);
  const all = await admin.rpc('list_template_categories', { p_include_archived: true });
  assert.deepEqual(all.body, ['Ahmed Ali', 'Mona Hassan', 'Omar Said']);

  const safe = await admin.rpc('list_invoices_filtered', { p_limit: 5 });
  assert.equal(safe.body, 9007199254740005, 'int8 → JSON number while exact');
  const unsafe = await admin.rpc('list_invoices_filtered', { p_limit: 1000 });
  assert.equal(unsafe.body, '9007199254741000', 'int8 beyond 2^53 stays a string (no silent rounding)');

  const v = await admin.rpc('delete_treatment', { p_treatment_id: 'T-1' });
  assert.equal(v.status, 200);
  assert.equal(v.body, null);

  const row = await admin.rpc('get_treatment_template', { p_template_id: 'P-PHY-1' });
  assert.equal(row.body.patient_id, 'P-PHY-1');
  assert.equal(row.body.balance, 150.5);
  assert.deepEqual(row.body.meta, { source: 'walk-in' });
  const none = await admin.rpc('get_treatment_template', { p_template_id: 'P-DEN-1' });
  assert.equal(none.status, 200);
  assert.equal(none.body, null);
});

test('jsonb arguments arrive as JSON (arrays are not turned into PostgreSQL arrays)', async () => {
  const allocations = [{ invoice_id: 'I-1', amount: 100 }, { invoice_id: 'I-2', amount: 50.5 }];
  const res = await admin.rpc('record_quick_payment', { p_patient_id: 'P-PHY-1', p_allocations: allocations, p_method: 'cash' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    patient_id: 'P-PHY-1',
    allocations,
    allocations_type: 'array',
    method: 'cash',
    reference: null,
  });
});

test('overloads are chosen by argument names', async () => {
  const patch = await admin.rpc('update_treatment', { p_treatment_id: 'T-9', p_patch: { status: 'done' } });
  assert.equal(patch.body, 'patch:T-9:done');
  const status = await admin.rpc('update_treatment', { p_treatment_id: 'T-9', p_status: 'paused' });
  assert.equal(status.body, 'status:T-9:paused:-');
  const both = await admin.rpc('update_treatment', { p_treatment_id: 'T-9', p_status: 'paused', p_note: 'n' });
  assert.equal(both.body, 'status:T-9:paused:n');
  const neither = await admin.rpc('update_treatment', { p_treatment_id: 'T-9' });
  assert.equal(neither.status, 400);
});

test('error mapping: PL422 → 422, 23505 → 409, 42501 → 403, RAISE → 400', async () => {
  const call = (method) => admin.rpc('record_quick_payment', { p_patient_id: 'P-PHY-1', p_allocations: [], p_method: method });
  const limit = await call('over-limit');
  assert.equal(limit.status, 422);
  assert.deepEqual(limit.body, { error: { message: 'Plan limit reached', code: 'PL422' } });
  assert.equal((await call('duplicate')).status, 409);
  assert.equal((await call('forbidden')).status, 403);
  const business = await call('business');
  assert.equal(business.status, 400);
  assert.deepEqual(business.body, { error: { message: 'Amount exceeds the balance', code: 'P0001' } });
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
