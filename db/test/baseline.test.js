// Tests for db/migrate.js and db/migrations/0001_baseline.sql (plan task 2.2).
//
//   scripts/dev-db.sh reset 55001          # fresh cPanel-like database
//   DATABASE_URL=postgres://... node --test db/test/
//
// The tests run the real migration CLI against DATABASE_URL (it applies
// 0001 on a fresh database, or nothing if it is already there), then check
// the catalog and run a single-clinic smoke test under the OLD role model
// (app_role() reads staff). Every write happens inside a transaction that is
// rolled back, so the database is left exactly as the migration made it and
// other test files can share it.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const { migrate, listMigrations, MigrationError } = require('../migrate.js');

const DATABASE_URL = process.env.DATABASE_URL;
const REPO_ROOT = path.join(__dirname, '..', '..');

// The 25 RPC functions of the baseline: the 23 that src/*.jsx calls through
// sb.rpc(...) plus the two legacy v1 treatment-method RPCs that are still
// defined (not called by the current frontend).
const RPCS_CALLED_BY_FRONTEND = [
  'record_quick_payment', 'list_invoices_filtered', 'delete_payment_receipt',
  'upsert_treatment_method', 'delete_treatment_method', 'set_treatment_method_status',
  'list_treatment_templates', 'get_treatment_template', 'create_treatment_template',
  'update_treatment_template', 'duplicate_treatment_template', 'set_treatment_template_status',
  'delete_treatment_template', 'apply_template_to_patient',
  'list_template_categories', 'upsert_template_category', 'set_template_category_status',
  'delete_template_category',
  'create_treatment', 'update_treatment', 'delete_treatment', 'list_treatments', 'get_treatment',
];
const LEGACY_RPCS = ['create_treatment_method', 'update_treatment_method'];

function requireDb() {
  assert.ok(DATABASE_URL, 'DATABASE_URL is not set: run `scripts/dev-db.sh reset 55001` and export the URL it prints');
}

async function connect() {
  const client = new Client({ connectionString: DATABASE_URL, application_name: 'clinicsys-db-test' });
  await client.connect();
  return client;
}

// Runs fn(client) inside BEGIN ... ROLLBACK.
async function inRolledBackTx(fn) {
  const client = await connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

// Expects `sql` to fail; uses a savepoint so the surrounding transaction survives.
async function expectError(client, sql, params, pattern) {
  await client.query('savepoint expect_error');
  try {
    await client.query(sql, params);
  } catch (err) {
    await client.query('rollback to savepoint expect_error');
    if (pattern) assert.match(`${err.code} ${err.message}`, pattern);
    return err;
  }
  await client.query('rollback to savepoint expect_error');
  assert.fail(`expected an error from: ${sql}`);
}

function runMigrateCli(env, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, ['db/migrate.js'], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000,
  });
}

const suffix = () => crypto.randomBytes(4).toString('hex');

test('node db/migrate.js (from the repo root) applies the baseline once; a second run applies nothing', () => {
  requireDb();
  const first = runMigrateCli({ DATABASE_URL });
  assert.equal(first.status, 0, `first run failed:\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /applied {2}0001_baseline\.sql|nothing to apply/);

  const second = runMigrateCli({ DATABASE_URL });
  assert.equal(second.status, 0, `second run failed:\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /nothing to apply/);
  assert.doesNotMatch(second.stdout, /applied {2}/);
});

