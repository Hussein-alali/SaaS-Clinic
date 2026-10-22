'use strict';
// Disabled clinic modules on the data routes (docs/01-PRD.md AT-07):
// /api/data and /api/rpc refuse the tables and functions of a module the
// clinic has not enabled (403 module_disabled); the rows stay, and enabling
// the module again gives them back (api/src/modules.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ORG } = require('./helpers');

let h;
let sa; // Super Admin (platform context)
let admin; // demo-physio admin
let recep; // demo-physio receptionist, branch 1
before(async () => {
  h = await setup();
  sa = await h.as('superAdmin', { platform: true });
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  recep = await h.as('physioReception', { slug: 'demo-physio', branch: 'br-demo-physio-1' });
});
after(async () => {
  await h.close();
});

async function enabledCodes(orgId) {
  const res = await sa.get(`/api/platform/organizations/${orgId}`);
  assert.equal(res.status, 200, res.text);
  return res.body.modules.filter((m) => m.enabled).map((m) => m.code);
}
async function setModules(orgId, codes) {
  const res = await sa.put(`/api/platform/organizations/${orgId}/modules`, { codes });
  assert.equal(res.status, 200, res.text);
}
const invoiceCount = async () =>
  Number((await h.asSystem('select count(*) from invoices where organization_id = $1', [ORG.physio])).rows[0].count);

test('core.billing turned off: its tables and functions are refused (403 module_disabled), the rows are kept, and come back when it is on again (AT-07)', async () => {
  const before = await enabledCodes(ORG.physio);
  assert.ok(before.includes('core.billing'));
  const on = await admin.data({ table: 'invoices', count: 'exact' });
  assert.equal(on.status, 200);
  const rowsBefore = await invoiceCount();
  assert.ok(rowsBefore > 0);

  await setModules(ORG.physio, before.filter((c) => c !== 'core.billing'));
  try {
    for (const table of ['invoices', 'payments', 'payment_receipts', 'packages', 'patient_subscriptions']) {
      const r = await admin.data({ table });
      assert.equal(r.status, 403, `${table}: ${r.text}`);
      assert.equal(r.body.error.code, 'module_disabled', table);
    }
    // Writes too, for every role.
    const ins = await recep.data({ table: 'invoices', action: 'insert', values: { invoice_id: 'INV-MOD-OFF', patient_id: 'P-PHY-01', amount: 10 } });
    assert.equal(ins.status, 403);
    assert.equal(ins.body.error.code, 'module_disabled');
    const del = await admin.data({ table: 'invoices', action: 'delete', filters: [{ column: 'invoice_id', op: 'eq', value: 'INV-PHY-B1-1' }] });
    assert.equal(del.status, 403);
    for (const [fn, args] of [
      ['list_invoices_filtered', {}],
      ['record_quick_payment', { p_patient_id: 'P-PHY-01', p_allocations: [], p_method: 'cash' }],
      ['delete_payment_receipt', { p_receipt_id: 'PRC-PHY-B1-1' }],
    ]) {
      const r = await recep.rpc(fn, args);
      assert.equal(r.status, 403, `${fn}: ${r.text}`);
      assert.equal(r.body.error.code, 'module_disabled', fn);
    }
    // Other modules and the shared tables still work.
    assert.equal((await admin.data({ table: 'patients' })).status, 200);
    assert.equal((await admin.data({ table: 'bookings' })).status, 200);
    assert.equal((await admin.data({ table: 'staff' })).status, 200);
    assert.equal((await admin.data({ table: 'branches' })).status, 200);
    assert.equal((await admin.rpc('list_treatments', {})).status, 200);
    // Nothing was deleted.
    assert.equal(await invoiceCount(), rowsBefore);
  } finally {
    await setModules(ORG.physio, before);
  }
  const back = await admin.data({ table: 'invoices', count: 'exact' });
  assert.equal(back.status, 200);
  assert.equal(back.body.count, on.body.count);
});

test('a module the clinic never had (physio.* in the dental clinic) is refused; its core modules work', async () => {
  const codes = await enabledCodes(ORG.dental);
  assert.ok(!codes.includes('physio.sessions') && !codes.includes('physio.treatment_plans'));
  const dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
  const s = await dental.data({ table: 'sessions' });
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'module_disabled');
  const t = await dental.rpc('list_treatments', {});
  assert.equal(t.status, 403);
  assert.equal(t.body.error.code, 'module_disabled');
  const tpl = await dental.rpc('list_treatment_templates', {});
  assert.equal(tpl.status, 403);
  assert.equal((await dental.data({ table: 'patients' })).status, 200);
  assert.equal((await dental.data({ table: 'invoices' })).status, 200);
});

test('the check is per request: a module turned off mid-session is refused on the very next call', async () => {
  const before = await enabledCodes(ORG.physio);
  // physio.templates depends on physio.treatment_plans: turn both off together.
  const off = before.filter((c) => c !== 'physio.templates' && c !== 'physio.treatment_plans');
  assert.equal((await admin.rpc('list_treatments', {})).status, 200);
  await setModules(ORG.physio, off);
  try {
    const r = await admin.rpc('list_treatments', {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'module_disabled');
    assert.equal((await admin.data({ table: 'treatments' })).status, 403);
    assert.equal((await admin.data({ table: 'treatment_templates' })).status, 403);
    assert.equal((await admin.data({ table: 'sessions' })).status, 200, 'physio.sessions is still on');
  } finally {
    await setModules(ORG.physio, before);
  }
  assert.equal((await admin.rpc('list_treatments', {})).status, 200);
});
