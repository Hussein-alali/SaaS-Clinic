'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, newRecordId, USER, ORG, BRANCH } = require('./helpers');

// db/seed/dev.sql, demo-physio: P-PHY-01..04
//   01 M 34 'ألم أسفل الظهر' MF-1   02 F 41 'التهاب الكتف' MF-2
//   03 M 27 'إصابة ركبة'     MF-3   04 F 58 (no diagnosis, no file no.)
// bookings BK-PHY-B1-1/-2 (branch 1), BK-PHY-B2-1/-2 (branch 2); demo-dental mirrors it (P-DEN-*, BK-DEN-*).

let h;
let admin; // physio admin client (X-Org-Slug: demo-physio)
let dental; // dental admin client
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
  // Negative cases for the /api/data whitelist (test-only tables): RLS
  // enabled but not FORCEd, and no RLS at all.
  await h.sql(`
    create table public.rls_not_forced (id int primary key, organization_id uuid default public.app_org_id(), body text);
    alter table public.rls_not_forced enable row level security;
    create table public.no_rls_notes (id int primary key, body text);`);
});
after(async () => {
  await h.close();
});

const ids = (res) => res.body.data.map((r) => r.patient_id);
const PHY = ['P-PHY-01', 'P-PHY-02', 'P-PHY-03', 'P-PHY-04'];
const ISO_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;

