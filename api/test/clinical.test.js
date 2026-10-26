'use strict';
// Clinical records through the API (0018_clinical_records, owner request
// 26 Oct 2026): the clinic's diagnosis form comes with the clinic, the
// clinical tables follow RLS (admin, doctor, therapist; prescriptions written
// by admin and doctor) and their modules (dental.chart, general.prescriptions:
// 403 module_disabled where the clinic does not have them), and the Super
// Admin chooses each specialty's form (audited).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG } = require('./helpers');

let h, sa, physioTherapist, physioRecep, physioDoctor, dentalDoctor, dentalAdmin, dentalRecep;
before(async () => {
  h = await setup();
  sa = await h.as('superAdmin', { platform: true });
  physioTherapist = await h.as('physioTherapist', { slug: 'demo-physio' });
  physioRecep = await h.as('physioReception', { slug: 'demo-physio' });
  physioDoctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  dentalDoctor = await h.as('doctor@demo-dental.test', { slug: 'demo-dental' });
  dentalAdmin = await h.as('dentalAdmin', { slug: 'demo-dental' });
  dentalRecep = await h.as('dentalReception', { slug: 'demo-dental' });
});
after(() => h.close());

test('the clinic\'s diagnosis form comes with the clinic, before and after sign-in', async () => {
  for (const [slug, form] of [['demo-physio', 'physio'], ['demo-dental', 'dental']]) {
    const pub = await h.client().get(`/api/orgs/resolve?slug=${slug}`);
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.body.diagnosis_form, form, slug);
  }
  const cur = await dentalAdmin.get('/api/orgs/current');
  assert.equal(cur.status, 200, cur.text);
  assert.equal(cur.body.organization.diagnosis_form, 'dental');
  assert.ok(cur.body.organization.modules.includes('dental.chart'));
  assert.ok(cur.body.organization.modules.includes('general.prescriptions'));
});