test('catalog: schema_migrations, 25 RPCs, no extensions, policies TO PUBLIC, no Supabase leftovers', async () => {
  requireDb();
  const c = await connect();
  try {
    const sm = await c.query(`
      select column_name, data_type, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'schema_migrations' order by ordinal_position`);
    assert.deepEqual(sm.rows.map((r) => `${r.column_name}:${r.data_type}`),
      ['version:text', 'applied_at:timestamp with time zone']);
    const versions = (await c.query('select version from public.schema_migrations')).rows.map((r) => r.version);
    assert.ok(versions.includes('0001_baseline'), `0001_baseline not recorded: ${versions}`);

    const fns = await c.query(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`,
      [[...RPCS_CALLED_BY_FRONTEND, ...LEGACY_RPCS]]);
    const present = new Set(fns.rows.map((r) => r.proname));
    const missing = [...RPCS_CALLED_BY_FRONTEND, ...LEGACY_RPCS].filter((n) => !present.has(n));
    assert.deepEqual(missing, [], 'missing RPC functions');
    assert.equal(RPCS_CALLED_BY_FRONTEND.length + LEGACY_RPCS.length, 25);

    // Every name src/*.jsx passes to sb.rpc() must exist (guards against drift).
    const srcDir = path.join(REPO_ROOT, 'src');
    if (fs.existsSync(srcDir)) {
      const called = new Set();
      for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith('.jsx'))) {
        const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
        for (const m of text.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)) called.add(m[1]);
      }
      assert.ok(called.size > 0, 'no .rpc() calls found in src/*.jsx');
      assert.deepEqual([...called].filter((n) => !present.has(n)), [], 'frontend calls an RPC that does not exist');
      assert.deepEqual([...called].sort(), [...RPCS_CALLED_BY_FRONTEND].sort(), 'RPC list in this test is out of date');
    }

    const ext = await c.query('select extname from pg_extension order by 1');
    assert.deepEqual(ext.rows.map((r) => r.extname), ['plpgsql']);

    const pol = await c.query(`select tablename, policyname, roles::text from pg_policies`);
    assert.ok(pol.rows.length >= 57, `expected at least the 57 baseline policies, got ${pol.rows.length}`);
    const nonPublic = pol.rows.filter((r) => r.roles !== '{public}');
    assert.deepEqual(nonPublic, [], 'policies must apply TO PUBLIC only');

    const storage = await c.query(`select count(*)::int as n from pg_namespace where nspname = 'storage'`);
    assert.equal(storage.rows[0].n, 0, 'schema storage must not exist');
    const supaRoles = await c.query(
      `select count(*)::int as n from pg_policies where roles && array['anon','authenticated','service_role']::name[]`);
    assert.equal(supaRoles.rows[0].n, 0);
    const pgcryptoFns = await c.query(
      `select count(*)::int as n from pg_proc where proname in ('crypt','gen_salt','gen_random_bytes','digest','hmac')`);
    assert.equal(pgcryptoFns.rows[0].n, 0, 'pgcrypto functions must not exist');

    // Every table that had RLS in Supabase still has it.
    const noRls = await c.query(`
      select relname from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'
         and not relrowsecurity and relname <> 'schema_migrations'`);
    const platformTables = new Set(['organizations', 'platform_admins', 'organization_members', 'member_branches',
      'invitations', 'specialties', 'modules', 'specialty_modules', 'organization_modules',
      'subscription_plans', 'subscriptions', 'reserved_slugs']); // no RLS by design (docs/05 rule 4)
    assert.deepEqual(noRls.rows.map((r) => r.relname).filter((n) => !platformTables.has(n)), []);

    // Seeds: kept (template library, default methods, settings row) and removed (accounts).
    const seed = await c.query(`
      select (select count(*)::int from clinic_settings where id = 1) as settings,
             (select count(*)::int from treatment_methods where method_id like 'TM-DFLT-%') as methods,
             (select count(*)::int from template_categories where category_id in ('TPC-SEED-SPINE','TPC-SEED-SHOULDER')) as categories,
             (select count(*)::int from treatment_templates where template_id like 'TPL-SEED-SPN-%') as spine,
             (select count(*)::int from treatment_templates where template_id like 'TPL-SEED-SHD-%') as shoulder,
             (select count(*)::int from staff where staff_id in ('ST-AMR','ST-ABDELRAHMAN','ST-ESMAIL','ST-MENNA','ST-DALIA','ST-RAWDA','ST-MARIAM')) as seeded_staff,
             (select count(*)::int from auth.users where lower(email) like '%@clinic.eg') as seeded_users`);
    assert.deepEqual(seed.rows[0],
      { settings: 1, methods: 9, categories: 2, spine: 35, shoulder: 14, seeded_staff: 0, seeded_users: 0 });
  } finally {
    await c.end();
  }
});

test('auth compat schema: auth.users, auth.uid(), auth.password_reset_tokens', async () => {
  requireDb();
  const cols = await inRolledBackTx(async (c) => {
    const r = await c.query(`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema = 'auth' and table_name = 'users'
       order by ordinal_position`);
    return r.rows;
  });
  assert.deepEqual(cols.map((r) => r.column_name), ['id', 'email', 'encrypted_password', 'raw_user_meta_data',
    'status', 'session_version', 'email_confirmed_at', 'last_sign_in_at', 'created_at', 'updated_at']);
  const byName = Object.fromEntries(cols.map((r) => [r.column_name, r]));
  assert.match(byName.id.column_default, /gen_random_uuid\(\)/);
  assert.equal(byName.email.is_nullable, 'NO');
  assert.equal(byName.session_version.is_nullable, 'NO');
  assert.equal(byName.session_version.column_default, '1');

  await inRolledBackTx(async (c) => {
    // auth.uid() is NULL until the API sets app.user_id for the transaction.
    assert.equal((await c.query('select auth.uid() as u')).rows[0].u, null);
    const { rows: [u] } = await c.query(
      `insert into auth.users (email) values ($1) returning id, status, session_version, raw_user_meta_data`,
      [`Case.${suffix()}@ClinicSys.test`]);
    assert.equal(u.status, 'active');
    assert.equal(u.session_version, 1);
    assert.deepEqual(u.raw_user_meta_data, {});
    await c.query(`select set_config('app.user_id', $1, true)`, [u.id]);
    assert.equal((await c.query('select auth.uid() as u')).rows[0].u, u.id);
    await c.query(`select set_config('app.user_id', '', true)`);
    assert.equal((await c.query('select auth.uid() as u')).rows[0].u, null);

    // Email is unique case-insensitively.
    const email = (await c.query('select email from auth.users where id = $1', [u.id])).rows[0].email;
    await expectError(c, 'insert into auth.users (email) values ($1)', [email.toLowerCase()], /^23505 /);
    await expectError(c, `update auth.users set status = 'banned' where id = $1`, [u.id], /^23514 /);

    // Reset tokens belong to a user and go away with it.
    await c.query(`insert into auth.password_reset_tokens (token_hash, user_id, expires_at)
                   values ($1, $2, now() + interval '1 hour')`, [suffix(), u.id]);
    await c.query('delete from auth.users where id = $1', [u.id]);
    const left = await c.query('select count(*)::int as n from auth.password_reset_tokens where user_id = $1', [u.id]);
    assert.equal(left.rows[0].n, 0);
  });

  // A transaction-local setting does not leak into the next transaction.
  const c = await connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true)`, [crypto.randomUUID()]);
    await c.query('commit');
    assert.equal((await c.query('select auth.uid() as u')).rows[0].u, null);
  } finally {
    await c.end();
  }
});

