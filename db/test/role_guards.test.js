// Role guards of the security-definer RPCs (plan task 2.9;
// 0007_rpc_role_guards.sql): every RPC the API lets the browser call
// (api/src/rpc-whitelist.js) refuses a caller whose app_role() is NULL (not
// a member of the clinic, a disabled membership) or a role it does not list
// ('staff'), and the billing RPCs record_quick_payment and
// list_invoices_filtered admit admin and receptionist only. The anonymous
// case is in baseline.test.js. Every test runs in a rolled-back transaction.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { RPC_FUNCTIONS } = require('../../api/src/rpc-whitelist');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const rpc = async (c, sql, params = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;
const appRole = async (c) => (await c.query('select public.app_role() as r')).rows[0].r;

// Calls every whitelisted RPC with NULL arguments (the guard is the first
// statement) and returns the ones that did not answer 'غير مصرح'.
async function unguarded(c) {
  const { rows: fns } = await c.query(`
    select p.proname as name,
           array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality a(t, n) order by n) as types
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = any($1)
     order by p.proname`, [RPC_FUNCTIONS]);
  assert.deepEqual(fns.map((f) => f.name), [...RPC_FUNCTIONS].sort(), 'one definition per whitelisted RPC');
  const problems = [];
  for (const f of fns) {
    await c.query('savepoint guard');
    try {
      await c.query(`select public.${f.name}(${f.types.map((t) => `null::${t}`).join(', ')})`);
      problems.push(`${f.name}: no error`);
    } catch (err) {
      if (!/^P0001 غير مصرح/.test(`${err.code} ${err.message}`)) problems.push(`${f.name}: ${err.code} ${err.message}`);
    }
    await c.query('rollback to savepoint guard');
  }
  return problems;
}

test('every whitelisted RPC refuses a member without a usable role: non-member, disabled membership, staff role', async () => {
  await inTx(async (c) => {
    const physio = fx.orgs['demo-physio'];

    // A member of another clinic (and the Super Admin) is no member here.
    await actAs(c, fx, 'admin', 'demo-dental', { org: 'demo-physio' });
    assert.equal(await appRole(c), null);
    assert.deepEqual(await unguarded(c), [], 'admin of demo-dental in demo-physio');
    await actAs(c, fx, 'super', 'demo-physio', { org: 'demo-physio' });
    assert.equal(await appRole(c), null);
    assert.deepEqual(await unguarded(c), [], 'Super Admin in demo-physio');

    // A disabled membership has no role (app_role() checks the status).
    await setContext(c, { system: true });
    await c.query(`update organization_members set status = 'disabled' where organization_id = $1 and user_id = $2`,
      [physio, fx.user('receptionist', 'demo-physio')]);
    await actAs(c, fx, 'receptionist', 'demo-physio');
    assert.equal(await appRole(c), null);
    assert.deepEqual(await unguarded(c), [], 'disabled receptionist');

    // 'staff' is a role no RPC lists (0006).
    await setContext(c, { system: true });
    await c.query(`update organization_members set role = 'staff' where organization_id = $1 and user_id = $2`,
      [physio, fx.user('doctor', 'demo-physio')]);
    await actAs(c, fx, 'doctor', 'demo-physio');
    assert.equal(await appRole(c), 'staff');
    assert.deepEqual(await unguarded(c), [], 'staff member');
  });
});

test('billing RPCs (record_quick_payment, list_invoices_filtered): admin and receptionist only', async () => {
  for (const [slug, code] of [['demo-physio', 'PHY'], ['demo-dental', 'DEN']]) {
    await inTx(async (c) => {
      const invoice = `INV-${code}-B1-1`;
      const paidOf = async () => {
        await setContext(c, { system: true });
        const { rows: [r] } = await c.query('select paid from invoices where invoice_id = $1', [invoice]);
        return Number(r.paid);
      };
      const before = await paidOf();
      const pay = `public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash')`;
      const args = [`P-${code}-01`, JSON.stringify([{ type: 'invoice', id: invoice, amount: 10 }])];

      for (const role of ['doctor', 'therapist']) {
        await actAs(c, fx, role, slug);
        await expectError(c, 'select public.list_invoices_filtered()', [], /^P0001 غير مصرح/);
        await expectError(c, `select ${pay}`, args, /^P0001 غير مصرح/);
      }
      assert.equal(await paidOf(), before, 'a refused payment changes nothing');

      await actAs(c, fx, 'receptionist', slug); // branch 1
      const recep = await rpc(c, 'public.list_invoices_filtered(p_limit => 500)');
      assert.ok(recep.rows.some((r) => r.invoice_id === invoice));
      assert.ok(recep.rows.every((r) => !r.invoice_id.includes('-B2-')), 'branch_scope still applies');

      await actAs(c, fx, 'admin', slug);
      const all = await rpc(c, 'public.list_invoices_filtered(p_limit => 500)');
      assert.ok(all.rows.some((r) => r.invoice_id === `INV-${code}-B2-1`), 'the admin sees every branch');
      const paid = await rpc(c, pay, args);
      assert.equal(Number(paid.amount), 10);
      assert.equal(await paidOf(), before + 10);
    });
  }
});
