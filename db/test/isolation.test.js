// Tenant isolation (plan task 2.5; NFR-001, AT-05; docs/05 conventions 4-9).
//
//   scripts/dev-db.sh reset <port>; DATABASE_URL=... node --test db/test/
//
// Every table that carries organization_id is discovered from the catalog,
// so a new clinic table is covered (or flagged) without editing this file.
// All checks run as the table owner (the API's database user) under FORCE
// ROW LEVEL SECURITY, with the request context the API sets, inside
// transactions that are rolled back.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLATFORM_TABLES, TEMPLATE_TABLES, PUBLIC_READ, ensureDatabase, inTx, setContext,
  expectError, loadFixtures, actAs, catalog, suffix, ident, insertCopy,
} = require('./helpers');

// Text columns that take part in organization-scoped unique constraints:
// a copied row gets a fresh value there so only the policy can refuse it.
const UNIQUE_TEXT = {
  branches: ['name'], staff: ['email'], custom_sections: ['slug'], payments: ['receipt_no'],
  patients: ['national_id', 'medical_file_no'], patient_files: ['storage_path'],
  treatment_methods: ['name'], template_categories: ['name'],
};
const NULLABLE_ORG = new Set(['audit_events', ...TEMPLATE_TABLES]);
const ROLES = ['admin', 'receptionist', 'doctor', 'therapist', 'receptionist2'];

let fx;
let tables; // [{ table, pk: [...] }]

before(async () => {
  await ensureDatabase();
  await inTx(async (c) => {
    fx = await loadFixtures(c);
    tables = (await catalog(c)).clinic;
  });
});

// A copy of `row` that differs in its primary key and unique text columns.
function freshCopy(table, row, s) {
  const copy = { ...row };
  if (table === 'audit_events') delete copy.id; // bigserial
  else if (table !== 'clinic_settings') copy[tablesPk(table)] = `${row[tablesPk(table)]}-T${s}`;
  for (const col of UNIQUE_TEXT[table] || []) if (copy[col] != null) copy[col] = `${copy[col]}-T${s}`;
  return copy;
}
function tablesPk(table) {
  return tables.find((t) => t.table === table).pk[0];
}
function pkWhere(table, row, offset = 1) {
  const pk = tables.find((t) => t.table === table).pk;
  return {
    sql: pk.map((col, i) => `${ident(col)} = $${i + offset}`).join(' and '),
    params: pk.map((col) => row[col]),
  };
}

// One row of each clinic table per organization, read in the system context.
async function sampleRows(c) {
  await setContext(c, { system: true });
  const out = {};
  for (const { table } of tables) {
    out[table] = {};
    for (const slug of ['demo-physio', 'demo-dental']) {
      const { rows } = await c.query(
        `select * from public.${ident(table)} where organization_id = $1 order by 1 limit 1`, [fx.orgs[slug]]);
      out[table][slug] = rows[0];
    }
  }
  return out;
}

async function countsByOrg(c, table) {
  const { rows: [r] } = await c.query(
    `select count(*)::int as total,
            count(*) filter (where organization_id = $1)::int as physio,
            count(*) filter (where organization_id = $2)::int as dental,
            count(*) filter (where organization_id is null)::int as global
       from public.${ident(table)}`, [fx.orgs['demo-physio'], fx.orgs['demo-dental']]);
  return r;
}

// Rows visible without any role in organization `slug`: the public-read
// policies, and the user's own staff row (0001 "staff read own+admin all":
// the frontend reads it to tell a disabled account from a missing one).
async function publicRowCount(c, table, slug, userId = null) {
  let where = PUBLIC_READ[table];
  if (table === 'staff' && userId) where = `auth_uid = '${userId}'`;
  if (!where) return 0;
  await setContext(c, { system: true });
  const { rows: [r] } = await c.query(
    `select count(*)::int as n from public.${ident(table)} where organization_id = $1 and ${where}`,
    [fx.orgs[slug]]);
  return r.n;
}