test('select *: only the current clinic, count null by default', async () => {
  const res = await admin.data({ table: 'patients', action: 'select', columns: '*', order: [{ column: 'patient_id' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), PHY);
  assert.equal(res.body.count, null);
  const p1 = res.body.data[0];
  assert.equal(p1.organization_id, ORG.physio);
  assert.equal(p1.age, 34);
  assert.equal(p1.status, 'نشط', 'column default from 0001');
  assert.match(p1.created_at, ISO_TS, 'timestamptz as ISO-8601');

  const other = await dental.data({ table: 'patients', order: [{ column: 'patient_id' }] });
  assert.deepEqual(ids(other), ['P-DEN-01', 'P-DEN-02', 'P-DEN-03', 'P-DEN-04']);
  // action defaults to select and columns to *
  assert.equal((await admin.data({ table: 'patients' })).body.data.length, 4);
});

test('values come back as PostgREST/supabase-js JSON: numeric → number, date → YYYY-MM-DD, jsonb as JSON, booleans', async () => {
  const b = await admin.data({ table: 'bookings', filters: [{ column: 'booking_id', op: 'eq', value: 'BK-PHY-B1-2' }], single: 'single' });
  assert.equal(b.status, 200);
  assert.equal(b.body.data.price, 300);
  assert.equal(b.body.data.paid, 100);
  assert.match(b.body.data.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(b.body.data.branch_id, BRANCH.physio1);
  const p = await admin.data({ table: 'payments', filters: [{ column: 'payment_id', op: 'eq', value: 'PMT-PHY-B1-1' }], single: 'single' });
  assert.deepEqual(p.body.data.allocations, [
    { type: 'invoice', id: 'INV-PHY-B1-2', amount: 200 },
    { type: 'appointment', id: 'BK-PHY-B1-2', amount: 100 },
  ]);
  assert.equal(p.body.data.amount, 300);
  const br = await admin.data({ table: 'branches', columns: 'id,working_hours,rooms', order: [{ column: 'id' }] });
  assert.deepEqual(br.body.data[1], { id: BRANCH.physio2, working_hours: { sat: ['12:00', '20:00'] }, rooms: 2 });
  const cs = await admin.data({ table: 'custom_sections', columns: 'id,visible', order: [{ column: 'id' }] });
  assert.deepEqual(cs.body.data, [{ id: 'CS-PHY-1', visible: true }, { id: 'CS-PHY-2', visible: false }]);
  const audit = await admin.data({ table: 'audit_events', columns: 'id,payload', single: 'single' });
  assert.equal(typeof audit.body.data.id, 'number', 'bigserial (int8) → number');
});

test('columns: comma list of plain identifiers', async () => {
  const res = await admin.data({ table: 'patients', columns: 'patient_id, medical_file_no', filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-02' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ patient_id: 'P-PHY-02', medical_file_no: 'MF-2' }]);
});

test('every filter operator', async () => {
  const f = async (filters, table = 'patients', key = 'patient_id') => {
    const r = await admin.data({ table, columns: key, filters, order: [{ column: key }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.map((row) => row[key]);
  };
  assert.deepEqual(await f([{ column: 'patient_id', op: 'eq', value: 'P-PHY-01' }]), ['P-PHY-01']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'neq', value: 'P-PHY-01' }]), ['P-PHY-02', 'P-PHY-03', 'P-PHY-04']);
  assert.deepEqual(await f([{ column: 'age', op: 'gt', value: 34 }]), ['P-PHY-02', 'P-PHY-04']);
  assert.deepEqual(await f([{ column: 'age', op: 'gte', value: 41 }]), ['P-PHY-02', 'P-PHY-04']);
  assert.deepEqual(await f([{ column: 'age', op: 'lt', value: 41 }]), ['P-PHY-01', 'P-PHY-03']);
  assert.deepEqual(await f([{ column: 'age', op: 'lte', value: 41 }]), ['P-PHY-01', 'P-PHY-02', 'P-PHY-03']);
  assert.deepEqual(await f([{ column: 'diagnosis', op: 'is', value: null }]), ['P-PHY-04']);
  assert.deepEqual(await f([{ column: 'visible', op: 'is', value: true }], 'custom_sections', 'id'), ['CS-PHY-1']);
  assert.deepEqual(await f([{ column: 'visible', op: 'is', value: false }], 'custom_sections', 'id'), ['CS-PHY-2']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'in', value: ['P-PHY-01', 'P-PHY-03', 'P-DEN-01'] }]), ['P-PHY-01', 'P-PHY-03']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'in', value: [] }]), []);
  assert.deepEqual(await f([{ column: 'name', op: 'like', value: '%ثانية%' }]), ['P-PHY-02']);
  assert.deepEqual(await f([{ column: 'name', op: 'like', value: '%phy%' }]), [], 'like is case-sensitive');
  assert.deepEqual(await f([{ column: 'name', op: 'ilike', value: '%phy%' }]), PHY);
  // the seed dates bookings relative to current_date: today, +1, today, +2
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await h.sql('select current_date::text as d');
  assert.equal(rows[0].d, today, 'test and database agree on today (UTC)');
  assert.deepEqual(await f([{ column: 'date', op: 'gt', value: today }], 'bookings', 'booking_id'), ['BK-PHY-B1-2', 'BK-PHY-B2-2']);
  assert.deepEqual(
    await f([{ column: 'created_at', op: 'lte', value: new Date().toISOString() }], 'bookings', 'booking_id'),
    ['BK-PHY-B1-1', 'BK-PHY-B1-2', 'BK-PHY-B2-1', 'BK-PHY-B2-2'],
    'timestamptz compared with an ISO string',
  );
  assert.deepEqual(await f([{ column: 'working_hours', op: 'eq', value: { sat: ['12:00', '20:00'] } }], 'branches', 'id'), [BRANCH.physio2], 'jsonb equality');
  assert.deepEqual(await f([{ column: 'allocations', op: 'eq', value: [] }], 'payments', 'payment_id'), ['PMT-PHY-B2-1'], 'jsonb array equality');
  assert.deepEqual(
    await f([
      { column: 'age', op: 'gte', value: 30 },
      { column: 'gender', op: 'eq', value: 'M' },
    ]),
    ['P-PHY-01'],
    'filters are ANDed',
  );
  const badIs = await admin.data({ table: 'patients', filters: [{ column: 'name', op: 'is', value: 'maybe' }] });
  assert.equal(badIs.status, 400);
  const badOp = await admin.data({ table: 'patients', filters: [{ column: 'name', op: 'or', value: 1 }] });
  assert.equal(badOp.status, 400);
  const objValue = await admin.data({ table: 'patients', filters: [{ column: 'name', op: 'eq', value: { a: 1 } }] });
  assert.equal(objValue.status, 400);
  const typeErr = await admin.data({ table: 'patients', filters: [{ column: 'age', op: 'eq', value: 'abc' }] });
  assert.equal(typeErr.status, 400);
  assert.equal(typeErr.body.error.code, '22P02', 'PostgreSQL SQLSTATE is passed through');
});

test('order: ascending, descending, nullsFirst, several columns', async () => {
  const o = async (order) => ids(await admin.data({ table: 'patients', columns: 'patient_id', order }));
  assert.deepEqual(await o([{ column: 'age', ascending: false }]), ['P-PHY-04', 'P-PHY-02', 'P-PHY-01', 'P-PHY-03']);
  assert.deepEqual(await o([{ column: 'medical_file_no', ascending: true }]), PHY, 'NULL last by default (ascending)');
  assert.deepEqual(await o([{ column: 'medical_file_no', ascending: true, nullsFirst: true }]), ['P-PHY-04', 'P-PHY-01', 'P-PHY-02', 'P-PHY-03']);
  assert.deepEqual(await o([{ column: 'medical_file_no', ascending: false, nullsFirst: false }]), ['P-PHY-03', 'P-PHY-02', 'P-PHY-01', 'P-PHY-04']);
  assert.deepEqual(await o([{ column: 'gender', ascending: false }, { column: 'patient_id', ascending: false }]), ['P-PHY-03', 'P-PHY-01', 'P-PHY-04', 'P-PHY-02']);
});

