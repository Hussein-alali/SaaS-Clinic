// Clinic-admin rules added in Milestone 3 (plan tasks 2.14 and 2.15):
//   0005_branches_no_delete — branches are deactivated, never deleted: the
//     clinic admin may insert and update (status 'inactive' / 'active')
//     but a DELETE matches no row; only the system context deletes.
//   0006_staff_role — staff.role accepts 'staff' (the membership role of
//     that name), and staff rows of 'staff' members got their role.
// Every test runs inside BEGIN ... ROLLBACK.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const branchRow = (c, id) => c.query('select id, name, status from branches where id = $1', [id]);

test('0005: no permissive policy but system_access covers DELETE on branches; insert/update are admin-only', async () => {
  await inTx(async (c) => {
    const { rows } = await c.query(`
      select polname, polcmd, polpermissive, pg_get_expr(polqual, polrelid) as qual,
             pg_get_expr(polwithcheck, polrelid) as chk
        from pg_policy where polrelid = 'public.branches'::regclass order by polname`);
    const byName = Object.fromEntries(rows.map((r) => [r.polname, r]));
    assert.deepEqual(rows.map((r) => r.polname),
      ['admin insert branches', 'admin update branches', 'staff read branches', 'system_access', 'tenant_isolation']);
    assert.equal(byName['admin insert branches'].polcmd, 'a');
    assert.match(byName['admin insert branches'].chk, /app_role\(\) = 'admin'/);
    assert.equal(byName['admin update branches'].polcmd, 'w');
    assert.match(byName['admin update branches'].qual, /app_role\(\) = 'admin'/);
    assert.match(byName['admin update branches'].chk, /app_role\(\) = 'admin'/);
    const deleters = rows.filter((r) => r.polpermissive && ['d', '*'].includes(r.polcmd)).map((r) => r.polname);
    assert.deepEqual(deleters, ['system_access']);
  });
});

test('0005: the clinic admin adds, edits, deactivates and re-activates a branch, but cannot delete one', async () => {
  await inTx(async (c) => {
    const s = suffix();
    const id = `br-t-${s}`;
    await actAs(c, fx, 'admin', 'demo-physio');
    await c.query(`insert into branches (id, name, address, rooms, working_hours) values ($1, $2, 'الجيزة', 2, '{"sat":["09:00","17:00"]}')`,
      [id, `فرع ${s}`]);
    const { rows: [mine] } = await c.query('select organization_id, status from branches where id = $1', [id]);
    assert.deepEqual(mine, { organization_id: fx.orgs['demo-physio'], status: 'active' });

    assert.equal((await c.query(`update branches set name = $2, phone = '0220000000' where id = $1`, [id, `فرع معدل ${s}`])).rowCount, 1);
    assert.equal((await c.query(`update branches set status = 'inactive' where id = $1`, [id])).rowCount, 1);
    assert.equal((await c.query(`update branches set status = 'active' where id = $1`, [id])).rowCount, 1);

    // DELETE: nothing matches — neither the new (unreferenced) branch nor a
    // seeded one; the rows are still there.
    assert.equal((await c.query('delete from branches where id = $1', [id])).rowCount, 0);
    assert.equal((await c.query(`delete from branches where id = 'br-demo-physio-2'`)).rowCount, 0);
    assert.equal((await c.query('delete from branches')).rowCount, 0);
    assert.equal((await branchRow(c, id)).rows.length, 1);
    assert.equal((await branchRow(c, 'br-demo-physio-2')).rows.length, 1);

    // The unique name per clinic still applies.
    await expectError(c, `insert into branches (id, name) values ($1, 'فرع المعادي')`, [`br-dup-${s}`], /^23505 .*branches_org_name_key/);
  });
});

