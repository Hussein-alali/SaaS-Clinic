// 0018_clinical_records (owner request, 26 Oct 2026): the diagnosis and the
// patient file follow the clinic's department.
//   - specialties.diagnosis_form (physio | dental | general) chosen by the
//     Super Admin; dental.chart, general.visits, general.prescriptions active.
//   - assessments: every diagnosis (kind physio | dental | general); the pain
//     points are coordinates only: markers = [[x, y], ...] in percent of
//     assets/body-diagram.jpeg.
//   - dental_findings: one row per tooth event (FDI tooth, surfaces,
//     condition, status existing | planned | done).
//   - prescriptions: items = [{name, dose, frequency, duration, notes}].
// Clinical rows: admin, doctor and therapist (owner decision); prescriptions
// are written by admin and doctor. The author comes from the session.
// Every test runs inside BEGIN ... ROLLBACK.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const insertAssessment = (c, values) => {
  const cols = Object.keys(values);
  return c.query(
    `insert into assessments (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    cols.map((k) => (values[k] !== null && typeof values[k] === 'object' ? JSON.stringify(values[k]) : values[k])),
  );
};

test('0018: each specialty names its diagnosis form; the clinical modules are active, prescriptions also for dental', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    const { rows: specs } = await c.query('select code, diagnosis_form from specialties order by code');
    assert.deepEqual(specs.map((r) => ({ ...r })), [
      { code: 'dental', diagnosis_form: 'dental' },
      { code: 'general', diagnosis_form: 'general' },
      { code: 'physio', diagnosis_form: 'physio' },
    ]);
    await expectError(c, `update specialties set diagnosis_form = 'surgery' where code = 'general'`, [], /^23514 /);
    const { rows: mods } = await c.query(
      `select code, status, depends_on from modules where code in ('dental.chart', 'general.visits', 'general.prescriptions') order by code`);
    assert.deepEqual(mods.map((r) => ({ ...r })), [
      { code: 'dental.chart', status: 'active', depends_on: ['core.patients'] },
      { code: 'general.prescriptions', status: 'active', depends_on: ['core.patients'] },
      { code: 'general.visits', status: 'active', depends_on: ['core.patients', 'core.appointments'] },
    ]);
    const { rows: dental } = await c.query(
      `select m.code from specialty_modules sm join specialties s on s.id = sm.specialty_id join modules m on m.id = sm.module_id
        where s.code = 'dental' and m.category = 'specialty' order by m.code`);
    assert.deepEqual(dental.map((r) => r.code), ['dental.chart', 'dental.procedures', 'general.prescriptions']);
    // The dev clinic of each specialty has them on (dental.procedures stays planned).
    const { rows: on } = await c.query(
      `select m.code from organization_modules om join modules m on m.id = om.module_id
        where om.organization_id = $1 and om.enabled and m.category = 'specialty' order by m.code`, [fx.orgs['demo-dental']]);
    assert.deepEqual(on.map((r) => r.code), ['dental.chart', 'general.prescriptions']);
  });
});

test('0018: receptionists see and write no clinical rows; therapists write diagnoses and findings, not prescriptions', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'receptionist', 'demo-physio');
    for (const t of ['assessments', 'dental_findings', 'prescriptions']) {
      assert.equal((await c.query(`select count(*)::int n from ${t}`)).rows[0].n, 0, `${t} hidden from the receptionist`);
    }
    await expectError(c, `insert into assessments (patient_id, kind) values ('P-PHY-01', 'physio')`, [], /^42501 /);

    await actAs(c, fx, 'therapist', 'demo-physio');
    assert.ok((await c.query('select count(*)::int n from assessments')).rows[0].n >= 1, 'the seeded diagnosis is visible');
    const { rows: [a] } = await insertAssessment(c, { patient_id: 'P-PHY-01', kind: 'physio', diagnosis: 'ألم أسفل الظهر', markers: [[12.5, 30], [62.1, 44.9]] });
    assert.match(a.assessment_id, /^ASM-/);
    assert.deepEqual(a.markers, [[12.5, 30], [62.1, 44.9]]);
    assert.equal(a.organization_id, fx.orgs['demo-physio']);
    await c.query(`insert into dental_findings (patient_id, tooth, surfaces, condition, status) values ('P-PHY-01', 26, '{O}', 'caries', 'existing')`);
    await expectError(c, `insert into prescriptions (patient_id, items) values ('P-PHY-01', '[{"name":"Ibuprofen"}]')`, [], /^42501 /);

    await actAs(c, fx, 'doctor', 'demo-physio');
    const { rows: [rx] } = await c.query(
      `insert into prescriptions (patient_id, items) values ('P-PHY-01', '[{"name":"Ibuprofen","dose":"400 mg","frequency":"3 مرات يوميًا","duration":"5 أيام"}]') returning prescription_id`);
    assert.match(rx.prescription_id, /^RX-/);
  });
});

test('0018: the author is the session\'s user, whatever the client sends, and never changes', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'therapist', 'demo-physio');
    const therapist = fx.user('therapist', 'demo-physio');
    const { rows: [a] } = await insertAssessment(c, {
      patient_id: 'P-PHY-02', kind: 'physio', author_uid: fx.user('admin', 'demo-physio'), author_name: 'مدير مزيف',
      created_at: '2001-01-01T00:00:00Z',
    });
    assert.equal(a.author_uid, therapist);
    const { rows: [u] } = await c.query(`select raw_user_meta_data->>'name' as name from auth.users where id = $1`, [therapist]);
    assert.equal(a.author_name, u.name);
    assert.notEqual(new Date(a.created_at).getUTCFullYear(), 2001);

    await actAs(c, fx, 'doctor', 'demo-physio');
    const { rows: [b] } = await c.query(
      `update assessments set diagnosis = 'معدل', author_uid = $2, author_name = 'x' where assessment_id = $1 returning author_uid, author_name, diagnosis`,
      [a.assessment_id, fx.user('doctor', 'demo-physio')]);
    assert.deepEqual({ ...b }, { author_uid: therapist, author_name: u.name, diagnosis: 'معدل' });
  });
});

test('0018: deleting: admin and doctor any row, a therapist only their own', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'doctor', 'demo-physio');
    const { rows: [byDoctor] } = await insertAssessment(c, { patient_id: 'P-PHY-01', kind: 'physio' });
    await actAs(c, fx, 'therapist', 'demo-physio');
    const { rows: [own] } = await insertAssessment(c, { patient_id: 'P-PHY-01', kind: 'physio' });
    assert.equal((await c.query('delete from assessments where assessment_id = $1', [byDoctor.assessment_id])).rowCount, 0);
    assert.equal((await c.query('delete from assessments where assessment_id = $1', [own.assessment_id])).rowCount, 1);
    await actAs(c, fx, 'doctor', 'demo-physio');
    assert.equal((await c.query('delete from assessments where assessment_id = $1', [byDoctor.assessment_id])).rowCount, 1);
  });
});

test('0018: pain points are coordinates only: [[x, y], ...] in 0–100, at most 200', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'therapist', 'demo-physio');
    const bad = [
      { x: 10, y: 20 }, [{ x: 10, y: 20 }], [[10]], [[10, 20, 30]], [['10', 20]], [[-1, 20]], [[10, 100.5]],
      [[10, null]], 'points', Array.from({ length: 201 }, () => [1, 1]),
    ];
    for (const markers of bad) {
      await expectError(c, `insert into assessments (patient_id, kind, markers) values ('P-PHY-01', 'physio', $1)`,
        [JSON.stringify(markers)], /^23514 .*assessments_markers_check/);
    }
    for (const markers of [[], [[0, 0], [100, 100]], [[50.5, 12.3]], Array.from({ length: 200 }, () => [1, 1])]) {
      await c.query(`insert into assessments (patient_id, kind, markers) values ('P-PHY-01', 'physio', $1)`, [JSON.stringify(markers)]);
    }
    await expectError(c, `insert into assessments (patient_id, kind) values ('P-PHY-01', 'surgery')`, [], /^23514 /);
    await expectError(c, `insert into assessments (patient_id, kind, data) values ('P-PHY-01', 'general', '[]')`, [], /^23514 /);
    await expectError(c, `insert into assessments (patient_id, kind, data) values ('P-PHY-01', 'general', $1)`,
      [JSON.stringify({ notes: 'x'.repeat(40000) })], /^23514 /);
  });
});

test('0018: dental findings: FDI teeth (adult 11–48, child 51–85), surfaces M O D B L, known conditions and statuses', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'doctor', 'demo-dental');
    const add = (tooth, surfaces, condition, status) => c.query(
      'insert into dental_findings (patient_id, tooth, surfaces, condition, status) values ($1, $2, $3, $4, $5) returning *',
      ['P-DEN-01', tooth, surfaces, condition, status]);
    for (const tooth of [11, 18, 28, 38, 48, 51, 55, 65, 75, 85]) await add(tooth, [], 'watch', 'existing');
    for (const tooth of [10, 19, 29, 49, 50, 56, 86, 90, 9, 100]) {
      await expectError(c, 'insert into dental_findings (patient_id, tooth, condition, status) values ($1, $2, $3, $4)',
        ['P-DEN-01', tooth, 'caries', 'existing'], /^23514 .*dental_findings_tooth_check/);
    }
    const { rows: [f] } = await add(26, ['M', 'O', 'D'], 'crown', 'planned');
    assert.match(f.finding_id, /^DF-/);
    assert.deepEqual(f.surfaces, ['M', 'O', 'D']);
    await expectError(c, 'insert into dental_findings (patient_id, tooth, surfaces, condition, status) values ($1, 26, $2, $3, $4)',
      ['P-DEN-01', ['X'], 'caries', 'existing'], /^23514 /);
    await expectError(c, 'insert into dental_findings (patient_id, tooth, condition, status) values ($1, 26, $2, $3)',
      ['P-DEN-01', 'tattoo', 'existing'], /^23514 /);
    await expectError(c, 'insert into dental_findings (patient_id, tooth, condition, status) values ($1, 26, $2, $3)',
      ['P-DEN-01', 'caries', 'maybe'], /^23514 /);
    // Planned → done keeps the row (its history is the rows of the tooth).
    const { rows: [done] } = await c.query(`update dental_findings set status = 'done' where finding_id = $1 returning status`, [f.finding_id]);
    assert.equal(done.status, 'done');
  });
});

test('0018: prescriptions: 1–30 medicines, a name each, short known fields only', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'doctor', 'demo-dental');
    const bad = [[], {}, [{}], [{ name: '' }], [{ name: 'x', dose: 5 }], [{ name: 'x', colour: 'red' }],
      [{ name: 'x'.repeat(201) }], Array.from({ length: 31 }, () => ({ name: 'x' })), 'Amoxicillin'];
    for (const items of bad) {
      await expectError(c, 'insert into prescriptions (patient_id, items) values ($1, $2)', ['P-DEN-01', JSON.stringify(items)],
        /^23514 .*prescriptions_items_check/);
    }
    await c.query('insert into prescriptions (patient_id, items, notes) values ($1, $2, $3)',
      ['P-DEN-01', JSON.stringify([{ name: 'Amoxicillin', dose: '500 mg', frequency: 'كل 8 ساعات', duration: '7 أيام', notes: 'بعد الأكل' }]), 'ملاحظة']);
  });
});

test('0018: a clinic\'s clinical rows stay in it, and a patient\'s rows go with the patient', async () => {
  await inTx(async (c) => {
    await c.query('set constraints all immediate');
    await actAs(c, fx, 'doctor', 'demo-physio');
    // Another clinic's patient id: the composite FK finds no such patient here.
    await expectError(c, `insert into assessments (patient_id, kind) values ('P-DEN-01', 'dental')`, [], /^23503 /);
    await actAs(c, fx, 'admin', 'demo-physio');
    const s = suffix();
    await c.query(`insert into patients (patient_id, name) values ($1, 'مريض حذف')`, [`P-CLN-${s}`]);
    await insertAssessment(c, { patient_id: `P-CLN-${s}`, kind: 'physio', markers: [[1, 2]] });
    await c.query(`insert into dental_findings (patient_id, tooth, condition, status) values ($1, 11, 'missing', 'existing')`, [`P-CLN-${s}`]);
    await c.query(`insert into prescriptions (patient_id, items) values ($1, '[{"name":"x"}]')`, [`P-CLN-${s}`]);
    await c.query('delete from patients where patient_id = $1', [`P-CLN-${s}`]);
    for (const t of ['assessments', 'dental_findings', 'prescriptions']) {
      assert.equal((await c.query(`select count(*)::int n from ${t} where patient_id = $1`, [`P-CLN-${s}`])).rows[0].n, 0, t);
    }
  });
});
