// audit_events integrity (0004_audit_integrity.sql): rows written by clinic
// members get their id, actor and time from the database, so a member can
// neither forge who did what nor squat ids of the sequence that every
// clinic's audit writes share (security review, 22 Oct 2026).
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  fx = await inTx((c) => loadFixtures(c));
});

test('a member cannot choose id, actor_uid, actor_role or created_at of an audit row', async () => {
  await inTx(async (c) => {
    const { rows: [{ last }] } = await c.query(
      `select last_value as last from pg_sequences where schemaname = 'public' and sequencename = 'audit_events_id_seq'`);
    const next = Number(last) + 1;
    const ahead = next + 100000;
    await actAs(c, fx, 'receptionist', 'demo-physio');
    // Like the attack: chosen ids, the Super Admin as actor, a past date.
    await c.query(
      `insert into audit_events (id, actor_uid, actor_role, action, table_name, created_at)
       values ($1, $2, 'super_admin', 'organization.status', 'organizations', '2020-01-01T00:00:00Z')`,
      [ahead, fx.superAdmin]);
    // The ids the sequence hands out next (what blocked every clinic).
    await c.query(
      `insert into audit_events (id, action, table_name)
       select g, 'sec.squat', 'x' from generate_series($1::bigint, $1::bigint + 2) g`, [next]);
    await setContext(c, { system: true });
    const { rows: [row] } = await c.query(
      `select id, actor_uid, actor_role, created_at, organization_id
         from audit_events where action = 'organization.status' and table_name = 'organizations'
          and organization_id = $1 order by id desc limit 1`, [fx.orgs['demo-physio']]);
    assert.ok(row, 'the member row was written');
    assert.notEqual(Number(row.id), ahead, 'the caller-chosen id was replaced by the sequence');
    assert.equal(row.actor_uid, fx.user('receptionist', 'demo-physio'));
    assert.equal(row.actor_role, 'receptionist');
    assert.ok(Date.now() - row.created_at.getTime() < 60 * 60 * 1000, 'created_at is now(), not back-dated');
    const { rows: taken } = await c.query('select 1 from audit_events where id = $1', [ahead]);
    assert.equal(taken.length, 0, 'the far-ahead id stays free');

    // Another clinic's next audit writes (here the dental admin's) do not
    // collide with the ids the member tried to occupy (before 0004: 23505).
    await actAs(c, fx, 'admin', 'demo-dental');
    for (let i = 0; i < 3; i++) {
      await c.query(`insert into audit_events (action, table_name) values ('t.after_squat', 'x')`);
    }
  });
});

test('a member still cannot write another clinic\'s or a platform audit row', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'admin', 'demo-physio');
    await expectError(c, `insert into audit_events (action, table_name, organization_id) values ('t', 'x', $1)`,
      [fx.orgs['demo-dental']], /^42501 /);
    await expectError(c, `insert into audit_events (action, table_name, organization_id) values ('t', 'x', null)`,
      [], /^42501 /);
    // and cannot change or delete rows that exist
    const upd = await c.query(`update audit_events set actor_role = 'super_admin'`);
    assert.equal(upd.rowCount, 0);
    const del = await c.query('delete from audit_events');
    assert.equal(del.rowCount, 0);
  });
});

test('the system context (API platform operations, seeds) keeps the values it writes', async () => {
  await inTx(async (c) => {
    await setContext(c, { system: true });
    const { rows: [row] } = await c.query(
      `insert into audit_events (organization_id, actor_uid, actor_role, action, table_name, created_at)
       values (null, $1, 'super_admin', 'organization.create', 'organizations', '2026-01-02T03:04:05Z')
       returning actor_uid, actor_role, created_at`, [fx.superAdmin]);
    assert.equal(row.actor_uid, fx.superAdmin);
    assert.equal(row.actor_role, 'super_admin');
    assert.equal(row.created_at.toISOString(), '2026-01-02T03:04:05.000Z');
  });
});