test('catalog: every table with organization_id is a clinic table under FORCE RLS, or a known platform table', async () => {
  await inTx(async (c) => {
    const cat = await catalog(c);
    // Platform tables that carry organization_id have no RLS (convention 4).
    assert.deepEqual(cat.platform.map((t) => t.table).sort(),
      ['invitations', 'member_branches', 'organization_members', 'organization_modules', 'subscriptions']);
    for (const t of cat.platform) assert.equal(t.rls, false, `${t.table} must not have RLS`);

    // Every other public table (except schema_migrations) is a clinic table.
    const { rows: all } = await c.query(`
      select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`);
    const clinic = new Set(cat.clinic.map((t) => t.table));
    const unclassified = all.map((r) => r.relname)
      .filter((n) => !clinic.has(n) && !PLATFORM_TABLES.includes(n) && n !== 'schema_migrations');
    assert.deepEqual(unclassified, [], 'public tables without organization_id that are not platform tables');
    assert.equal(cat.clinic.length, 25);

    for (const t of cat.clinic) {
      assert.ok(t.rls && t.forced, `${t.table}: RLS must be enabled and FORCED`);
      const { rows: [col] } = await c.query(`
        select a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as def
          from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = $1::regclass and a.attname = 'organization_id'`, [`public.${t.table}`]);
      assert.equal(col.def, 'app_org_id()', `${t.table}.organization_id default`);
      assert.equal(col.not_null, !NULLABLE_ORG.has(t.table), `${t.table}.organization_id NOT NULL`);

      const { rows: pol } = await c.query(`
        select polname, polpermissive, pg_get_expr(polqual, polrelid) as qual,
               pg_get_expr(polwithcheck, polrelid) as wcheck
          from pg_policy where polrelid = $1::regclass and polname = 'tenant_isolation'`, [`public.${t.table}`]);
      assert.equal(pol.length, 1, `${t.table}: tenant_isolation policy`);
      assert.equal(pol[0].polpermissive, false, `${t.table}: tenant_isolation must be RESTRICTIVE`);
      assert.match(pol[0].qual, /app_is_system\(\)/);
      assert.match(pol[0].qual, /organization_id = \( SELECT app_org_id\(\)/);
      assert.match(pol[0].wcheck, /organization_id = \( SELECT app_org_id\(\)/);
      assert.doesNotMatch(pol[0].wcheck, /IS NULL/, `${t.table}: new rows always belong to the current clinic`);

      const { rows: fk } = await c.query(`
        select 1 from pg_constraint
         where conrelid = $1::regclass and contype = 'f' and confrelid = 'public.organizations'::regclass`,
      [`public.${t.table}`]);
      assert.equal(fk.length, 1, `${t.table}: FK organization_id -> organizations`);
      const { rows: idx } = await c.query(`
        select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid = $1::regclass and a.attname = 'organization_id'`, [`public.${t.table}`]);
      assert.ok(idx.length >= 1, `${t.table}: index led by organization_id`);
    }

    // Convention 9: every unique index on a clinic table is per organization
    // (or the single-column global primary key, or covers global rows only).
    const { rows: uniq } = await c.query(`
      select c.relname as table, ic.relname as index, pg_get_indexdef(i.indexrelid) as def
        from pg_index i join pg_class c on c.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
       where c.relname = any ($1) and c.relnamespace = 'public'::regnamespace and i.indisunique
         and not (i.indisprimary and i.indnatts = 1)`, [cat.clinic.map((t) => t.table)]);
    const unscoped = uniq.filter((u) => !/\(organization_id\b/.test(u.def) && !/WHERE \(organization_id IS NULL\)/.test(u.def));
    assert.deepEqual(unscoped, [], 'unique indexes that are not organization-scoped');
    for (const name of ['custom_sections_org_slug_key', 'payments_org_receipt_no_key', 'staff_org_email_lower_uniq',
      'patients_org_national_id_uniq', 'patients_org_medical_file_uniq', 'patient_files_org_storage_path_key',
      'treatment_methods_org_name_key', 'tpl_cat_org_name_uniq', 'branches_org_name_key', 'clinic_settings_pkey']) {
      assert.ok(uniq.some((u) => u.index === name), `missing unique ${name}`);
    }
    const settingsPk = uniq.find((u) => u.index === 'clinic_settings_pkey');
    assert.match(settingsPk.def, /\(organization_id, id\)/);
  });
});

test('the seed has rows of both clinics in every clinic table (the checks below are not vacuous)', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    for (const { table } of tables) {
      const r = await countsByOrg(c, table);
      assert.ok(r.physio >= 1 && r.dental >= 1, `${table}: needs seeded rows in both clinics (${JSON.stringify(r)})`);
    }
  });
});

test('members of demo-physio (every role) never see demo-dental rows; the admin sees its own rows', async () => {
  await inTx(async (c) => {
    for (const role of ROLES) {
      await actAs(c, fx, role, 'demo-physio');
      for (const { table } of tables) {
        const r = await countsByOrg(c, table);
        assert.equal(r.dental, 0, `${role} sees demo-dental rows in ${table}`);
        assert.equal(r.total, r.physio + r.global, `${role} sees rows of another clinic in ${table}`);
        if (!TEMPLATE_TABLES.includes(table)) assert.equal(r.global, 0, `${table}: rows without organization`);
        if (role === 'admin') assert.ok(r.physio >= 1, `admin sees none of its own rows in ${table}`);
      }
    }
  });
});

