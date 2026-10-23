// The 0001 RPC functions under tenant context (plan task 2.4; docs/05
// convention 12): security-definer functions run as the table owner, who is
// subject to FORCE ROW LEVEL SECURITY, so they act with the caller's role,
// clinic and branch, and the rows they write get organization_id /
// branch_id from the context. Called with the same named arguments as
// src/supabase.jsx (sb.rpc(...)).
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const CLINICS = [
  { slug: 'demo-physio', code: 'PHY', other: 'demo-dental', otherCode: 'DEN' },
  { slug: 'demo-dental', code: 'DEN', other: 'demo-physio', otherCode: 'PHY' },
];
const rpc = async (c, sql, params = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;

async function rowOf(c, table, where, params) {
  const saved = (await c.query(`select current_setting('app.user_id', true) u, current_setting('app.org_id', true) o,
                                       current_setting('app.branch_id', true) b`)).rows[0];
  await setContext(c, { system: true });
  const { rows } = await c.query(`select * from ${table} where ${where}`, params);
  await setContext(c, { user: saved.u, org: saved.o, branch: saved.b });
  return rows;
}

test('record_quick_payment: writes the payment in the caller\'s clinic and branch', async () => {
  for (const k of CLINICS) {
    await inTx(async (c) => {
      const s = suffix();
      const org = fx.orgs[k.slug];
      const b1 = fx.branches[k.slug][0];
      const b2 = fx.branches[k.slug][1];
      await actAs(c, fx, 'receptionist', k.slug); // branch 1
      const patient = `P-${k.code}-01`;
      const booking = `BK-T-${s}`;
      const invoice = `INV-T-${s}`;
      await c.query(`insert into bookings (booking_id, patient_id, date, time, price) values ($1, $2, current_date, '10:00', 500)`, [booking, patient]);
      await c.query(`insert into invoices (invoice_id, patient_id, amount) values ($1, $2, 300)`, [invoice, patient]);

      const allocations = [{ type: 'appointment', id: booking, amount: 200 }, { type: 'invoice', id: invoice, amount: 300 }];
      const pay = await rpc(c, `public.record_quick_payment(
          p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash', p_reference => null,
          p_transaction_id => null, p_notes => 'rpc test', p_cashier_id => $3, p_cashier_name => 'test', p_ip_address => '127.0.0.1')`,
      [patient, JSON.stringify(allocations), `ST-${k.code}-RECEPTIONIST`]);
      assert.match(pay.payment_id, /^PMT-/);
      assert.equal(Number(pay.amount), 500);

      const [p] = await rowOf(c, 'payments', 'payment_id = $1', [pay.payment_id]);
      assert.deepEqual([p.organization_id, p.branch_id, p.patient_id, Number(p.amount)], [org, b1, patient, 500]);
      const [bk] = await rowOf(c, 'bookings', 'booking_id = $1', [booking]);
      assert.deepEqual([Number(bk.paid), bk.payment_status], [200, 'partial']);
      const [inv] = await rowOf(c, 'invoices', 'invoice_id = $1', [invoice]);
      assert.deepEqual([Number(inv.paid), inv.status], [300, 'paid']);
      const audit = await rowOf(c, 'audit_events', `action = 'quick_payment' and row_pk = $1`, [pay.payment_id]);
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].organization_id, audit[0].actor_role, audit[0].result],
        [org, 'receptionist', 'success']);

      // Branch 2 and the other clinic are out of reach.
      await expectError(c, `select public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash')`,
        [`P-${k.code}-03`, JSON.stringify([{ type: 'appointment', id: `BK-${k.code}-B2-1`, amount: 10 }])],
        /appointment BK-\w+-B2-1 not found/);
      await expectError(c, `select public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash')`,
        [`P-${k.otherCode}-01`, JSON.stringify([{ type: 'appointment', id: `BK-${k.otherCode}-B1-1`, amount: 10 }])],
        /patient P-\w+-01 not found/);

      // The admin, working in branch 2, records a branch-2 payment.
      await actAs(c, fx, 'admin', k.slug, { branch: 2 });
      const pay2 = await rpc(c, `public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'card')`,
        [`P-${k.code}-03`, JSON.stringify([{ type: 'appointment', id: `BK-${k.code}-B2-1`, amount: 50 }])]);
      const [p2] = await rowOf(c, 'payments', 'payment_id = $1', [pay2.payment_id]);
      assert.deepEqual([p2.organization_id, p2.branch_id], [org, b2]);

      // Payments are written by admin/receptionist only (0001 policies; under
      // Supabase the RPC bypassed them), and since 0007 the RPC itself
      // refuses the other roles first.
      await actAs(c, fx, 'doctor', k.slug);
      await expectError(c, `select public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash')`,
        [patient, JSON.stringify([{ type: 'appointment', id: booking, amount: 10 }])], /^P0001 غير مصرح/);
    });
  }
});

