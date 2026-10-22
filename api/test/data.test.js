'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, USER, ORG } = require('./helpers');

let h;
let admin; // physio admin client (X-Org-Slug: demo-physio)
let dental; // dental admin client
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
});
after(async () => {
  await h.close();
});

const ids = (res) => res.body.data.map((r) => r.patient_id);

test('select *: only the current clinic, PostgREST-shaped values, count null by default', async () => {
  const res = await admin.data({ table: 'patients', action: 'select', columns: '*', order: [{ column: 'patient_id' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), ['P-PHY-1', 'P-PHY-2', 'P-PHY-3']);
  assert.equal(res.body.count, null);
  const p1 = res.body.data[0];
  assert.equal(p1.organization_id, ORG.physio);
  assert.equal(p1.balance, 150.5, 'numeric → number');
  assert.equal(p1.age, 30);
  assert.equal(p1.vip, true);
  assert.deepEqual(p1.tags, ['back', 'new']);
  assert.deepEqual(p1.meta, { source: 'walk-in' });
  assert.equal(p1.birth_date, '1996-05-04', 'date stays YYYY-MM-DD');
  assert.equal(p1.created_at, '2026-01-01T10:00:00+00:00', 'timestamptz as ISO-8601');

  const other = await dental.data({ table: 'patients' });
  assert.deepEqual(ids(other), ['P-DEN-1']);
  // action defaults to select and columns to *
  assert.equal((await admin.data({ table: 'patients' })).body.data.length, 3);
});

test('columns: comma list of plain identifiers', async () => {
  const res = await admin.data({ table: 'patients', columns: 'patient_id, name', filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-2' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ patient_id: 'P-PHY-2', name: 'Mona Hassan' }]);
});

test('every filter operator', async () => {
  const f = async (filters) => {
    const r = await admin.data({ table: 'patients', columns: 'patient_id', filters, order: [{ column: 'patient_id' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return ids(r);
  };
  assert.deepEqual(await f([{ column: 'patient_id', op: 'eq', value: 'P-PHY-1' }]), ['P-PHY-1']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'neq', value: 'P-PHY-1' }]), ['P-PHY-2', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'age', op: 'gt', value: 30 }]), ['P-PHY-2', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'age', op: 'gte', value: 45 }]), ['P-PHY-2', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'age', op: 'lt', value: 45 }]), ['P-PHY-1']);
  assert.deepEqual(await f([{ column: 'age', op: 'lte', value: 45 }]), ['P-PHY-1', 'P-PHY-2']);
  assert.deepEqual(await f([{ column: 'diagnosis', op: 'is', value: null }]), ['P-PHY-2']);
  assert.deepEqual(await f([{ column: 'vip', op: 'is', value: true }]), ['P-PHY-1']);
  assert.deepEqual(await f([{ column: 'vip', op: 'is', value: false }]), ['P-PHY-2', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'in', value: ['P-PHY-1', 'P-PHY-3', 'P-DEN-1'] }]), ['P-PHY-1', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'patient_id', op: 'in', value: [] }]), []);
  assert.deepEqual(await f([{ column: 'name', op: 'like', value: '%Ha%' }]), ['P-PHY-2']);
  assert.deepEqual(await f([{ column: 'name', op: 'ilike', value: '%ha%' }]), ['P-PHY-2']);
  assert.deepEqual(await f([{ column: 'created_at', op: 'gte', value: '2026-01-02T00:00:00Z' }]), ['P-PHY-2', 'P-PHY-3']);
  assert.deepEqual(await f([{ column: 'meta', op: 'eq', value: { source: 'referral' } }]), ['P-PHY-3'], 'jsonb equality');
  assert.deepEqual(
    await f([
      { column: 'age', op: 'gte', value: 30 },
      { column: 'gender', op: 'eq', value: 'M' },
    ]),
    ['P-PHY-1', 'P-PHY-3'],
    'filters are ANDed',
  );
  const badIs = await admin.data({ table: 'patients', filters: [{ column: 'vip', op: 'is', value: 'maybe' }] });
  assert.equal(badIs.status, 400);
  const badOp = await admin.data({ table: 'patients', filters: [{ column: 'vip', op: 'or', value: 1 }] });
  assert.equal(badOp.status, 400);
  const objValue = await admin.data({ table: 'patients', filters: [{ column: 'name', op: 'eq', value: { a: 1 } }] });
  assert.equal(objValue.status, 400);
  const typeErr = await admin.data({ table: 'patients', filters: [{ column: 'age', op: 'eq', value: 'abc' }] });
  assert.equal(typeErr.status, 400);
  assert.equal(typeErr.body.error.code, '22P02', 'PostgreSQL SQLSTATE is passed through');
});