test('demo-physio admin: INSERT into demo-dental is refused; UPDATE/DELETE of demo-dental rows affect 0 rows', async () => {
  await inTx(async (c) => {
    // Composite foreign keys are deferred to commit; check them per statement
    // here so the positive controls prove the copies are valid rows.
    await c.query('set constraints all immediate');
    const sample = await sampleRows(c);
    const s = suffix();
    for (const { table } of tables) {
      const dental = sample[table]['demo-dental'];
      const physio = sample[table]['demo-physio'];
      await actAs(c, fx, 'admin', 'demo-physio');

      // INSERT a row that names demo-dental: refused by tenant_isolation.
      await expectError(c, ...insertSql(table, { ...freshCopy(table, dental, s) }), /^42501 .*row-level security/);
      // Same row without organization_id gets the current clinic (DEFAULT
      // app_org_id()); for a demo-physio copy that is a valid insert.
      if (table !== 'clinic_settings') {
        const own = freshCopy(table, physio, `${s}a`);
        delete own.organization_id;
        await c.query('savepoint own');
        await insertCopy(c, table, own);
        const where = table === 'audit_events' ? null : pkWhere(table, own);
        if (where) {
          const { rows: [r] } = await c.query(
            `select organization_id from public.${ident(table)} where ${where.sql}`, where.params);
          assert.equal(r.organization_id, fx.orgs['demo-physio'], `${table}: default organization_id`);
        }
        await c.query('rollback to savepoint own');
      }

      // UPDATE / DELETE of the other clinic's rows: nothing is visible.
      const pk = tables.find((t) => t.table === table).pk;
      const set = pk.map((col) => `${ident(col)} = ${ident(col)}`).join(', ');
      const upd = await c.query(`update public.${ident(table)} set ${set} where organization_id = $1`, [fx.orgs['demo-dental']]);
      assert.equal(upd.rowCount, 0, `${table}: update reached demo-dental rows`);
      const w = pkWhere(table, dental);
      const upd2 = await c.query(`update public.${ident(table)} set ${set} where ${w.sql}`, w.params);
      assert.equal(upd2.rowCount, 0, `${table}: update by key reached a demo-dental row`);
      const del = await c.query(`delete from public.${ident(table)} where organization_id = $1`, [fx.orgs['demo-dental']]);
      assert.equal(del.rowCount, 0, `${table}: delete reached demo-dental rows`);

      // Moving an own row to demo-dental is refused (or matches no row for
      // tables without an UPDATE policy); either way it stays in demo-physio.
      const wp = pkWhere(table, physio, 2);
      await c.query('savepoint move');
      try {
        await c.query(`update public.${ident(table)} set organization_id = $1 where ${wp.sql}`,
          [fx.orgs['demo-dental'], ...wp.params]);
      } catch (err) {
        assert.equal(err.code, '42501', `${table}: ${err.message}`);
      }
      await c.query('rollback to savepoint move');
    }

    // Nothing of demo-dental changed.
    await setContext(c, { system: true });
    for (const { table } of tables) {
      const dental = sample[table]['demo-dental'];
      const w = pkWhere(table, dental, 2);
      const { rows } = await c.query(
        `select 1 from public.${ident(table)} where organization_id = $1 and ${w.sql}`, [fx.orgs['demo-dental'], ...w.params]);
      assert.equal(rows.length, 1, `${table}: demo-dental row changed`);
      const physio = sample[table]['demo-physio'];
      const wp = pkWhere(table, physio, 2);
      const { rows: still } = await c.query(
        `select 1 from public.${ident(table)} where organization_id = $1 and ${wp.sql}`, [fx.orgs['demo-physio'], ...wp.params]);
      assert.equal(still.length, 1, `${table}: demo-physio row moved to another clinic`);
    }
  });
});