// Old role model: app_role() = staff.role of the active staff row whose
// auth_uid = auth.uid(). 0003_tenancy.sql replaces it; then this smoke no
// longer describes the database and is skipped (the tenancy tests take over).
async function appRoleReadsStaff() {
  const c = await connect();
  try {
    const { rows } = await c.query(`select pg_get_functiondef('public.app_role()'::regprocedure) as def`);
    return /from\s+staff\b/i.test(rows[0].def);
  } finally {
    await c.end();
  }
}

test('single-clinic smoke (old role model): admin records a quick payment and lists templates', async (t) => {
  requireDb();
  if (!(await appRoleReadsStaff())) {
    t.skip('public.app_role() no longer reads staff (0003_tenancy applied); covered by the tenancy tests');
    return;
  }
  await inRolledBackTx(async (c) => {
    const s = suffix();
    const email = `baseline-admin-${s}@clinicsys.test`;
    const { rows: [user] } = await c.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
      [email, { name: 'مدير الاختبار' }]);
    const staffId = `ST-BT-${s}`;
    await c.query(
      `insert into staff (staff_id, name, role, email, auth_uid, status) values ($1, $2, 'admin', $3, $4, 'active')`,
      [staffId, 'مدير الاختبار', email, user.id]);

    // Anonymous: no role. (The RPC guards do NOT refuse a NULL role — see
    // the todo test "RPC role guards refuse a caller without a role".)
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null);

    // Signed in as the admin (what the API will do inside each transaction).
    await c.query(`select set_config('app.user_id', $1, true)`, [user.id]);
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, 'admin');

    const patientId = `P-BT-${s}`;
    const bookingId = `B-BT-${s}`;
    const invoiceId = `INV-BT-${s}`;
    await c.query(`insert into patients (patient_id, name, phone, gender) values ($1, 'مريض تجريبي', '01000000000', 'M')`,
      [patientId]);
    await c.query(`insert into bookings (booking_id, patient_id, date, time, price) values ($1, $2, current_date, '10:00', 500)`,
      [bookingId, patientId]);
    await c.query(`insert into invoices (invoice_id, patient_id, amount) values ($1, $2, 300)`, [invoiceId, patientId]);

    // Same named arguments as src/supabase.jsx → sb.rpc('record_quick_payment', {...}).
    const allocations = [
      { type: 'appointment', id: bookingId, amount: 200 },
      { type: 'invoice', id: invoiceId, amount: 300 },
    ];
    const { rows: [{ r: pay }] } = await c.query(
      `select public.record_quick_payment(
         p_patient_id => $1, p_allocations => $2::jsonb, p_method => $3,
         p_reference => null, p_transaction_id => null, p_notes => $4,
         p_cashier_id => $5, p_cashier_name => $6, p_ip_address => $7) as r`,
      [patientId, JSON.stringify(allocations), 'cash', 'baseline test', staffId, 'مدير الاختبار', '127.0.0.1']);
    assert.match(pay.payment_id, /^PMT-\d{17}-[0-9a-f]{4}$/);
    assert.match(pay.receipt_no, /^RCT-\d{8}-\d{5}$/);
    assert.equal(Number(pay.amount), 500);

    const booking = (await c.query('select paid, payment_status from bookings where booking_id = $1', [bookingId])).rows[0];
    assert.deepEqual({ paid: Number(booking.paid), status: booking.payment_status }, { paid: 200, status: 'partial' });
    const invoice = (await c.query('select paid, status, payment_method from invoices where invoice_id = $1', [invoiceId])).rows[0];
    assert.deepEqual({ paid: Number(invoice.paid), status: invoice.status, method: invoice.payment_method },
      { paid: 300, status: 'paid', method: 'cash' });

    const payment = (await c.query('select * from payments where payment_id = $1', [pay.payment_id])).rows[0];
    assert.equal(payment.patient_id, patientId);
    assert.equal(Number(payment.amount), 500);
    assert.equal(payment.receipt_no, pay.receipt_no);
    assert.equal(payment.status, 'completed');
    assert.deepEqual(payment.allocations, allocations);

    const audit = (await c.query(
      `select actor_uid, actor_role, table_name, payload from audit_events where action = 'quick_payment' and row_pk = $1`,
      [pay.payment_id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_uid, user.id);
    assert.equal(audit[0].actor_role, 'admin');
    assert.equal(audit[0].table_name, 'payments');
    assert.equal(Number(audit[0].payload.amount), 500);

    // Over-paying is rejected and changes nothing (the RPC is all-or-nothing).
    await expectError(c,
      `select public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash')`,
      [patientId, JSON.stringify([{ type: 'appointment', id: bookingId, amount: 400 }])], /exceeds remaining/);
    assert.equal(Number((await c.query('select paid from bookings where booking_id = $1', [bookingId])).rows[0].paid), 200);
    const payCount = await c.query('select count(*)::int as n from payments where patient_id = $1', [patientId]);
    assert.equal(payCount.rows[0].n, 1);

    // Treatment-template library (seeded by the migration).
    const { rows: [{ r: all }] } = await c.query(
      `select public.list_treatment_templates(p_status => null, p_category => null, p_creator => null,
                                              p_search => null, p_sort => 'recent', p_limit => 500, p_offset => 0) as r`);
    assert.ok(all.count >= 49, `expected >= 49 templates, got ${all.count}`);
    assert.equal(all.limit, 500);
    assert.equal(all.offset, 0);
    const ids = new Set(all.rows.map((r) => r.template_id));
    for (const id of ['TPL-SEED-SPN-01', 'TPL-SEED-SPN-35', 'TPL-SEED-SHD-01', 'TPL-SEED-SHD-14']) {
      assert.ok(ids.has(id), `${id} missing from list_treatment_templates`);
    }
    const { rows: [{ r: shoulder }] } = await c.query(
      `select public.list_treatment_templates(p_category => $1, p_limit => 500) as r`, ['قوالب تشخيص الكتف']);
    assert.equal(shoulder.rows.filter((r) => r.template_id.startsWith('TPL-SEED-SHD-')).length, 14);
    assert.ok(shoulder.rows.every((r) => r.category === 'قوالب تشخيص الكتف'));
    const { rows: [{ r: found }] } = await c.query(
      `select public.list_treatment_templates(p_search => 'bursitis') as r`);
    assert.ok(found.rows.some((r) => r.template_id === 'TPL-SEED-SHD-14'), 'search by diagnosis (ilike) failed');

    // Role checks inside the RPCs still read staff: receptionists may not
    // read templates, and a deactivated staff row has no role at all.
    await c.query(`update staff set role = 'receptionist' where staff_id = $1`, [staffId]);
    await expectError(c, 'select public.list_treatment_templates()', [], /غير مصرح/);
    await c.query(`update staff set role = 'admin', status = 'inactive' where staff_id = $1`, [staffId]);
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null);
  });
});