test('treatment-template RPCs: global library + own templates, writes stay in the clinic', async () => {
  for (const k of CLINICS) {
    await inTx(async (c) => {
      const org = fx.orgs[k.slug];
      await actAs(c, fx, 'doctor', k.slug);

      const all = await rpc(c, `public.list_treatment_templates(p_limit => 500)`);
      const ids = all.rows.map((r) => r.template_id);
      assert.equal(all.count, 50, '49 global + 1 own');
      assert.ok(ids.includes(`TPL-${k.code}-1`) && ids.includes('TPL-SEED-SPN-01'));
      assert.ok(!ids.includes(`TPL-${k.otherCode}-1`), 'another clinic\'s template is listed');

      // create -> get -> update -> duplicate -> archive -> delete
      const created = await rpc(c, `public.create_treatment_template(p_template_id => null, p_payload => $1::jsonb)`,
        [JSON.stringify({ name: `قالب اختبار ${k.code}`, category: 'قوالب خاصة بالعيادة', created_by_name: 'doctor' })]);
      const id = created.template_id;
      const [row] = await rowOf(c, 'treatment_templates', 'template_id = $1', [id]);
      assert.equal(row.organization_id, org);
      const got = await rpc(c, `public.get_treatment_template(p_template_id => $1)`, [id]);
      assert.equal(got.template.template_id, id);

      await rpc(c, `public.update_treatment_template(p_template_id => $1, p_payload => $2::jsonb, p_change_summary => 'test')`,
        [id, JSON.stringify({ name: 'اسم معدل', updated_by_name: 'doctor' })]);
      assert.equal((await rowOf(c, 'treatment_templates', 'template_id = $1', [id]))[0].name, 'اسم معدل');
      const dup = await rpc(c, `public.duplicate_treatment_template(p_template_id => 'TPL-SEED-SPN-01', p_new_name => 'نسختي')`);
      const [copy] = await rowOf(c, 'treatment_templates', 'template_id = $1', [dup.template_id]);
      assert.deepEqual([copy.organization_id, copy.name], [org, 'نسختي'], 'a copy of a global template belongs to the clinic');
      await rpc(c, `public.set_treatment_template_status(p_template_id => $1, p_status => 'archived')`, [id]);
      assert.equal((await rowOf(c, 'treatment_templates', 'template_id = $1', [id]))[0].status, 'archived');
      await rpc(c, `public.set_treatment_template_status(p_template_id => $1, p_status => 'active')`, [id]);
      const del = await rpc(c, `public.delete_treatment_template(p_template_id => $1)`, [dup.template_id]);
      assert.equal(del.deleted, true);
      assert.equal((await rowOf(c, 'treatment_templates', 'template_id = $1', [dup.template_id])).length, 0);

      // Global templates: readable, applicable, not writable.
      assert.equal((await rpc(c, `public.get_treatment_template(p_template_id => 'TPL-SEED-SPN-02')`)).template.template_id, 'TPL-SEED-SPN-02');
      await expectError(c, `select public.update_treatment_template('TPL-SEED-SPN-02', '{"name":"x"}'::jsonb, 'x')`, [], /قالب عام/);
      await expectError(c, `select public.set_treatment_template_status('TPL-SEED-SPN-02', 'archived')`, [], /القالب غير موجود/);
      await expectError(c, `select public.delete_treatment_template('TPL-SEED-SHD-14')`, [], /قالب عام/);
      // Another clinic's template does not exist from here.
      assert.equal(await rpc(c, `public.get_treatment_template(p_template_id => $1)`, [`TPL-${k.otherCode}-1`]), null);
      await expectError(c, `select public.update_treatment_template($1, '{"name":"x"}'::jsonb, 'x')`, [`TPL-${k.otherCode}-1`], /القالب غير موجود/);
      await expectError(c, `select public.delete_treatment_template($1)`, [`TPL-${k.otherCode}-1`], /القالب غير موجود/);

      // apply_template_to_patient (global template, therapist): usage row in the clinic.
      await actAs(c, fx, 'therapist', k.slug);
      const use = await rpc(c, `public.apply_template_to_patient(p_template_id => 'TPL-SEED-SPN-03', p_patient_id => $1, p_plan_id => null)`,
        [`P-${k.code}-02`]);
      const [u] = await rowOf(c, 'template_usage', 'use_id = $1', [use.use_id]);
      assert.deepEqual([u.organization_id, u.template_id], [org, 'TPL-SEED-SPN-03']);
      const stats = await rpc(c, `public.get_treatment_template(p_template_id => 'TPL-SEED-SPN-03')`);
      assert.equal(stats.stats.usage_count, 1, 'usage statistics count this clinic only');
      // A template of another clinic cannot be used.
      await expectError(c, `select public.apply_template_to_patient($1, $2, null)`,
        [`TPL-${k.otherCode}-1`, `P-${k.code}-02`], /القالب غير موجود/);
      // Receptionists have no access to the library (0001 guard).
      await actAs(c, fx, 'receptionist', k.slug);
      await expectError(c, `select public.list_treatment_templates()`, [], /غير مصرح/);
    });
  }
});