function insertSql(table, row) {
  const cols = Object.keys(row);
  return [`insert into public.${ident(table)} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k]))];
}

test('app.org_id of a clinic the user is not a member of: no rows (except public branding) and no writes', async () => {
  await inTx(async (c) => {
    const sample = await sampleRows(c);
    const s = suffix();
    for (const { table } of tables) {
      const expected = await publicRowCount(c, table, 'demo-dental');
      // demo-physio's admin, pointed at demo-dental.
      await actAs(c, fx, 'admin', 'demo-physio', { org: 'demo-dental' });
      assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null);
      const r = await countsByOrg(c, table);
      assert.equal(r.physio, 0, `${table}: rows of the user's own clinic under another context`);
      assert.equal(r.total, expected, `${table}: visible rows for a non-member (${JSON.stringify(r)})`);

      await expectError(c, ...insertSql(table, freshCopy(table, sample[table]['demo-dental'], s)), /^42501 /);
      const pk = tables.find((t) => t.table === table).pk;
      const set = pk.map((col) => `${ident(col)} = ${ident(col)}`).join(', ');
      assert.equal((await c.query(`update public.${ident(table)} set ${set}`)).rowCount, 0, `${table}: update`);
      assert.equal((await c.query(`delete from public.${ident(table)}`)).rowCount, 0, `${table}: delete`);
    }
  });
});

test('no app.org_id: no clinic rows at all and no writes', async () => {
  await inTx(async (c) => {
    const sample = await sampleRows(c);
    const s = suffix();
    for (const who of [{ user: fx.user('admin', 'demo-physio') }, { user: null }]) {
      for (const { table } of tables) {
        await setContext(c, who);
        assert.equal((await countsByOrg(c, table)).total, 0, `${table}: visible without a clinic context`);
        const row = freshCopy(table, sample[table]['demo-physio'], s);
        delete row.organization_id;
        await expectError(c, ...insertSql(table, row), /^(42501|23502) /);
        assert.equal((await c.query(`delete from public.${ident(table)}`)).rowCount, 0, `${table}: delete`);
      }
    }
  });
});

test('a Super Admin without membership sees no clinic rows (BR-008)', async () => {
  await inTx(async (c) => {
    await setContext(c, { user: fx.superAdmin });
    assert.equal((await c.query('select public.is_super_admin() as s')).rows[0].s, true);
    await actAs(c, fx, 'admin', 'demo-physio');
    assert.equal((await c.query('select public.is_super_admin() as s')).rows[0].s, false);

    for (const { table } of tables) {
      // No clinic context (what the API does for a Super Admin).
      await setContext(c, { user: fx.superAdmin });
      assert.equal((await countsByOrg(c, table)).total, 0, `${table}: Super Admin without a clinic context`);
      // Even if a clinic context were set, only the public branding rows
      // that an anonymous visitor of the clinic also sees are readable.
      const expected = await publicRowCount(c, table, 'demo-physio');
      await actAs(c, fx, 'super', 'demo-physio');
      assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null);
      assert.equal((await countsByOrg(c, table)).total, expected, `${table}: Super Admin in a clinic context`);
    }
  });
});

test('a disabled membership, a disabled account and a suspended clinic lose access', async () => {
  const check = async (c, label, role) => {
    for (const { table } of tables) {
      const expected = await publicRowCount(c, table, 'demo-physio', fx.user(role, 'demo-physio'));
      await actAs(c, fx, role, 'demo-physio');
      assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null, label);
      assert.equal((await countsByOrg(c, table)).total, expected, `${label}: ${table}`);
    }
    await expectError(c, `insert into public.patients (patient_id, name) values ($1, 'x')`, [`P-T-${suffix()}`], /^42501 /);
  };
  await inTx(async (c) => {
    await actAs(c, fx, 'receptionist', 'demo-physio');
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, 'receptionist');
    await c.query(`update public.organization_members set status = 'disabled'
                    where user_id = $1 and organization_id = $2`, [fx.user('receptionist', 'demo-physio'), fx.orgs['demo-physio']]);
    await check(c, 'disabled membership', 'receptionist');
  });
  await inTx(async (c) => {
    await c.query(`update auth.users set status = 'disabled' where id = $1`, [fx.user('doctor', 'demo-physio')]);
    await check(c, 'disabled account', 'doctor');
  });
  await inTx(async (c) => {
    await c.query(`update public.organizations set status = 'suspended', status_reason = 'test', suspended_at = now()
                    where id = $1`, [fx.orgs['demo-physio']]);
    await check(c, 'suspended clinic', 'admin');
    // demo-dental is not affected.
    await actAs(c, fx, 'admin', 'demo-dental');
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, 'admin');
    assert.ok((await countsByOrg(c, 'patients')).dental >= 1);
  });
});