test('old-model RLS policies (TO PUBLIC) still gate rows when RLS is forced', async (t) => {
  requireDb();
  if (!(await appRoleReadsStaff())) {
    t.skip('public.app_role() no longer reads staff (0003_tenancy applied); covered by the tenancy tests');
    return;
  }
  // The API connects as the table owner, who bypasses RLS until 0003 adds
  // FORCE ROW LEVEL SECURITY. Force it here (rolled back) on patients to show
  // the ported policies work for the owner role via auth.uid()/app_role().
  await inRolledBackTx(async (c) => {
    const s = suffix();
    const { rows: [user] } = await c.query(
      `insert into auth.users (email) values ($1) returning id`, [`baseline-rls-${s}@clinicsys.test`]);
    await c.query(`insert into staff (staff_id, name, role, auth_uid) values ($1, 'RLS', 'receptionist', $2)`,
      [`ST-RLS-${s}`, user.id]);
    await c.query('alter table patients force row level security');

    await c.query(`select set_config('app.user_id', $1, true)`, [user.id]);
    await c.query(`insert into patients (patient_id, name) values ($1, 'RLS patient')`, [`P-RLS-${s}`]);
    const seen = await c.query('select count(*)::int as n from patients where patient_id = $1', [`P-RLS-${s}`]);
    assert.equal(seen.rows[0].n, 1);

    // A signed-in user without a staff row (and an anonymous request) sees
    // nothing and cannot insert.
    await c.query(`select set_config('app.user_id', $1, true)`, [crypto.randomUUID()]);
    const hidden = await c.query('select count(*)::int as n from patients where patient_id = $1', [`P-RLS-${s}`]);
    assert.equal(hidden.rows[0].n, 0);
    await expectError(c, `insert into patients (patient_id, name) values ($1, 'x')`, [`P-RLS2-${s}`], /^42501 /);
    await c.query(`select set_config('app.user_id', '', true)`);
    const anon = await c.query('select count(*)::int as n from patients where patient_id = $1', [`P-RLS-${s}`]);
    assert.equal(anon.rows[0].n, 0);
  });
});

