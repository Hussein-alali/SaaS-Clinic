// Branch scope (plan task 2.5; docs/05 convention 8): rows of the seven
// branch-scoped tables are visible and writable only in the member's
// branches (member_branches); the clinic admin sees every branch.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  BRANCH_TABLES, ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs, suffix, ident,
} = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const B = (slug, n) => `br-${slug}-${n}`;

async function branchCounts(c, table, slug) {
  const { rows: [r] } = await c.query(
    `select count(*) filter (where branch_id = $1)::int as b1,
            count(*) filter (where branch_id = $2)::int as b2,
            count(*)::int as total
       from public.${ident(table)}`, [B(slug, 1), B(slug, 2)]);
  return r;
}

test('catalog: branch_id NOT NULL DEFAULT app_branch_id(), same-clinic FK and RESTRICTIVE branch_scope on the 7 tables', async () => {
  await inTx(async (c) => {
    for (const t of BRANCH_TABLES) {
      const { rows: [col] } = await c.query(`
        select a.attnotnull as nn, pg_get_expr(d.adbin, d.adrelid) as def
          from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = $1::regclass and a.attname = 'branch_id'`, [`public.${t}`]);
      assert.deepEqual(col, { nn: true, def: 'app_branch_id()' }, t);
      const { rows: fk } = await c.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = $1::regclass and contype = 'f' and confrelid = 'public.branches'::regclass`, [`public.${t}`]);
      assert.deepEqual(fk.map((r) => r.def), ['FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id)'], t);
      const { rows: pol } = await c.query(`
        select polpermissive, pg_get_expr(polqual, polrelid) as qual from pg_policy
         where polrelid = $1::regclass and polname = 'branch_scope'`, [`public.${t}`]);
      assert.equal(pol.length, 1, `${t}: branch_scope`);
      assert.equal(pol[0].polpermissive, false, `${t}: branch_scope must be RESTRICTIVE`);
      assert.match(pol[0].qual, /can_access_branch\(branch_id\)/);
    }
  });
});

test('can_access_branch(): admin -> every branch of the clinic; others -> their member_branches; no role -> none', async () => {
  await inTx(async (c) => {
    const cases = [
      ['admin', 'demo-physio', [true, true]],
      ['receptionist', 'demo-physio', [true, false]],
      ['doctor', 'demo-physio', [true, false]],
      ['therapist', 'demo-physio', [true, false]],
      ['receptionist2', 'demo-physio', [true, true]],
      ['receptionist', 'demo-dental', [true, false]],
      ['receptionist2', 'demo-dental', [true, true]],
    ];
    for (const [role, slug, expected] of cases) {
      await actAs(c, fx, role, slug);
      const { rows: [r] } = await c.query(
        'select public.can_access_branch($1) as b1, public.can_access_branch($2) as b2, public.can_access_branch(null) as none',
        [B(slug, 1), B(slug, 2)]);
      assert.deepEqual([r.b1, r.b2, r.none], [...expected, false], `${role}@${slug}`);
    }
    // A branch of another clinic, a non-member, and no user at all. (For an
    // admin the function only checks the role: tenant_isolation and the
    // composite FK keep other clinics' branches out of reach, see below.)
    await actAs(c, fx, 'receptionist2', 'demo-physio');
    assert.equal((await c.query('select public.can_access_branch($1) as b', [B('demo-dental', 1)])).rows[0].b, false);
    await actAs(c, fx, 'admin', 'demo-physio', { org: 'demo-dental' });
    assert.equal((await c.query('select public.can_access_branch($1) as b', [B('demo-dental', 1)])).rows[0].b, false);
    await setContext(c, { org: fx.orgs['demo-physio'], branch: B('demo-physio', 1) });
    assert.equal((await c.query('select public.can_access_branch($1) as b', [B('demo-physio', 1)])).rows[0].b, false);
  });
});

test('members limited to branch 1 see none of branch 2 in every branch-scoped table; the admin sees both', async () => {
  await inTx(async (c) => {
    // treatments are read by admin/doctor/therapist only (0001 policy).
    const limited = { treatments: 'doctor' };
    for (const slug of ['demo-physio', 'demo-dental']) {
      for (const t of BRANCH_TABLES) {
        await actAs(c, fx, limited[t] || 'receptionist', slug);
        const r = await branchCounts(c, t, slug);
        assert.ok(r.b1 >= 1, `${t}@${slug}: branch 1 rows visible`);
        assert.equal(r.b2, 0, `${t}@${slug}: branch 2 rows leaked`);
        assert.equal(r.total, r.b1, `${t}@${slug}: rows of other branches/clinics`);

        await actAs(c, fx, 'admin', slug);
        const a = await branchCounts(c, t, slug);
        assert.ok(a.b1 >= 1 && a.b2 >= 1, `${t}@${slug}: admin sees both branches`);
        assert.equal(a.total, a.b1 + a.b2);

        if (t !== 'treatments') {
          await actAs(c, fx, 'receptionist2', slug);
          const r2 = await branchCounts(c, t, slug);
          assert.ok(r2.b1 >= 1 && r2.b2 >= 1, `${t}@${slug}: a receptionist of both branches sees both`);
        }
      }
    }
  });
});

test('a receptionist of branch 1 cannot read or write branch 2 bookings; the admin can', async () => {
  await inTx(async (c) => {
    const s = suffix();
    const slug = 'demo-physio';
    // Context branch = 1.
    await actAs(c, fx, 'receptionist', slug);
    const b2 = await c.query(`select booking_id from bookings where branch_id = $1`, [B(slug, 2)]);
    assert.equal(b2.rows.length, 0);
    assert.equal((await c.query(`select 1 from bookings where booking_id = 'BK-PHY-B2-1'`)).rows.length, 0);

    // Insert: in branch 1 (default from app.branch_id) yes; in branch 2 no.
    await c.query(`insert into bookings (booking_id, patient_id, date, time, price) values ($1, 'P-PHY-01', current_date, '09:00', 100)`,
      [`BK-T1-${s}`]);
    const { rows: [mine] } = await c.query(`select organization_id, branch_id from bookings where booking_id = $1`, [`BK-T1-${s}`]);
    assert.deepEqual(mine, { organization_id: fx.orgs[slug], branch_id: B(slug, 1) });
    await expectError(c, `insert into bookings (booking_id, patient_id, branch_id) values ($1, 'P-PHY-01', $2)`,
      [`BK-T2-${s}`, B(slug, 2)], /^42501 .*row-level security/);

    // Even with app.branch_id pointing at branch 2 (the API would not do
    // that: it only accepts an allowed X-Branch-Id).
    await actAs(c, fx, 'receptionist', slug, { branch: 2 });
    await expectError(c, `insert into bookings (booking_id, patient_id) values ($1, 'P-PHY-01')`, [`BK-T3-${s}`], /^42501 /);

    // Update / delete of branch 2 rows: nothing visible.
    await actAs(c, fx, 'receptionist', slug);
    assert.equal((await c.query(`update bookings set notes = 'x' where branch_id = $1`, [B(slug, 2)])).rowCount, 0);
    assert.equal((await c.query(`update bookings set notes = 'x' where booking_id = 'BK-PHY-B2-1'`)).rowCount, 0);
    assert.equal((await c.query(`delete from bookings where booking_id = 'BK-PHY-B2-1'`)).rowCount, 0);
    // Moving an own booking to branch 2 is refused.
    await expectError(c, `update bookings set branch_id = $1 where booking_id = $2`, [B(slug, 2), `BK-T1-${s}`], /^42501 /);

    // The admin sees and writes both branches.
    await actAs(c, fx, 'admin', slug);
    assert.equal((await c.query(`select 1 from bookings where booking_id = 'BK-PHY-B2-1'`)).rows.length, 1);
    assert.equal((await c.query(`update bookings set notes = 'admin' where booking_id = 'BK-PHY-B2-1'`)).rowCount, 1);
    await c.query(`insert into bookings (booking_id, patient_id, branch_id) values ($1, 'P-PHY-03', $2)`, [`BK-T4-${s}`, B(slug, 2)]);
    await c.query(`update bookings set branch_id = $1 where booking_id = $2`, [B(slug, 2), `BK-T1-${s}`]);
    assert.equal((await c.query(`delete from bookings where booking_id = $1`, [`BK-T4-${s}`])).rowCount, 1);

    // The receptionist of both branches too.
    await actAs(c, fx, 'receptionist2', slug);
    assert.equal((await c.query(`update bookings set notes = 'r2' where booking_id = 'BK-PHY-B2-1'`)).rowCount, 1);
  });
});

test('branch_id must name a branch of the same clinic (composite FK), and is required', async () => {
  await inTx(async (c) => {
    const s = suffix();
    await setContext(c, { system: true }); // past every policy: only the keys decide
    await expectError(c,
      `insert into bookings (booking_id, organization_id, branch_id, patient_id) values ($1, $2, $3, 'P-PHY-01')`,
      [`BK-T5-${s}`, fx.orgs['demo-physio'], B('demo-dental', 1)], /^23503 .*bookings_branch_fkey/);
    await expectError(c,
      `insert into bookings (booking_id, organization_id, patient_id) values ($1, $2, 'P-PHY-01')`,
      [`BK-T6-${s}`, fx.orgs['demo-physio']], /^23502 .*branch_id/);
    // member_branches (platform table) follows the same rule.
    const { rows: [m] } = await c.query(
      `select id from organization_members where organization_id = $1 and user_id = $2`,
      [fx.orgs['demo-physio'], fx.user('doctor', 'demo-physio')]);
    await expectError(c, `insert into member_branches (member_id, branch_id, organization_id) values ($1, $2, $3)`,
      [m.id, B('demo-dental', 2), fx.orgs['demo-physio']], /^23503 /);
    // And so do the other references between clinic tables.
    await expectError(c, `insert into invoices (invoice_id, organization_id, branch_id, patient_id, amount)
                          values ($1, $2, $3, 'P-DEN-01', 10)`,
    [`INV-T-${s}`, fx.orgs['demo-physio'], B('demo-physio', 1)], /^23503 .*invoices_patient_id_fkey/);
    await c.query('savepoint deferred');
    await c.query(`update bookings set therapist_id = 'ST-DEN-THERAPIST' where booking_id = 'BK-PHY-B1-1'`);
    await expectError(c, 'set constraints all immediate', [], /^23503 .*bookings_therapist_org_fkey/);
    await c.query('rollback to savepoint deferred');
  });
});

test('deleting a referenced row still SETs NULL across the deferred composite keys', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'admin', 'demo-physio');
    // ST-PHY-THERAPIST is referenced by bookings, sessions, patients and schedules.
    assert.equal((await c.query(`delete from therapists where id = 'ST-PHY-THERAPIST'`)).rowCount, 1);
    await c.query('set constraints all immediate'); // run the deferred checks now
    const { rows: [r] } = await c.query(`
      select (select count(*)::int from bookings where therapist_id = 'ST-PHY-THERAPIST') as bookings,
             (select count(*)::int from patients where therapist_id = 'ST-PHY-THERAPIST') as patients,
             (select count(*)::int from bookings where booking_id = 'BK-PHY-B1-1' and therapist_id is null) as cleared`);
    assert.deepEqual(r, { bookings: 0, patients: 0, cleared: 1 });
    // A treatment delete unlinks its sessions (RPC path of 0001).
    await actAs(c, fx, 'doctor', 'demo-physio');
    const { rows: [{ r: del }] } = await c.query(`select public.delete_treatment('TRT-PHY-B1-1') as r`);
    assert.equal(del.deleted, true);
    assert.equal(del.sessions_unlinked, 1);
  });
});