test('range, count exact (same filters), and the 1000-row cap per response', async () => {
  // 1500 more patients for the physio clinic, inserted under RLS as its admin
  await h.asUser(
    USER.physioAdmin.id,
    ORG.physio,
    "insert into patients (patient_id, name, age) select 'BULK-' || lpad(g::text, 5, '0'), 'Bulk ' || g, g % 90 from generate_series(1, 1500) g",
  );
  try {
    const all = await admin.data({ table: 'patients', columns: 'patient_id', count: 'exact' });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 1000, 'no range → at most 1000 rows');
    assert.equal(all.body.count, 1504);

    const big = await admin.data({ table: 'patients', columns: 'patient_id', range: { from: 0, to: 4999 }, count: 'exact' });
    assert.equal(big.body.data.length, 1000, 'a wider range is capped at 1000 rows');

    const page2 = await admin.data({
      table: 'patients',
      columns: 'patient_id',
      order: [{ column: 'patient_id', ascending: true }],
      range: { from: 1000, to: 1999 },
    });
    assert.equal(page2.body.data.length, 504);
    const page1 = await admin.data({ table: 'patients', columns: 'patient_id', order: [{ column: 'patient_id' }], range: { from: 0, to: 999 } });
    const seen = new Set([...ids(page1), ...ids(page2)]);
    assert.equal(seen.size, 1504, 'pages neither overlap nor skip (selectAllRows pattern)');

    const small = await admin.data({
      table: 'patients',
      columns: 'patient_id',
      filters: [{ column: 'name', op: 'like', value: 'Bulk 1%' }],
      order: [{ column: 'patient_id' }],
      range: { from: 2, to: 4 },
      count: 'exact',
    });
    assert.deepEqual(ids(small), ['BULK-00011', 'BULK-00012', 'BULK-00013'], 'Bulk 1, Bulk 10, Bulk 11, ... sorted by id');
    assert.equal(small.body.count, 612, 'count uses the filters, not the range (1, 10-19, 100-199, 1000-1500)');

    for (const range of [{ from: -1, to: 3 }, { from: 5, to: 2 }, { from: '0', to: 9 }, [0, 9]]) {
      assert.equal((await admin.data({ table: 'patients', range })).status, 400, JSON.stringify(range));
    }
    assert.equal((await admin.data({ table: 'patients', count: 'planned' })).status, 400);

    const head = await admin.data({ table: 'patients', count: 'exact', head: true });
    assert.equal(head.body.data, null);
    assert.equal(head.body.count, 1504);

    // other clinics are unaffected
    const d = await dental.data({ table: 'patients', count: 'exact' });
    assert.equal(d.body.count, 4);
  } finally {
    await h.asUser(USER.physioAdmin.id, ORG.physio, "delete from patients where patient_id like 'BULK-%'");
  }
});

test('single and maybeSingle (406 PGRST116)', async () => {
  const one = [{ column: 'patient_id', op: 'eq', value: 'P-PHY-01' }];
  const none = [{ column: 'patient_id', op: 'eq', value: 'nope' }];
  const many = [{ column: 'gender', op: 'eq', value: 'M' }];

  const s1 = await admin.data({ table: 'patients', filters: one, single: 'single' });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.data.patient_id, 'P-PHY-01');
  assert.ok(!Array.isArray(s1.body.data));

  for (const filters of [none, many]) {
    const r = await admin.data({ table: 'patients', filters, single: 'single' });
    assert.equal(r.status, 406);
    assert.equal(r.body.error.code, 'PGRST116');
  }
  const m0 = await admin.data({ table: 'patients', filters: none, single: 'maybeSingle' });
  assert.equal(m0.status, 200);
  assert.equal(m0.body.data, null);
  const m1 = await admin.data({ table: 'patients', filters: one, single: 'maybeSingle' });
  assert.equal(m1.body.data.patient_id, 'P-PHY-01');
  const mMany = await admin.data({ table: 'patients', filters: many, single: 'maybeSingle' });
  assert.equal(mMany.status, 406);
  assert.equal(mMany.body.error.code, 'PGRST116');
  // another clinic's row does not exist for this user
  const cross = await dental.data({ table: 'patients', filters: one, single: 'maybeSingle' });
  assert.equal(cross.body.data, null);
  // clinic_settings: .eq("id", 1).maybeSingle() returns this clinic's row (convention 11)
  const settings = await dental.data({ table: 'clinic_settings', filters: [{ column: 'id', op: 'eq', value: 1 }], single: 'maybeSingle' });
  assert.equal(settings.body.data.name, 'عيادة الأسنان التجريبية');
  assert.equal(settings.body.data.organization_id, ORG.dental);
});