test('template categories and treatment methods: own rows in the clinic, global rows read-only', async () => {
  for (const k of CLINICS) {
    await inTx(async (c) => {
      const s = suffix();
      const org = fx.orgs[k.slug];
      await actAs(c, fx, 'doctor', k.slug);

      const cats = await rpc(c, `public.list_template_categories(p_include_archived => true)`);
      assert.deepEqual(cats.rows.map((r) => r.category_id).sort(),
        [`TPC-${k.code}-1`, 'TPC-SEED-SHOULDER', 'TPC-SEED-SPINE'].sort());
      const cat = await rpc(c, `public.upsert_template_category(p_category_id => null, p_payload => $1::jsonb)`,
        [JSON.stringify({ name: `فئة ${s}`, description: 'x', sort_order: 5 })]);
      assert.equal((await rowOf(c, 'template_categories', 'category_id = $1', [cat.category_id]))[0].organization_id, org);
      await rpc(c, `public.upsert_template_category(p_category_id => $1, p_payload => $2::jsonb)`,
        [cat.category_id, JSON.stringify({ name: `فئة معدلة ${s}` })]);
      await rpc(c, `public.set_template_category_status(p_category_id => $1, p_status => 'archived')`, [cat.category_id]);
      const delCat = await rpc(c, `public.delete_template_category(p_category_id => $1)`, [cat.category_id]);
      assert.equal(delCat.deleted, true);
      // Same name as a global category: refused by the RPC's duplicate check.
      await expectError(c, `select public.upsert_template_category(null, $1::jsonb)`,
        [JSON.stringify({ name: 'قوالب تشخيص الكتف' })], /موجود مسبقًا/);
      await expectError(c, `select public.set_template_category_status('TPC-SEED-SPINE', 'archived')`, [], /الفئة غير موجودة/);
      await expectError(c, `select public.delete_template_category('TPC-SEED-SPINE')`, [], /لا يمكن حذف/);
      await expectError(c, `select public.upsert_template_category('TPC-SEED-SPINE', '{"name":"x"}'::jsonb)`, [], /^23505 /);

      // Treatment methods (upsert_treatment_method is called twice by the frontend).
      const m = await rpc(c, `public.upsert_treatment_method(p_method_id => null, p_payload => $1::jsonb)`,
        [JSON.stringify({ name: `طريقة ${s}`, category: 'أخرى', duration_minutes: '30', is_active: 'true' })]);
      assert.equal((await rowOf(c, 'treatment_methods', 'method_id = $1', [m.method_id]))[0].organization_id, org);
      await rpc(c, `public.upsert_treatment_method(p_method_id => $1, p_payload => $2::jsonb)`,
        [m.method_id, JSON.stringify({ name: `طريقة معدلة ${s}` })]);
      await rpc(c, `public.set_treatment_method_status(p_method_id => $1, p_status => 'archived')`, [m.method_id]);
      // delete_treatment_method admits doctors (policy added in 0003).
      assert.equal((await rpc(c, `public.delete_treatment_method(p_method_id => $1)`, [m.method_id])).deleted, true);
      assert.equal((await rowOf(c, 'treatment_methods', 'method_id = $1', [m.method_id])).length, 0);
      await expectError(c, `select public.upsert_treatment_method(null, $1::jsonb)`,
        [JSON.stringify({ name: 'علاج يدوي' })], /موجود مسبقًا/);
      await expectError(c, `select public.set_treatment_method_status('TM-DFLT-001', 'archived')`, [], /غير موجود/);
      await expectError(c, `select public.delete_treatment_method('TM-DFLT-001')`, [], /غير موجودة/);
      // Another clinic's method is invisible.
      await expectError(c, `select public.delete_treatment_method($1)`, [`TM-${k.otherCode}-1`], /غير موجودة/);
    });
  }
});