test('order: ascending, descending, nullsFirst, several columns', async () => {
  const o = async (order) => ids(await admin.data({ table: 'patients', columns: 'patient_id', order }));
  assert.deepEqual(await o([{ column: 'age', ascending: false }]), ['P-PHY-3', 'P-PHY-2', 'P-PHY-1']);
  assert.deepEqual(await o([{ column: 'diagnosis', ascending: true, nullsFirst: true }]), ['P-PHY-2', 'P-PHY-1', 'P-PHY-3']);
  assert.deepEqual(await o([{ column: 'diagnosis', ascending: true, nullsFirst: false }]), ['P-PHY-1', 'P-PHY-3', 'P-PHY-2']);
  assert.deepEqual(await o([{ column: 'vip', ascending: false }, { column: 'patient_id', ascending: false }]), ['P-PHY-1', 'P-PHY-3', 'P-PHY-2']);
});

test('range, count exact (same filters), and the 1000-row cap per response', async () => {
  // 1500 more patients for the physio clinic, inserted under RLS as its admin
  await h.asUser(
    USER.physioAdmin.id,
    ORG.physio,
    "insert into patients (patient_id, name, age) select 'BULK-' || lpad(g::text, 5, '0'), 'Bulk ' || g, g % 90 from generate_series(1, 1500) g",
  );
  const all = await admin.data({ table: 'patients', columns: 'patient_id', count: 'exact' });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 1000, 'no range → at most 1000 rows');
  assert.equal(all.body.count, 1503);

  const big = await admin.data({ table: 'patients', columns: 'patient_id', range: { from: 0, to: 4999 }, count: 'exact' });
  assert.equal(big.body.data.length, 1000, 'a wider range is capped at 1000 rows');

  const page2 = await admin.data({
    table: 'patients',
    columns: 'patient_id',
    order: [{ column: 'patient_id', ascending: true }],
    range: { from: 1000, to: 1999 },
  });
  assert.equal(page2.body.data.length, 503);
  const page1 = await admin.data({ table: 'patients', columns: 'patient_id', order: [{ column: 'patient_id' }], range: { from: 0, to: 999 } });
  const seen = new Set([...ids(page1), ...ids(page2)]);
  assert.equal(seen.size, 1503, 'pages neither overlap nor skip (selectAllRows pattern)');

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
  assert.equal(head.body.count, 1503);

  // other clinics are unaffected
  const d = await dental.data({ table: 'patients', count: 'exact' });
  assert.equal(d.body.count, 1);
  await h.asUser(USER.physioAdmin.id, ORG.physio, "delete from patients where patient_id like 'BULK-%'");
});

test('single and maybeSingle (406 PGRST116)', async () => {
  const one = [{ column: 'patient_id', op: 'eq', value: 'P-PHY-1' }];
  const none = [{ column: 'patient_id', op: 'eq', value: 'nope' }];
  const many = [{ column: 'gender', op: 'eq', value: 'M' }];

  const s1 = await admin.data({ table: 'patients', filters: one, single: 'single' });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.data.patient_id, 'P-PHY-1');
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
  assert.equal(m1.body.data.patient_id, 'P-PHY-1');
  const mMany = await admin.data({ table: 'patients', filters: many, single: 'maybeSingle' });
  assert.equal(mMany.status, 406);
  assert.equal(mMany.body.error.code, 'PGRST116');
  // another clinic's row does not exist for this user
  const cross = await dental.data({ table: 'patients', filters: one, single: 'maybeSingle' });
  assert.equal(cross.body.data, null);
  // clinic_settings: .eq("id", 1).single() returns this clinic's row (convention 11)
  const settings = await dental.data({ table: 'clinic_settings', filters: [{ column: 'id', op: 'eq', value: 1 }], single: 'single' });
  assert.equal(settings.body.data.name, 'عيادة الأسنان');
});