test('0005: other roles cannot write branches at all; another clinic\'s admin cannot touch them', async () => {
  await inTx(async (c) => {
    const s = suffix();
    for (const role of ['receptionist', 'doctor', 'therapist', 'receptionist2']) {
      await actAs(c, fx, role, 'demo-physio');
      assert.equal((await c.query(`update branches set name = 'x' where id = 'br-demo-physio-1'`)).rowCount, 0, role);
      assert.equal((await c.query(`update branches set status = 'inactive' where id = 'br-demo-physio-1'`)).rowCount, 0, role);
      assert.equal((await c.query(`delete from branches where id = 'br-demo-physio-1'`)).rowCount, 0, role);
      await expectError(c, `insert into branches (id, name) values ($1, $2)`, [`br-${role}-${s}`, `فرع ${role} ${s}`], /^42501 /);
    }
    await actAs(c, fx, 'admin', 'demo-dental');
    assert.equal((await c.query(`update branches set status = 'inactive' where id = 'br-demo-physio-2'`)).rowCount, 0);
    assert.equal((await c.query(`delete from branches where id = 'br-demo-physio-2'`)).rowCount, 0);
    await setContext(c, { system: true });
    assert.deepEqual((await branchRow(c, 'br-demo-physio-1')).rows[0].status, 'active');
    assert.deepEqual((await branchRow(c, 'br-demo-physio-2')).rows[0].status, 'active');
  });
});

test('0005: the system context can still delete an unreferenced branch', async () => {
  await inTx(async (c) => {
    const id = `br-sys-${suffix()}`;
    await setContext(c, { system: true });
    await c.query(`insert into branches (id, organization_id, name) values ($1, $2, $3)`, [id, fx.orgs['demo-dental'], `فرع ${id}`]);
    assert.equal((await c.query('delete from branches where id = $1', [id])).rowCount, 1);
  });
});

test("0006: staff.role accepts 'staff'; other values are still refused", async () => {
  await inTx(async (c) => {
    const { rows: [def] } = await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.staff'::regclass and conname = 'staff_role_check'`);
    for (const role of ['admin', 'receptionist', 'doctor', 'therapist', 'staff']) assert.ok(def.def.includes(`'${role}'`), role);
    const s = suffix();
    await actAs(c, fx, 'admin', 'demo-physio');
    await c.query(`insert into staff (staff_id, name, email, role) values ($1, 'موظف', $2, 'staff')`, [`U-st-${s}`, `st-${s}@clinicsys.test`]);
    const { rows: [row] } = await c.query('select role, organization_id from staff where staff_id = $1', [`U-st-${s}`]);
    assert.deepEqual(row, { role: 'staff', organization_id: fx.orgs['demo-physio'] });
    for (const bad of ['super_admin', 'owner', '']) {
      await expectError(c, `insert into staff (staff_id, name, role) values ($1, 'x', $2)`, [`U-bad-${s}-${bad}`, bad], /^23514 .*staff_role_check/);
    }
    // NULL stays allowed (roster rows without an account role).
    await c.query(`insert into staff (staff_id, name, role) values ($1, 'بدون دور', null)`, [`U-null-${s}`]);
  });
});

test("0006: the backfill gives the staff row of a 'staff' member its role (and nothing else)", async () => {
  // The data step of the migration, run again on a fixture made here.
  const file = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0006_staff_role.sql'), 'utf8');
  const start = file.indexOf("select set_config('app.system', 'on', true);");
  assert.ok(start > 0, 'the migration has a backfill step');
  const backfill = file.slice(start);
  await inTx(async (c) => {
    const s = suffix();
    await setContext(c, { system: true });
    const org = fx.orgs['demo-physio'];
    const ids = {};
    for (const [key, role] of [['plain', 'staff'], ['reception', 'receptionist']]) {
      const { rows: [u] } = await c.query(`insert into auth.users (email) values ($1) returning id`, [`${key}-${s}@clinicsys.test`]);
      await c.query(`insert into organization_members (organization_id, user_id, role, status) values ($1, $2, $3, 'active')`, [org, u.id, role]);
      await c.query(`insert into staff (staff_id, organization_id, name, email, role, auth_uid) values ($1, $2, 'x', $3, null, $4)`,
        [`U-${key}-${s}`, org, `${key}-${s}@clinicsys.test`, u.id]);
      ids[key] = `U-${key}-${s}`;
    }
    await setContext(c, {});
    await c.query(backfill);
    await setContext(c, { system: true });
    const { rows } = await c.query('select staff_id, role from staff where staff_id = any($1) order by staff_id', [Object.values(ids)]);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.staff_id, r.role])), { [ids.plain]: 'staff', [ids.reception]: null });
  });
});