test('insert: object or array, organization_id from the context, jsonb values, returning', async () => {
  const id = newRecordId('P-');
  const one = await admin.data({
    table: 'patients',
    action: 'insert',
    values: { patient_id: id, name: 'New One', date_of_birth: '1996-05-04', gender: 'F' },
    returning: true,
  });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.length, 1);
  const row = one.body.data[0];
  assert.equal(row.patient_id, id);
  assert.equal(row.organization_id, ORG.physio, 'DEFAULT app_org_id()');
  assert.equal(row.date_of_birth, '1996-05-04', 'date stays YYYY-MM-DD');
  assert.equal(row.status, 'نشط', 'column defaults apply');

  const sched = (schedule_id, days) =>
    admin.data({ table: 'patient_schedules', action: 'insert', values: { schedule_id, patient_id: 'P-PHY-01', days } });
  const arr = await sched(newRecordId('SCH-'), ['sat', { day: 'mon', at: '10:00' }]);
  assert.equal(arr.status, 200, JSON.stringify(arr.body));
  assert.deepEqual(arr.body.data[0].days, ['sat', { day: 'mon', at: '10:00' }], 'a JS array into jsonb stays a JSON array');
  assert.equal(arr.body.data[0].branch_id, BRANCH.physio1, 'DEFAULT app_branch_id()');
  assert.deepEqual((await sched(newRecordId('SCH-'), { sat: true })).body.data[0].days, { sat: true });
  assert.equal((await sched(newRecordId('SCH-'), 'plain')).body.data[0].days, 'plain');

  const many = await admin.data({
    table: 'patients',
    action: 'insert',
    columns: 'patient_id,name,age',
    values: [
      { patient_id: 'P-NEW-2', name: 'Two', age: 2 },
      { patient_id: 'P-NEW-3', name: 'Three' },
    ],
  });
  assert.equal(many.status, 200);
  assert.deepEqual(many.body.data, [
    { patient_id: 'P-NEW-2', name: 'Two', age: 2 },
    { patient_id: 'P-NEW-3', name: 'Three', age: null },
  ]);

  const minimal = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-NEW-4', name: 'Four' }, returning: false, count: 'exact' });
  assert.equal(minimal.status, 200);
  assert.equal(minimal.body.data, null);
  assert.equal(minimal.body.count, 1);

  const single = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-NEW-5', name: 'Five' }, single: 'single' });
  assert.equal(single.body.data.patient_id, 'P-NEW-5');

  for (const values of [[], 'x', [1], null, {}]) {
    const r = await admin.data({ table: 'patients', action: 'insert', values });
    assert.equal(r.status, 400, JSON.stringify(values));
  }
});