test('a physio diagnosis is saved with its pain points as coordinates; the receptionist sees none of it', async () => {
  const saved = await physioTherapist.data({
    table: 'assessments', action: 'insert', single: 'single',
    values: {
      patient_id: 'P-PHY-02', kind: 'physio', diagnosis: 'التهاب أوتار الكتف', clinician_id: 'ST-PHY-THERAPIST',
      data: { modalities: ['TENS'] }, markers: [[61.2, 22.5], [62, 24.1]],
      author_uid: USER.physioAdmin.id, author_name: 'مزيف',
    },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body.data.markers, [[61.2, 22.5], [62, 24.1]]);
  assert.equal(saved.body.data.author_uid, USER.physioTherapist.id, 'the author is the session user');
  assert.notEqual(saved.body.data.author_name, 'مزيف');

  const bad = await physioTherapist.data({ table: 'assessments', action: 'insert', values: { patient_id: 'P-PHY-02', kind: 'physio', markers: [{ x: 1, y: 2 }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, '23514');

  const list = await physioDoctor.data({
    table: 'assessments', filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-02' }], order: [{ column: 'created_at', ascending: false }],
  });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data[0].assessment_id, saved.body.data.assessment_id);

  const recep = await physioRecep.data({ table: 'assessments' });
  assert.equal(recep.status, 200);
  assert.deepEqual(recep.body.data, [], 'clinical records are not the receptionist\'s');
  const recepWrite = await physioRecep.data({ table: 'assessments', action: 'insert', values: { patient_id: 'P-PHY-02', kind: 'physio' } });
  assert.equal(recepWrite.status, 403);
});

test('the tooth chart and prescriptions are the dental clinic\'s modules: 403 module_disabled in the physio clinic', async () => {
  const chart = await physioDoctor.data({ table: 'dental_findings' });
  assert.equal(chart.status, 403);
  assert.equal(chart.body.error.code, 'module_disabled');
  const rx = await physioDoctor.data({ table: 'prescriptions' });
  assert.equal(rx.status, 403);
  assert.equal(rx.body.error.code, 'module_disabled');

  const found = await dentalDoctor.data({
    table: 'dental_findings', action: 'insert', single: 'single',
    values: { patient_id: 'P-DEN-02', tooth: 36, surfaces: ['M', 'O'], condition: 'caries', status: 'existing', notes: 'عميق' },
  });
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(found.body.data.surfaces, ['M', 'O']);
  const wrongTooth = await dentalDoctor.data({ table: 'dental_findings', action: 'insert', values: { patient_id: 'P-DEN-02', tooth: 19, condition: 'caries', status: 'existing' } });
  assert.equal(wrongTooth.status, 400);

  const chartOf = await dentalDoctor.data({ table: 'dental_findings', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-01' }] });
  assert.equal(chartOf.status, 200);
  assert.ok(chartOf.body.data.length >= 12, 'the seeded chart of the reference picture');

  const presc = await dentalDoctor.data({
    table: 'prescriptions', action: 'insert', single: 'single',
    values: { patient_id: 'P-DEN-02', items: [{ name: 'Ibuprofen', dose: '400 mg', frequency: 'كل 8 ساعات', duration: '3 أيام' }] },
  });
  assert.equal(presc.status, 200, presc.text);
  const recep = await dentalRecep.data({ table: 'prescriptions' });
  assert.deepEqual(recep.body.data, []);
});

test('the Super Admin chooses a specialty\'s diagnosis form; it is audited and the clinic follows', async () => {
  const list = await sa.get('/api/platform/specialties');
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(Object.fromEntries(list.body.map((s) => [s.code, s.diagnosis_form])), { dental: 'dental', general: 'general', physio: 'physio' });

  for (const value of ['surgery', '', null, 5]) {
    const r = await sa.patch('/api/platform/specialties/dental', { diagnosis_form: value });
    assert.equal(r.status, 400, `${JSON.stringify(value)}: ${r.text}`);
    assert.equal(r.body.error.code, 'invalid_diagnosis_form');
  }
  assert.equal((await sa.patch('/api/platform/specialties/nope', { diagnosis_form: 'general' })).status, 404);
  const clinicAdmin = await dentalAdmin.patch('/api/platform/specialties/dental', { diagnosis_form: 'general' }, { 'x-platform': '1' });
  assert.equal(clinicAdmin.status, 403);

  const changed = await sa.patch('/api/platform/specialties/dental', { diagnosis_form: 'general' });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.body.diagnosis_form, 'general');
  assert.equal((await dentalAdmin.get('/api/orgs/current')).body.organization.diagnosis_form, 'general');
  const { rows: [a] } = await h.asSystem(
    `select action, payload from audit_events where action = 'specialty.update' order by id desc limit 1`);
  assert.deepEqual(a.payload.changes, { diagnosis_form: { from: 'dental', to: 'general' } });
  assert.equal(a.payload.code, 'dental');

  const back = await sa.patch('/api/platform/specialties/dental', { diagnosis_form: 'dental' });
  assert.equal(back.status, 200);
  assert.equal((await dentalAdmin.get('/api/orgs/current')).body.organization.diagnosis_form, 'dental');
});

test('the tooth chart is refused once the Super Admin turns dental.chart off; its rows come back with it', async () => {
  const detail = await sa.get(`/api/platform/organizations/${ORG.dental}`);
  const codes = detail.body.modules.filter((m) => m.enabled).map((m) => m.code);
  const off = await sa.put(`/api/platform/organizations/${ORG.dental}/modules`, { codes: codes.filter((c) => c !== 'dental.chart') });
  assert.equal(off.status, 200, off.text);
  const refused = await dentalDoctor.data({ table: 'dental_findings' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'module_disabled');
  assert.equal((await sa.put(`/api/platform/organizations/${ORG.dental}/modules`, { codes })).status, 200);
  const again = await dentalDoctor.data({ table: 'dental_findings', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-01' }] });
  assert.equal(again.status, 200);
  assert.ok(again.body.data.length >= 12);
});