test('insert: object or array, organization_id from the context, json/jsonb and arrays, returning', async () => {
  const one = await admin.data({
    table: 'patients',
    action: 'insert',
    values: { patient_id: 'P-NEW-1', name: 'New One', tags: ['a', 'b'], meta: { visits: [1, 2], note: 'x' } },
    returning: true,
  });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.length, 1);
  const row = one.body.data[0];
  assert.equal(row.organization_id, ORG.physio, 'DEFAULT app_org_id()');
  assert.deepEqual(row.tags, ['a', 'b']);
  assert.deepEqual(row.meta, { visits: [1, 2], note: 'x' });
  assert.equal(row.vip, false, 'column defaults apply');

  const arrJson = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-NEW-J', name: 'J', meta: ['x', 'y'] } });
  assert.deepEqual(arrJson.body.data[0].meta, ['x', 'y'], 'a JS array into jsonb stays a JSON array');
  const strJson = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-NEW-S', name: 'S', meta: 'plain' } });
  assert.equal(strJson.body.data[0].meta, 'plain');

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
    filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-3' }],
  });
  assert.equal(moveUpdate.status, 403);
  const upsert = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-DEN-1', name: 'hijack', organization_id: ORG.dental } });
  assert.equal(upsert.status, 403);
  const same = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-OWN-1', name: 'ok', organization_id: ORG.physio } });
  assert.equal(same.status, 200, 'its own organization_id is accepted');
  for (const [user, org] of [[USER.physioAdmin.id, ORG.physio], [USER.dentalAdmin.id, ORG.dental]]) {
    const { rows } = await h.asUser(user, org, "select count(*)::int as n from patients where patient_id like 'P-EVIL-%'");
    assert.equal(rows[0].n, 0);
  }
  // the RLS WITH CHECK policy is the backstop: an upsert that would take over
  // another clinic's row cannot touch it
  const takeover = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-DEN-1', name: 'hijack' } });
  assert.notEqual(takeover.status, 200);
  const den = await dental.data({ table: 'patients', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-1' }], single: 'single' });
  assert.equal(den.body.data.name, 'Dental Only');
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
  // the table owner has no RLS context, so count as the clinic admin
  const { rows } = await h.asUser(USER.physioAdmin.id, ORG.physio, 'select count(*)::int as n from patients');
  assert.ok(rows[0].n >= 3, 'nothing was deleted');
});