test('treatment RPCs: create (from a global template), update, list, get, sessions counter, delete', async () => {
  for (const k of CLINICS) {
    await inTx(async (c) => {
      const s = suffix();
      const org = fx.orgs[k.slug];
      const b1 = fx.branches[k.slug][0];
      await actAs(c, fx, 'therapist', k.slug);
      const tid = `TRT-T-${s}`;
      const t = await rpc(c, `public.create_treatment(p_treatment_id => $1, p_payload => $2::jsonb)`,
        [tid, JSON.stringify({ patient_id: `P-${k.code}-02`, therapist_id: `ST-${k.code}-THERAPIST`, template_id: 'TPL-SEED-SHD-01' })]);
      assert.deepEqual([t.organization_id, t.branch_id, t.template_id, t.therapist_name], [org, b1, 'TPL-SEED-SHD-01', `الأخصائي — ${k.code}`]);
      const usage = await rowOf(c, 'template_usage', 'plan_id = $1', [tid]);
      assert.deepEqual(usage.map((u) => u.organization_id), [org]);
      // Patients / therapists of the other clinic are not found.
      await expectError(c, `select public.create_treatment($1, $2::jsonb)`,
        [`TRT-T2-${s}`, JSON.stringify({ patient_id: `P-${k.otherCode}-01`, therapist_id: `ST-${k.code}-THERAPIST` })], /المريض غير موجود/);
      await expectError(c, `select public.create_treatment($1, $2::jsonb)`,
        [`TRT-T3-${s}`, JSON.stringify({ patient_id: `P-${k.code}-01`, therapist_id: `ST-${k.otherCode}-THERAPIST` })], /الأخصائي غير موجود/);
      await expectError(c, `select public.create_treatment($1, $2::jsonb)`,
        [`TRT-T4-${s}`, JSON.stringify({ patient_id: `P-${k.code}-01`, therapist_id: `ST-${k.code}-THERAPIST`, template_id: `TPL-${k.otherCode}-1` })],
        /القالب غير موجود/);

      const upd = await rpc(c, `public.update_treatment(p_treatment_id => $1, p_payload => $2::jsonb)`,
        [tid, JSON.stringify({ notes: 'ملاحظة', status: 'active' })]);
      assert.equal(upd.notes, 'ملاحظة');
      const list = await rpc(c, `public.list_treatments(p_limit => 500)`);
      assert.ok(list.rows.every((r) => r.organization_id === org), 'list_treatments crosses clinics');
      assert.ok(list.rows.some((r) => r.treatment_id === tid));
      assert.ok(!list.rows.some((r) => r.branch_id !== b1), 'a branch-1 therapist lists branch-1 treatments only');
      assert.equal((await rpc(c, `public.get_treatment(p_treatment_id => $1)`, [tid])).patient_name, `مريضة ثانية — ${k.code}`);
      assert.equal(await rpc(c, `public.get_treatment(p_treatment_id => $1)`, [`TRT-${k.otherCode}-B1-1`]), null);

      // A session the therapist records updates the counter (trigger).
      await c.query(`insert into sessions (session_id, patient_id, therapist_id, treatment_id, date, status)
                     values ($1, $2, $3, $4, current_date, 'completed')`,
      [`SES-T-${s}`, `P-${k.code}-02`, `ST-${k.code}-THERAPIST`, tid]);
      assert.equal((await rowOf(c, 'treatments', 'treatment_id = $1', [tid]))[0].completed_sessions, 1);

      await actAs(c, fx, 'doctor', k.slug);
      const del = await rpc(c, `public.delete_treatment(p_treatment_id => $1)`, [tid]);
      assert.deepEqual([del.deleted, del.sessions_unlinked], [true, 1]);
      await expectError(c, `select public.delete_treatment($1)`, [`TRT-${k.otherCode}-B1-1`], /سجل العلاج غير موجود/);
    });
  }
});

test('list_invoices_filtered and delete_payment_receipt stay inside the clinic and branch', async () => {
  for (const k of CLINICS) {
    await inTx(async (c) => {
      await actAs(c, fx, 'receptionist', k.slug);
      const r = await rpc(c, `public.list_invoices_filtered(p_limit => 500)`);
      assert.deepEqual(r.rows.map((x) => x.invoice_id).sort(), [`INV-${k.code}-B1-1`, `INV-${k.code}-B1-2`]);
      await actAs(c, fx, 'admin', k.slug);
      const a = await rpc(c, `public.list_invoices_filtered(p_limit => 500)`);
      assert.deepEqual(a.rows.map((x) => x.invoice_id).sort(), [`INV-${k.code}-B1-1`, `INV-${k.code}-B1-2`, `INV-${k.code}-B2-1`]);
      assert.equal(Number(a.stats.total_invoices), 1250);

      const gone = await rpc(c, `public.delete_payment_receipt(p_receipt_id => $1)`, [`PRC-${k.code}-B2-1`]);
      assert.equal(gone.deleted, true);
      const [rcpt] = await rowOf(c, 'payment_receipts', 'receipt_id = $1', [`PRC-${k.code}-B2-1`]);
      assert.ok(rcpt.deleted_at);
      await expectError(c, `select public.delete_payment_receipt($1)`, [`PRC-${k.otherCode}-B1-1`], /الإيصال غير موجود/);
    });
  }
});