// Pre-existing in the Supabase functions and kept by the faithful port:
// guards are written `if v_role not in (...) then raise` (or `<> 'admin'`),
// which is NULL — not true — when app_role() is NULL, so a caller without a
// role (anonymous, or no active staff row) passes them. record_quick_payment
// and list_invoices_filtered have no role check at all. Marked todo so the
// suite stays green until a later migration fixes the guards; it starts
// passing once they refuse a NULL role.
test('RPC role guards refuse a caller without a role', {
  todo: 'pre-existing NULL-unsafe role guards in 23 RPCs (kept by the faithful port); fix in a later migration',
}, async () => {
  requireDb();
  await inRolledBackTx(async (c) => {
    assert.equal((await c.query('select public.app_role() as r')).rows[0].r, null);
    await expectError(c, 'select public.list_treatment_templates()', [], /غير مصرح/);
    await expectError(c, `select public.create_treatment_template('TPL-ANON-${suffix()}', '{"name":"x"}'::jsonb)`,
      [], /غير مصرح/);
  });
});

test('migrate(): a failing file is rolled back completely and not recorded', async () => {
  requireDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-migrate-'));
  const table = `baseline_test_${suffix()}`;
  try {
    // Line 1 succeeds, line 2 fails: nothing of the file may survive.
    fs.writeFileSync(path.join(dir, '9999_broken.sql'),
      `create table public.${table} (id int);\nselect * from public.${table}_missing;\n`);
    const log = [];
    await assert.rejects(
      migrate({ databaseUrl: DATABASE_URL, dir, log: (m) => log.push(m) }),
      (err) => err instanceof MigrationError
        && new RegExp(`9999_broken\\.sql:2: relation "public\\.${table}_missing" does not exist`).test(err.message)
        && /rolled back/.test(err.message));
    const c = await connect();
    try {
      const r = await c.query(`select to_regclass($1) as t,
                                      (select count(*)::int from public.schema_migrations where version = '9999_broken') as n`,
        [`public.${table}`]);
      assert.deepEqual(r.rows[0], { t: null, n: 0 });
    } finally {
      await c.end();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate(): rejects bad file names and files with their own transaction control', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-migrate-'));
  try {
    fs.writeFileSync(path.join(dir, '01_short.sql'), 'select 1;');
    assert.throws(() => listMigrations(dir), /bad migration file name "01_short\.sql"/);
    fs.rmSync(path.join(dir, '01_short.sql'));

    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'select 1;');
    fs.writeFileSync(path.join(dir, '0002_a.sql'), 'select 1;');
    assert.throws(() => listMigrations(dir), /two migrations share the number 0002/);
    fs.rmSync(path.join(dir, '0002_b.sql'));
    assert.deepEqual(listMigrations(dir).map((m) => m.version), ['0002_a']);

    if (DATABASE_URL) {
      fs.writeFileSync(path.join(dir, '0002_a.sql'), 'create table x_should_not_exist (id int);\ncommit;\n');
      await assert.rejects(migrate({ databaseUrl: DATABASE_URL, dir, log: () => {} }),
        /0002_a\.sql:2: contains "commit"/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The real migrations directory is well formed and starts with the baseline.
  assert.equal(listMigrations()[0].version, '0001_baseline');
});

test('migrate CLI exits 1 without DATABASE_URL or when the database is unreachable', () => {
  const noUrl = runMigrateCli({ DATABASE_URL: '' });
  assert.equal(noUrl.status, 1);
  assert.match(noUrl.stderr, /DATABASE_URL is not set/);

  const down = runMigrateCli({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /migrate: FAILED/);
});