test('global templates (organization_id NULL) are readable by both clinics and writable by neither', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    const { rows: [g] } = await c.query(`
      select (select count(*)::int from treatment_templates where organization_id is null) as templates,
             (select count(*)::int from treatment_methods where organization_id is null) as methods,
             (select count(*)::int from template_categories where organization_id is null) as categories`);
    assert.deepEqual(g, { templates: 49, methods: 9, categories: 2 }, 'the 0001 library is global');

    for (const slug of ['demo-physio', 'demo-dental']) {
      const other = slug === 'demo-physio' ? 'demo-dental' : 'demo-physio';
      for (const role of ['admin', 'doctor', 'therapist']) {
        await actAs(c, fx, role, slug);
        const { rows: [r] } = await c.query(`
          select (select count(*)::int from treatment_templates where organization_id is null) as templates,
                 (select count(*)::int from treatment_methods where organization_id is null) as methods,
                 (select count(*)::int from template_categories where organization_id is null) as categories,
                 (select count(*)::int from treatment_templates where organization_id = $1) as other_clinic`,
        [fx.orgs[other]]);
        assert.deepEqual(r, { ...g, other_clinic: 0 }, `${role}@${slug}`);
      }

      // Writes (admin and doctor may write their own templates).
      for (const role of ['admin', 'doctor']) {
        await actAs(c, fx, role, slug);
        for (const table of ['treatment_templates', 'treatment_methods', 'template_categories']) {
          const upd = await c.query(`update ${table} set name = name || ' (x)' where organization_id is null`);
          assert.equal(upd.rowCount, 0, `${role}@${slug}: updated global ${table}`);
          const del = await c.query(`delete from ${table} where organization_id is null`);
          assert.equal(del.rowCount, 0, `${role}@${slug}: deleted global ${table}`);
        }
        // New rows cannot be global.
        await expectError(c, `insert into treatment_templates (template_id, name, organization_id) values ($1, 'g', null)`,
          [`TPL-T-${suffix()}`], /^42501 /);
        await expectError(c, `insert into treatment_methods (method_id, name, organization_id) values ($1, $2, null)`,
          [`TM-T-${suffix()}`, `m-${suffix()}`], /^42501 /);
        // An own row cannot be turned into a global one.
        await expectError(c, `update treatment_templates set organization_id = null where organization_id = $1`,
          [fx.orgs[slug]], /^42501 /);
        // A new template gets the current clinic.
        const id = `TPL-T-${suffix()}`;
        await c.query(`insert into treatment_templates (template_id, name) values ($1, 'own')`, [id]);
        const { rows: [own] } = await c.query(`select organization_id from treatment_templates where template_id = $1`, [id]);
        assert.equal(own.organization_id, fx.orgs[slug]);
      }
    }

    await setContext(c, { system: true });
    const { rows: [after] } = await c.query(`
      select count(*)::int as n from treatment_templates where organization_id is null and name like '% (x)'`);
    assert.equal(after.n, 0);
  });
});

test('inside a clinic, the 0001 role policies still apply per role', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'receptionist', 'demo-physio');
    assert.ok((await countsByOrg(c, 'patients')).physio >= 1, 'receptionist reads patients');
    assert.equal((await countsByOrg(c, 'treatment_templates')).total, 0, 'receptionist does not read templates');
    assert.equal((await countsByOrg(c, 'treatments')).total, 0, 'receptionist does not read treatments');
    assert.equal((await countsByOrg(c, 'audit_events')).total, 0, 'only the admin reads the audit log');
    await expectError(c, `insert into treatments (treatment_id, patient_id, therapist_id) values ($1, 'P-PHY-01', 'ST-PHY-THERAPIST')`,
      [`TRT-T-${suffix()}`], /^42501 /);

    await actAs(c, fx, 'doctor', 'demo-physio');
    await expectError(c, `insert into bookings (booking_id, patient_id) values ($1, 'P-PHY-01')`, [`BK-T-${suffix()}`], /^42501 /);
    assert.equal((await countsByOrg(c, 'staff')).total, 1, 'non-admins read only their own staff row');

    await actAs(c, fx, 'therapist', 'demo-physio');
    assert.equal((await countsByOrg(c, 'invoices')).total, 0, 'therapists do not read invoices');

    await actAs(c, fx, 'admin', 'demo-physio');
    assert.ok((await countsByOrg(c, 'audit_events')).physio >= 1, 'the admin reads the clinic audit log');
    assert.equal((await countsByOrg(c, 'staff')).physio, 5);
    // Members write audit events for their clinic; a NULL organization
    // (platform event) is only for the system context.
    await c.query(`insert into audit_events (action, table_name, target_type, target_id, result) values ('t', 'x', 'test', '1', 'denied')`);
    await expectError(c, `insert into audit_events (action, table_name, organization_id) values ('t', 'x', null)`, [], /^42501 /);
    await setContext(c, { system: true });
    await c.query(`insert into audit_events (action, table_name, organization_id) values ('platform', 'organizations', null)`);
    assert.ok((await countsByOrg(c, 'audit_events')).global >= 2);
  });
});