test('update: returns updated rows and count; other clinics are invisible', async () => {
  const res = await admin.data({
    table: 'patients',
    action: 'update',
    values: { diagnosis: 'Updated', meta: { k: 1 } },
    filters: [{ column: 'patient_id', op: 'in', value: ['P-PHY-2', 'P-DEN-1'] }],
    count: 'exact',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.deepEqual(res.body.data.map((r) => [r.patient_id, r.diagnosis, r.meta]), [['P-PHY-2', 'Updated', { k: 1 }]]);
  const den = await dental.data({ table: 'patients', columns: 'diagnosis', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-1' }] });
  assert.equal(den.body.data[0].diagnosis, 'Caries', 'the other clinic was not touched');
  const minimal = await admin.data({ table: 'patients', action: 'update', values: { age: 46 }, filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-2' }], returning: false });
  assert.equal(minimal.body.data, null);
});

test('delete: returns deleted rows; cannot reach other clinics', async () => {
  await admin.data({ table: 'patients', action: 'insert', values: [{ patient_id: 'P-DEL-1', name: 'd1' }, { patient_id: 'P-DEL-2', name: 'd2' }] });
  const res = await admin.data({ table: 'patients', action: 'delete', filters: [{ column: 'patient_id', op: 'like', value: 'P-DEL-%' }], columns: 'patient_id' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((r) => r.patient_id).sort(), ['P-DEL-1', 'P-DEL-2']);
  const cross = await admin.data({ table: 'patients', action: 'delete', filters: [{ column: 'patient_id', op: 'eq', value: 'P-DEN-1' }], count: 'exact' });
  assert.equal(cross.status, 200);
  assert.equal(cross.body.count, 0);
  assert.deepEqual(cross.body.data, []);
  const { rows } = await h.asUser(USER.dentalAdmin.id, ORG.dental, "select count(*)::int as n from patients where patient_id = 'P-DEN-1'");
  assert.equal(rows[0].n, 1);
});

test('upsert: onConflict validated, ON CONFLICT DO UPDATE of the provided columns, default = primary key', async () => {
  const res = await admin.data({
    table: 'patients',
    action: 'upsert',
    onConflict: 'patient_id',
    values: [
      { patient_id: 'P-PHY-1', name: 'Ahmed Ali (edited)' },
      { patient_id: 'P-UPS-1', name: 'Upserted' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = Object.fromEntries(res.body.data.map((r) => [r.patient_id, r]));
  assert.equal(byId['P-PHY-1'].name, 'Ahmed Ali (edited)');
  assert.equal(byId['P-PHY-1'].diagnosis, 'Back pain', 'columns not provided are kept');
  assert.equal(byId['P-UPS-1'].organization_id, ORG.physio);

  const byPk = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-UPS-1', name: 'Again' } });
  assert.equal(byPk.body.data[0].name, 'Again');

  // composite primary key (organization_id, id) of clinic_settings: the
  // frontend upserts {id: 1, ...} and organization_id comes from the context
  const settings = await admin.data({ table: 'clinic_settings', action: 'upsert', values: { id: 1, subtitle: 'جديد' } });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  assert.equal(settings.body.data[0].subtitle, 'جديد');
  assert.equal(settings.body.data[0].name, 'عيادة العلاج الطبيعي');

  const ignore = await admin.data({ table: 'patients', action: 'upsert', values: { patient_id: 'P-UPS-1', name: 'Ignored' }, ignoreDuplicates: true });
  assert.deepEqual(ignore.body.data, []);

  const notUnique = await admin.data({ table: 'patients', action: 'upsert', onConflict: 'name', values: { patient_id: 'P-UPS-2', name: 'x' } });
  assert.equal(notUnique.status, 400);
  assert.equal(notUnique.body.error.code, '42P10');
  const unknownCol = await admin.data({ table: 'patients', action: 'upsert', onConflict: 'nope', values: { patient_id: 'P-UPS-2', name: 'x' } });
  assert.equal(unknownCol.status, 400);
  assert.equal(unknownCol.body.error.code, 'invalid_column');
});

test('PostgreSQL errors: 23505 → 409, RLS → 403, others → 400, always {error:{message, code}}', async () => {
  const dup = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-PHY-1', name: 'dup' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, '23505');
  assert.deepEqual(Object.keys(dup.body.error).sort(), ['code', 'message']);

  // the doctor may read bookings but not write them: WITH CHECK fails
  const doctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  const rls = await doctor.data({ table: 'bookings', action: 'insert', values: { booking_id: 'B-DOC-1', patient_id: 'P-PHY-1' } });
  assert.equal(rls.status, 403);
  assert.equal(rls.body.error.code, '42501');
  assert.match(rls.body.error.message, /row-level security/);

  const check = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-BAD-G', name: 'g', gender: 'X' } });
  assert.equal(check.status, 400);
  assert.equal(check.body.error.code, '23514');
  const notNull = await admin.data({ table: 'patients', action: 'insert', values: { patient_id: 'P-BAD-N' } });
  assert.equal(notNull.status, 400);
  assert.equal(notNull.body.error.code, '23502');
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
    { table: 'invitations' },
    { table: 'platform_admins' },
    { table: 'schema_migrations' },
    { table: 'no_rls_notes' },
    { table: 'rls_not_forced' },
    { table: 'nope_table' },
    { table: ['patients'] },
    { table: 'patients', columns: 'patient_id, (select 1)' },
    { table: 'patients', columns: 'patient_id as x' },
    { table: 'patients', columns: 'name::text' },
    { table: 'patients', columns: '*, organizations(*)' },
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
    { table: 'patients', action: 'update', values: { 'name = 1, age': 2 }, filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-2' }] },
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

test('branch scoping: rows of the member branches only; inserts default to the current branch', async () => {
  const recep = await h.as('physioReception', { slug: 'demo-physio' });
  const seen = await recep.data({ table: 'bookings', columns: 'booking_id,branch_id' });
  assert.deepEqual(seen.body.data, [{ booking_id: 'B-PHY-EAST-1', branch_id: 'br-physio-east' }]);
  const all = await admin.data({ table: 'bookings', columns: 'booking_id', order: [{ column: 'booking_id' }] });
  assert.deepEqual(all.body.data.map((b) => b.booking_id), ['B-PHY-EAST-1', 'B-PHY-MAIN-1'], 'admin: every branch of the clinic only');

  const ins = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: 'B-REC-1', patient_id: 'P-PHY-2', date: '2026-11-01' } });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(ins.body.data[0].branch_id, 'br-physio-east', 'DEFAULT app_branch_id()');
  assert.equal(ins.body.data[0].date, '2026-11-01');

  const otherBranch = await recep.data({ table: 'bookings', action: 'insert', values: { booking_id: 'B-REC-2', patient_id: 'P-PHY-2', branch_id: 'br-physio-main' } });
  assert.equal(otherBranch.status, 403, 'branch_scope WITH CHECK');
  const move = await recep.data({ table: 'bookings', action: 'update', values: { status: 'done' }, filters: [{ column: 'booking_id', op: 'eq', value: 'B-PHY-MAIN-1' }] });
  assert.deepEqual(move.body.data, [], 'a booking of another branch is invisible');

  const adminEast = h.client({ cookie: (await h.login(USER.physioAdmin.email)).cookie, slug: 'demo-physio', branch: 'br-physio-east' });
  const a = await adminEast.data({ table: 'bookings', action: 'insert', values: { booking_id: 'B-ADM-E', patient_id: 'P-PHY-1' } });
  assert.equal(a.body.data[0].branch_id, 'br-physio-east', 'X-Branch-Id picks the default branch');
  const foreignBranch = await admin.data({ table: 'bookings', action: 'insert', values: { booking_id: 'B-ADM-X', patient_id: 'P-PHY-1', branch_id: 'br-dental-main' } });
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
  const after = await admin.data({ table: 'patients', columns: 'patient_id,nickname', filters: [{ column: 'patient_id', op: 'eq', value: 'P-PHY-2' }] });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(after.body.data, [{ patient_id: 'P-PHY-2', nickname: null }]);
});
