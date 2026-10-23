// db/seed/dev.sql (plan task 2.4; docs/05 "Migration and seed data"):
// development / test data only. Checks what the API and the other tests
// rely on: accounts, memberships, branches, staff links, settings and
// modules per clinic, the shared password, and that the file refuses to
// run twice.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD, ensureDatabase, connect, inTx, setContext, loadFixtures } = require('./helpers');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'dev.sql');
const SLUGS = ['demo-physio', 'demo-dental'];
const ROLES = { admin: 'admin', receptionist: 'receptionist', doctor: 'doctor', therapist: 'therapist', receptionist2: 'receptionist' };

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

// bcryptjs is a dependency of api/, not of db/: use it when it is installed.
function loadBcrypt() {
  for (const p of ['bcryptjs', path.join(__dirname, '..', '..', 'api', 'node_modules', 'bcryptjs')]) {
    try { return require(p); } catch { /* try the next one */ }
  }
  return null;
}

test('dev.sql starts in the system context and is one transaction', () => {
  const sql = fs.readFileSync(SEED_FILE, 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.equal(statements[0].trim(), "select set_config('app.system', 'on', false);");
  assert.equal(statements[1].trim(), 'begin;');
  assert.ok(statements.some((l) => l.trim() === 'commit;'));
});

test('accounts: one Super Admin and one account per role in each clinic, all with the dev password', async (t) => {
  await inTx(async (c) => {
    const { rows: users } = await c.query(
      `select id, email, encrypted_password, status from auth.users where email like '%.test' order by email`);
    const expected = ['super@clinicsys.test'];
    for (const slug of SLUGS) for (const local of Object.keys(ROLES)) expected.push(`${local}@${slug}.test`);
    assert.deepEqual(users.map((u) => u.email).sort(), expected.sort());
    for (const u of users) {
      assert.equal(u.status, 'active');
      assert.match(u.encrypted_password, /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/, `${u.email}: bcrypt cost 10`);
    }
    assert.equal(new Set(users.map((u) => u.encrypted_password)).size, users.length, 'one salt per account');

    const { rows: admins } = await c.query(
      `select u.email from platform_admins p join auth.users u on u.id = p.user_id`);
    assert.deepEqual(admins.map((r) => r.email), ['super@clinicsys.test']);
    const { rows: superMember } = await c.query(
      `select 1 from organization_members where user_id = $1`, [fx.superAdmin]);
    assert.equal(superMember.length, 0, 'the Super Admin is not a member of any clinic');

    const bcrypt = loadBcrypt();
    if (!bcrypt) {
      t.diagnostic('bcryptjs not installed (npm --prefix api install): hashes not compared');
      return;
    }
    for (const u of users) assert.ok(bcrypt.compareSync(PASSWORD, u.encrypted_password), `${u.email}: password`);
  });
});

test('clinics: active, plan default, 2 branches, members and branches as documented, linked staff rows', async () => {
  await inTx(async (c) => {
    for (const slug of SLUGS) {
      const org = fx.orgs[slug];
      const { rows: [o] } = await c.query(`
        select o.status, s.code as specialty, p.code as plan
          from organizations o join specialties s on s.id = o.primary_specialty_id
          left join subscription_plans p on p.id = o.plan_id where o.id = $1`, [org]);
      assert.deepEqual(o, { status: 'active', specialty: slug === 'demo-physio' ? 'physio' : 'dental', plan: 'default' });

      const { rows: members } = await c.query(`
        select split_part(u.email, '@', 1) as local, m.role, m.status,
               coalesce((select array_agg(mb.branch_id::text order by mb.branch_id) from member_branches mb where mb.member_id = m.id), '{}') as branches
          from organization_members m join auth.users u on u.id = m.user_id
         where m.organization_id = $1 order by 1`, [org]);
      const b1 = `br-${slug}-1`;
      const b2 = `br-${slug}-2`;
      assert.deepEqual(members, [
        { local: 'admin', role: 'admin', status: 'active', branches: [] },
        { local: 'doctor', role: 'doctor', status: 'active', branches: [b1] },
        { local: 'receptionist', role: 'receptionist', status: 'active', branches: [b1] },
        { local: 'receptionist2', role: 'receptionist', status: 'active', branches: [b1, b2] },
        { local: 'therapist', role: 'therapist', status: 'active', branches: [b1] },
      ]);

      await setContext(c, { system: true });
      const { rows: branches } = await c.query(
        `select id, name, status from branches where organization_id = $1 order by id`, [org]);
      assert.deepEqual(branches.map((b) => [b.id, b.status]), [[b1, 'active'], [b2, 'active']]);
      assert.equal(branches[0].name, 'الفرع الرئيسي');

      // staff: one row per member, same role, auth_uid linked.
      const { rows: staff } = await c.query(`
        select s.role, s.status, m.role as member_role
          from staff s join organization_members m on m.user_id = s.auth_uid and m.organization_id = s.organization_id
         where s.organization_id = $1`, [org]);
      assert.equal(staff.length, 5);
      assert.ok(staff.every((s) => s.role === s.member_role && s.status === 'active'));

      const { rows: [settings] } = await c.query(
        `select count(*)::int as n, min(id) as id from clinic_settings where organization_id = $1`, [org]);
      assert.deepEqual(settings, { n: 1, id: 1 });

      // Modules = the specialty defaults; planned modules are listed but off.
      const { rows: mods } = await c.query(`
        select m.code, om.enabled, m.status from organization_modules om join modules m on m.id = om.module_id
         where om.organization_id = $1 order by m.code`, [org]);
      const { rows: defaults } = await c.query(`
        select m.code from specialty_modules sm join modules m on m.id = sm.module_id
          join organizations o on o.primary_specialty_id = sm.specialty_id where o.id = $1 order by m.code`, [org]);
      assert.deepEqual(mods.map((m) => m.code), defaults.map((d) => d.code));
      assert.ok(mods.every((m) => m.enabled === (m.status === 'active')));
      assert.ok(mods.some((m) => m.code === 'core.branches' && m.enabled));

      // A few patients, bookings and invoices per branch.
      const { rows: [n] } = await c.query(`
        select (select count(*)::int from patients where organization_id = $1) as patients,
               (select count(*)::int from bookings where organization_id = $1 and branch_id = $2) as b1_bookings,
               (select count(*)::int from bookings where organization_id = $1 and branch_id = $3) as b2_bookings,
               (select count(*)::int from invoices where organization_id = $1 and branch_id = $2) as b1_invoices,
               (select count(*)::int from invoices where organization_id = $1 and branch_id = $3) as b2_invoices`,
      [org, b1, b2]);
      assert.ok(n.patients >= 3 && n.b1_bookings >= 2 && n.b2_bookings >= 2 && n.b1_invoices >= 1 && n.b2_invoices >= 1,
        JSON.stringify(n));
      await setContext(c, {});
    }
  });
});

test('ids are globally unique across the two clinics (convention 10)', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    for (const [table, pk] of [['patients', 'patient_id'], ['bookings', 'booking_id'], ['invoices', 'invoice_id'],
      ['payments', 'payment_id'], ['staff', 'staff_id'], ['branches', 'id'], ['treatments', 'treatment_id']]) {
      const { rows } = await c.query(`
        select count(*)::int as n from ${table} a join ${table} b on a.${pk} = b.${pk} and a.organization_id <> b.organization_id`);
      assert.equal(rows[0].n, 0, table);
    }
  });
});

test('dev.sql refuses to run on a database that already has it', async () => {
  const c = await connect();
  try {
    await assert.rejects(c.query(fs.readFileSync(SEED_FILE, 'utf8')), /already applied/);
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
  }
});