test('organization_id in values must be the current clinic', async () => {
  const foreign = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-EVIL-1', name: 'Evil', organization_id: ORG.dental } });
  assert.equal(foreign.status, 403);
  const foreignArr = await admin.data({
    table: 'patients',
    action: 'insert',
    values: [
      { patient_id: 'P-EVIL-2', name: 'ok', organization_id: ORG.physio },
      { patient_id: 'P-EVIL-3', name: 'evil', organization_id: ORG.dental },
    ],
  });
  assert.equal(foreignArr.status, 403);
  const moveUpdate = await admin.data({
    table: 'patients',
    action: 'update',
    values: { organization_id: ORG.dental },
    filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-03' }],
  });
  assert.equal(moveUpdate.status, 403);
  const upsert = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-DEN-01', name: 'hijack', organization_id: ORG.dental } });
  assert.equal(upsert.status, 403);
  const same = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-OWN-1', name: 'ok', organization_id: ORG.physio } });
  assert.equal(same.status, 200, 'its own organization_id is accepted');
  const { rows } = await h.asSystem("select count(*)::int as n from patients where patient_id like 'P-EVIL-%'");
  assert.equal(rows[0].n, 0);
  // the RLS policies are the backstop: an upsert that would take over
  // another clinic's row (same globally unique key) cannot touch it
  const takeover = await admin.data({ table: 'patients', action: 'upsert', onConflict: 'patient_id', values: { patient_id: 'P-DEN-01', name: 'hijack' } });
  assert.equal(takeover.status, 403, JSON.stringify(takeover.body));
  assert.equal(takeover.body.error.code, '42501');
  const den = await dental.data({ table: 'patients', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-01' }], single: 'single' });
  assert.equal(den.body.data.name, 'مريض أول — DEN');
});

test('update and delete require at least one filter', async () => {
  const u = await admin.data({ table: 'patients', action: 'update', values: { notes: 'x' } });
  assert.equal(u.status, 400);
  assert.equal(u.body.error.code, 'filter_required');
  const d = await admin.data({ table: 'patients', action: 'delete' });
  assert.equal(d.status, 400);
  assert.equal(d.body.error.code, 'filter_required');
  const empty = await admin.data({ table: 'patients', action: 'delete', filters: [] });
  assert.equal(empty.status, 400);
  const { rows } = await h.asSystem("select count(*)::int as n from patients where patient_id like 'P-PHY-0%'");
  assert.equal(rows[0].n, 4, 'nothing was deleted');
});

test('update: returns updated rows and count; other clinics are invisible', async () => {
  const res = await admin.data({
    table: 'patients',
    action: 'update',
    values: { notes: 'Updated', occupation: 'teacher' },
    filters: [{ column: 'patient_id', op: 'in', value: ['P-PHY-02', 'P-DEN-01'] }],
    count: 'exact',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.deepEqual(res.body.data.map((r) => [r.patient_id, r.notes, r.occupation]), [['P-PHY-02', 'Updated', 'teacher']]);
  assert.match(res.body.data[0].updated_at, ISO_TS, 'the 0001 updated_at trigger ran');
  const den = await dental.data({ table: 'patients', columns: 'notes', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-01' }] });
  assert.equal(den.body.data[0].notes, null, 'the other clinic was not touched');
  const minimal = await admin.data({ table: 'patients', action: 'update', values: { age: 46 }, filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-02' }], returning: false });
  assert.equal(minimal.body.data, null);
});

test('delete: returns deleted rows; cannot reach other clinics', async () => {
  await admin.data({ table: 'patients', action: 'insert', values: [{ patient_id: 'P-DEL-1', name: 'd1' }, { patient_id: 'P-DEL-2', name: 'd2' }] });
  const res = await admin.data({ table: 'patients', action: 'delete', filters: [{ column: 'patient_id', op: 'like', value: 'P-DEL-%' }], columns: 'patient_id' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((r) => r.patient_id).sort(), ['P-DEL-1', 'P-DEL-2']);
  const cross = await admin.data({ table: 'patients', action: 'delete', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-01' }], count: 'exact' });
  assert.equal(cross.status, 200);
  assert.equal(cross.body.count, 0);
  assert.deepEqual(cross.body.data, []);
  const { rows } = await h.asUser(USER.dentalAdmin.id, ORG.dental, "select count(*)::int as n from patients where patient_id = 'P-DEN-01'");
  assert.equal(rows[0].n, 1);
});

test('upsert: onConflict validated, ON CONFLICT DO UPDATE of the provided columns, default = primary key', async () => {
  // the frontend's upsertRow(): .upsert(row, { onConflict: cfg.pk })
  const res = await admin.data({
    table: 'patients',
    action: 'upsert',
    onConflict: 'patient_id',
    values: [
      { patient_id: 'P-PHY-01', name: 'مريض أول (معدل)' },
      { patient_id: 'P-UPS-1', name: 'Upserted' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = Object.fromEntries(res.body.data.map((r) => [r.patient_id, r]));
  assert.equal(byId['P-PHY-01'].name, 'مريض أول (معدل)');
  assert.equal(byId['P-PHY-01'].diagnosis, 'ألم أسفل الظهر', 'columns not provided are kept');
  assert.equal(byId['P-UPS-1'].organization_id, ORG.physio);

  const byPk = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-UPS-1', name: 'Again' } });
  assert.equal(byPk.body.data[0].name, 'Again');

  // composite primary key (organization_id, id) of clinic_settings: {id: 1, ...}
  // without organization_id takes it from the context (DEFAULT app_org_id())
  const settings = await admin.data({ table: 'clinic_settings', action: 'upsert', values: { id: 1, subtitle: 'جديد' } });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  assert.equal(settings.body.data[0].subtitle, 'جديد');
  assert.equal(settings.body.data[0].name, 'عيادة العلاج الطبيعي التجريبية');
  const dentalSettings = await dental.data({ table: 'clinic_settings', columns: 'subtitle', single: 'single' });
  assert.equal(dentalSettings.body.data.subtitle, 'بيانات تجريبية', 'the other clinic keeps its row');
  // onConflict 'id' alone is not a unique key any more (convention 11)
  const byIdOnly = await admin.data({ table: 'clinic_settings', action: 'upsert', onConflict: 'id', values: { id: 1, subtitle: 'x' } });
  assert.equal(byIdOnly.status, 400);
  assert.equal(byIdOnly.body.error.code, '42P10');

  const ignore = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-UPS-1', name: 'Ignored' }, ignoreDuplicates: true });
  assert.deepEqual(ignore.body.data, []);

  const notUnique = await admin.data({ table: 'patients', action: 'upsert', onConflict: 'name', values: { patient_id: 'P-UPS-2', name: 'x' } });
  assert.equal(notUnique.status, 400);
  assert.equal(notUnique.body.error.code, '42P10');
  const unknownCol = await admin.data({ table: 'patients', action: 'upsert', onConflict: 'nope', values: { patient_id: 'P-UPS-2', name: 'x' } });
  assert.equal(unknownCol.status, 400);
  assert.equal(unknownCol.body.error.code, 'invalid_column');
});

test('PostgreSQL errors: 23505 → 409, RLS → 403, PL422 → 422, others → 400, always {error:{message, code}}', async () => {
  const dup = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-PHY-01', name: 'dup' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, '23505');
  assert.deepEqual(Object.keys(dup.body.error).sort(), ['code', 'message']);
  // organization-scoped unique (convention 9): the same national id twice in one clinic
  const dupNational = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: newRecordId('P-'), name: 'n', national_id: '29001011234567' } });
  assert.equal(dupNational.status, 409);

  // the doctor may read bookings but not write them: WITH CHECK fails
  const doctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  const rls = await doctor.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01' } });
  assert.equal(rls.status, 403);
  assert.equal(rls.body.error.code, '42501');
  assert.match(rls.body.error.message, /row-level security/);

  const check = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-BAD-G', name: 'g', gender: 'X' } });
  assert.equal(check.status, 400);
  assert.equal(check.body.error.code, '23514');
  const notNull = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-BAD-N' } });
  assert.equal(notNull.status, 400);
  assert.equal(notNull.body.error.code, '23502');
  const amount = await admin.data({ table: 'payments', action: 'insert', values: { payment_id: newRecordId('PMT-'), patient_id: 'P-PHY-01', amount: 0, method: 'cash' } });
  assert.equal(amount.status, 400);
  assert.equal(amount.body.error.code, '23514', 'payments.amount > 0');

  // plan limit (Schema "Data validation"): a plan with 2 branches, a third one is refused
  await h.sql("insert into subscription_plans (code, name, max_branches) values ('two-branches', 'Two branches', 2)");
  const { rows } = await h.sql('select plan_id from organizations where id = $1', [ORG.physio]);
  await h.sql("update organizations set plan_id = (select id from subscription_plans where code = 'two-branches') where id = $1", [ORG.physio]);
  try {
    const third = await admin.data({ table: 'branches', action: 'insert', values: { id: newRecordId('br_'), name: 'فرع ثالث' } });
    assert.equal(third.status, 422, JSON.stringify(third.body));
    assert.deepEqual(third.body, { error: { message: 'plan_limit:branches', code: 'PL422' } });
    // an inactive branch does not count
    const inactive = await admin.data({ table: 'branches', action: 'insert', values: { id: newRecordId('br_'), name: 'فرع مغلق', status: 'inactive' } });
    assert.equal(inactive.status, 200, JSON.stringify(inactive.body));
  } finally {
    await h.sql('update organizations set plan_id = $2 where id = $1', [ORG.physio, rows[0].plan_id]);
  }
});

test('a cross-clinic reference through a deferred key fails at COMMIT: 400 23503, nothing written', async () => {
  // bookings.therapist_id → therapists: the single-column key is satisfied by
  // TH-DEN-2 (ids are global), the composite (organization_id, therapist_id)
  // key is DEFERRABLE INITIALLY DEFERRED and fails when the API commits.
  const id = newRecordId('A-');
  const res = await admin.data({ table: 'bookings', action: 'insert', values: { booking_id: id, patient_id: 'P-PHY-01', therapist_id: 'TH-DEN-2' } });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, '23503');
  const { rows } = await h.asSystem('select count(*)::int as n from bookings where booking_id = $1', [id]);
  assert.equal(rows[0].n, 0);
  const own = await admin.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01', therapist_id: 'TH-PHY-2' } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  // a patient of the other clinic: the composite patient key is immediate
  const crossPatient = await admin.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-DEN-01' } });
  assert.equal(crossPatient.status, 400);
  assert.equal(crossPatient.body.error.code, '23503');
});

test('injection attempts in table, columns, filters, order and onConflict are rejected with 400', async () => {
  const attempts = [
    { table: 'patients; drop table patients; --' },
    { table: 'patients"' },
    { table: 'public.patients' },
    { table: 'auth.users' },
    { table: 'pg_authid' },
    { table: 'organizations' },
    { table: 'organization_members' },
    { table: 'member_branches' },
    { table: 'invitations' },
    { table: 'platform_admins' },
    { table: 'subscriptions' },
    { table: 'subscription_plans' },
    { table: 'reserved_slugs' },
    { table: 'schema_migrations' },
    { table: 'no_rls_notes' },
    { table: 'rls_not_forced' },
    { table: 'nope_table' },
    { table: ['patients'] },
    { table: 'patients', columns: 'patient_id, (select 1)' },
    { table: 'patients', columns: 'patient_id as x' },
    { table: 'patients', columns: 'name::text' },
    { table: 'patients', columns: '*, bookings(*)' },
    { table: 'patients', columns: 'secret_column' },
    { table: 'patients', columns: ['name'] },
    { table: 'patients', filters: [{ column: 'name = name or 1=1 --', op: 'eq', value: 'x' }] },
    { table: 'patients', filters: [{ column: 'name"', op: 'eq', value: 'x' }] },
    { table: 'patients', filters: [{ column: 'nope', op: 'eq', value: 'x' }] },
    { table: 'patients', filters: [{ column: 'name', op: 'eq; drop', value: 'x' }] },
    { table: 'patients', filters: { column: 'name', op: 'eq', value: 'x' } },
    { table: 'patients', order: [{ column: 'name; drop table patients' }] },
    { table: 'patients', order: [{ column: 'name desc' }] },
    { table: 'patients', order: [{ column: 'nope' }] },
    { table: 'patients', order: [{ column: 'name', ascending: 'desc' }] },
    { table: 'patients', action: 'upsert', onConflict: 'patient_id) do nothing; --', values: { patient_id: 'X', name: 'x' } },
    { table: 'patients', action: 'upsert', onConflict: ['patient_id', 'name"'], values: { patient_id: 'X', name: 'x' } },
    { table: 'patients', action: 'insert', values: { 'name") values (\'x\'); --': 'x' } },
    { table: 'patients', action: 'insert', values: { nope: 'x', patient_id: 'X', name: 'x' } },
    { table: 'patients', action: 'update', values: { 'name = 1, age': 2 }, filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-02' }] },
    { table: 'patients', action: 'truncate' },
    { table: 'patients', single: 'many' },
  ];
  for (const body of attempts) {
    const res = await admin.data(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error && res.body.error.code && res.body.error.message, JSON.stringify(res.body));
  }
  // values are parameters, never SQL
  const value = await admin.data({ table: 'patients', filters: [{ column: 'name', op: 'eq', value: "x' or '1'='1" }] });
  assert.equal(value.status, 200);
  assert.deepEqual(value.body.data, []);
  const { rows } = await h.sql("select to_regclass('public.patients') is not null as ok");
  assert.equal(rows[0].ok, true);
});

test('the whitelist is exactly the clinic tables of 0003 (FORCE RLS), never a platform table', async () => {
  const tables = [...(await (async () => {
    await h.app.locals.catalog.refresh(true);
    return h.app.locals.catalog.tables.keys();
  })())].sort();
  assert.deepEqual(tables, [
    'audit_events', 'bookings', 'branches', 'campaigns', 'clinic_settings', 'custom_sections', 'departments',
    'doctors', 'invoices', 'packages', 'patient_files', 'patient_schedules', 'patient_subscriptions', 'patients',
    'payment_receipts', 'payments', 'receptionists', 'sessions', 'staff', 'template_categories', 'template_usage',
    'therapists', 'treatment_methods', 'treatment_templates', 'treatments',
  ]);
});

test('every table the frontend reads (DATA_TABLES + direct sb.from calls) is available to an admin', async () => {
  for (const table of [
    'patients', 'bookings', 'patient_schedules', 'sessions', 'invoices', 'payments', 'patient_subscriptions', 'staff',
    'therapists', 'departments', 'doctors', 'receptionists', 'packages', 'campaigns', 'treatment_methods',
    'clinic_settings', 'custom_sections', 'branches', 'payment_receipts', 'patient_files', 'audit_events',
  ]) {
    const res = await admin.data({ table, count: 'exact' });
    assert.equal(res.status, 200, `${table}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.count >= 1, `${table} has seeded rows for demo-physio`);
    assert.ok(res.body.data.every((r) => !('organization_id' in r) || r.organization_id === ORG.physio || r.organization_id === null), table);
  }
});

test('branch scoping: rows of the member branches only; inserts default to the current branch', async () => {
  const recep = await h.as('physioReception', { slug: 'demo-physio' });
  const seen = await recep.data({
    table: 'bookings',
    columns: 'booking_id,branch_id',
    filters: [{ column: 'booking_id', op: 'like', value: 'BK-%' }],
    order: [{ column: 'booking_id' }],
  });
  assert.deepEqual(seen.body.data, [
    { booking_id: 'BK-PHY-B1-1', branch_id: BRANCH.physio1 },
    { booking_id: 'BK-PHY-B1-2', branch_id: BRANCH.physio1 },
  ]);
  const all = await admin.data({ table: 'bookings', columns: 'booking_id', filters: [{ column: 'booking_id', op: 'like', value: 'BK-%' }], order: [{ column: 'booking_id' }] });
  assert.deepEqual(all.body.data.map((b) => b.booking_id), ['BK-PHY-B1-1', 'BK-PHY-B1-2', 'BK-PHY-B2-1', 'BK-PHY-B2-2'], 'admin: every branch of the clinic only');

  const id = newRecordId('A-');
  const ins = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: id, patient_id: 'P-PHY-02', date: '2026-11-01' } });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(ins.body.data[0].branch_id, BRANCH.physio1, 'DEFAULT app_branch_id()');
  assert.equal(ins.body.data[0].date, '2026-11-01');

  const otherBranch = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-02', branch_id: BRANCH.physio2 } });
  assert.equal(otherBranch.status, 403, 'branch_scope WITH CHECK');
  const move = await recep.data({ table: 'bookings', action: 'update', values: { status: 'done' }, filters: [{ column: 'booking_id', op: 'eq', value: 'BK-PHY-B2-1' }] });
  assert.deepEqual(move.body.data, [], 'a booking of another branch is invisible');
  // asking for a branch the member does not have falls back to its own
  const sneaky = h.client({ cookie: (await h.login(USER.physioReception.email)).cookie, slug: 'demo-physio', branch: BRANCH.physio2 });
  const fallback = await sneaky.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-02' } });
  assert.equal(fallback.body.data[0].branch_id, BRANCH.physio1);

  const adminTwo = h.client({ cookie: (await h.login(USER.physioAdmin.email)).cookie, slug: 'demo-physio', branch: BRANCH.physio2 });
  const a = await adminTwo.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01' } });
  assert.equal(a.body.data[0].branch_id, BRANCH.physio2, 'X-Branch-Id picks the default branch');
  const foreignBranch = await admin.data({ table: 'bookings', action: 'insert', values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01', branch_id: BRANCH.dental1 } });
  assert.equal(foreignBranch.status, 400, 'a branch of another clinic cannot be used (composite FK)');
  assert.equal(foreignBranch.body.error.code, '23503');
});

test('data requires the CSRF header, a session and a clinic', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  const noCsrf = await h.client({ cookie, slug: 'demo-physio', csrf: false }).data({ table: 'patients' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, 'csrf_header_required');
  assert.equal((await h.client({ slug: 'demo-physio' }).data({ table: 'patients' })).status, 401);
  assert.equal((await h.client({ cookie }).data({ table: 'patients' })).status, 403);
  const badJson = await h.request('POST', '/api/data', {
    headers: { 'x-requested-with': 'clinicsys', cookie: cookie.value, 'x-org-slug': 'demo-physio', 'content-type': 'application/json' },
    body: '{"table": ',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'invalid_json');
});

test('a column added after startup is picked up (catalog refresh on miss)', async () => {
  const before = await admin.data({ table: 'patients', columns: 'nickname' });
  assert.equal(before.status, 400);
  await h.sql('alter table patients add column nickname text');
  h.app.locals.catalog.loadedAt = 0; // skip the refresh throttle in the test
  const after = await admin.data({ table: 'patients', columns: 'patient_id,nickname', filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-02' }] });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(after.body.data, [{ patient_id: 'P-PHY-02', nickname: null }]);
});
