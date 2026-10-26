// Shared helpers for the tenancy tests (isolation, branch, limits, rpc).
// Not a test file itself (node --test also loads it; it defines no tests).
//
// ensureDatabase() brings DATABASE_URL to "migrated + seeded": it runs the
// real migrations (a no-op when applied) and applies db/seed/dev.sql when
// the demo clinics are missing. The seed refuses a database that already
// has other organizations, so these tests never seed a real database.
// Every test then works inside BEGIN ... ROLLBACK and leaves no trace.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { migrate } = require('../migrate.js');

const DATABASE_URL = process.env.DATABASE_URL;
const SEED_FILE = path.join(__dirname, '..', 'seed', 'dev.sql');
const SEED_LOCK = 2026102203; // advisory lock: one test process seeds at a time
// Readers/writer lock on the test database, shared with api/test/helpers.js:
// db test processes hold it SHARED (they only write inside rolled-back
// transactions and can run side by side); each API test file holds it
// EXCLUSIVELY while it wipes, re-migrates and re-seeds the database.
const DB_TEST_LOCK = 2026102210;

// Platform / identity tables (docs/05 convention 4): no RLS by design.
const PLATFORM_TABLES = [
  'organizations', 'platform_admins', 'organization_members', 'member_branches',
  'invitations', 'specialties', 'modules', 'specialty_modules',
  'organization_modules', 'subscription_plans', 'subscriptions', 'reserved_slugs',
  // ops tables (0010): written by functions and the API only
  'org_counters', 'idempotency_keys', 'rate_limits', 'error_groups', 'error_events', 'jobs', 'mail_log', 'usage_snapshots', 'alert_state',
];
const BRANCH_TABLES = ['bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
  'patient_schedules', 'treatments'];
const TEMPLATE_TABLES = ['template_categories', 'template_usage', 'treatment_methods', 'treatment_templates'];
// Readable with an organization context but without a role (0001 policies
// "public read clinic_settings" and "public read custom_sections"):
// /api/orgs/resolve shows a clinic's branding before sign-in.
const PUBLIC_READ = { clinic_settings: 'true', custom_sections: 'visible' };

const PASSWORD = 'Dev@12345';

function requireDb() {
  assert.ok(DATABASE_URL, 'DATABASE_URL is not set: run `scripts/dev-db.sh reset <port>` and export the URL it prints');
}

async function connect() {
  const client = new Client({ connectionString: DATABASE_URL, application_name: 'clinicsys-db-test' });
  await client.connect();
  return client;
}

let shared = null;
let sharedClient = null;
// Takes DB_TEST_LOCK in shared mode for the rest of this process (once).
// The connection is unref'd, so it never keeps the process alive; the lock
// goes away with the process.
function shareDatabase() {
  requireDb();
  if (!shared) shared = (async () => {
    sharedClient = new Client({ connectionString: DATABASE_URL, application_name: 'clinicsys-db-test-lock' });
    await sharedClient.connect();
    await sharedClient.query('select pg_advisory_lock_shared($1)', [DB_TEST_LOCK]);
    sharedClient.on('error', () => {});
    if (sharedClient.connection && sharedClient.connection.stream && sharedClient.connection.stream.unref) {
      sharedClient.connection.stream.unref();
    }
  })();
  return shared;
}

let ready = null;
// Migrates (no-op when up to date) and seeds once per process.
function ensureDatabase() {
  requireDb();
  if (!ready) ready = (async () => {
    await shareDatabase();
    await migrate({ databaseUrl: DATABASE_URL, log: () => {} });
    const c = await connect();
    try {
      await c.query('select pg_advisory_lock($1)', [SEED_LOCK]);
      const { rows: [r] } = await c.query(`
        select count(*) filter (where slug in ('demo-physio', 'demo-dental'))::int as demo,
               count(*)::int as total from public.organizations`);
      if (r.demo === 2) return;
      if (r.total > 0) {
        throw new Error(`refusing to apply db/seed/dev.sql: the database already has ${r.total} organization(s) `
          + '(use a fresh database: scripts/dev-db.sh reset <port>)');
      }
      try {
        await c.query(fs.readFileSync(SEED_FILE, 'utf8'));
      } catch (err) {
        await c.query('rollback').catch(() => {});
        throw err;
      }
    } finally {
      await c.query('select pg_advisory_unlock_all()').catch(() => {});
      await c.end();
    }
  })();
  return ready;
}

// Runs fn(client) inside BEGIN ... ROLLBACK.
async function inTx(fn) {
  const client = await connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

// The request context the API sets (transaction-local, like withContext()).
async function setContext(c, { user = null, org = null, branch = null, system = false } = {}) {
  await c.query(
    `select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true),
            set_config('app.branch_id', $3, true), set_config('app.system', $4, true)`,
    [user || '', org || '', branch || '', system ? 'on' : 'off']);
}

// Expects `sql` to fail; a savepoint keeps the surrounding transaction alive.
async function expectError(c, sql, params, pattern) {
  await c.query('savepoint expect_error');
  try {
    await c.query(sql, params);
  } catch (err) {
    await c.query('rollback to savepoint expect_error');
    if (pattern) assert.match(`${err.code} ${err.message}`, pattern, `unexpected error for: ${sql}`);
    return err;
  }
  await c.query('rollback to savepoint expect_error');
  assert.fail(`expected an error from: ${sql}`);
}

// Ids of the seeded fixtures: orgs[slug], users[email], branches[slug] = [b1, b2].
async function loadFixtures(c) {
  const orgs = {};
  for (const r of (await c.query(`select id, slug from public.organizations`)).rows) orgs[r.slug] = r.id;
  const users = {};
  for (const r of (await c.query(`select id, email from auth.users where email like '%.test'`)).rows) users[r.email] = r.id;
  assert.ok(orgs['demo-physio'] && orgs['demo-dental'], 'the dev seed is not applied');
  const branches = {
    'demo-physio': ['br-demo-physio-1', 'br-demo-physio-2'],
    'demo-dental': ['br-demo-dental-1', 'br-demo-dental-2'],
  };
  const user = (role, slug) => {
    const id = users[`${role}@${slug}.test`];
    assert.ok(id, `no seeded account ${role}@${slug}.test`);
    return id;
  };
  return { orgs, users, branches, user, superAdmin: users['super@clinicsys.test'] };
}

// Shortcut: context of a seeded account in a seeded clinic.
async function actAs(c, fx, role, slug, { branch = 1, org = slug } = {}) {
  await setContext(c, {
    user: role === 'super' ? fx.superAdmin : fx.user(role, slug),
    org: org ? fx.orgs[org] : null,
    branch: org && branch ? fx.branches[org][branch - 1] : null,
  });
}

// Public tables that carry organization_id, split into clinic tables (RLS)
// and platform tables; with their primary-key column(s).
async function catalog(c) {
  const { rows } = await c.query(`
    select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
           (select array_agg(a.attname::text order by k.ord)
              from pg_index i
              cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where i.indrelid = c.oid and i.indisprimary) as pk
      from pg_class c
      join pg_attribute oa on oa.attrelid = c.oid and oa.attname = 'organization_id' and not oa.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     order by c.relname`);
  return {
    clinic: rows.filter((r) => !PLATFORM_TABLES.includes(r.table)),
    platform: rows.filter((r) => PLATFORM_TABLES.includes(r.table)),
  };
}

const suffix = () => crypto.randomBytes(4).toString('hex');
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Inserts `row` (usually a copy of an existing row) with the given
// overrides; a key set to undefined is left out (its default applies).
async function insertCopy(c, table, row, overrides = {}) {
  const values = { ...row, ...overrides };
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];
  const cols = Object.keys(values);
  const sql = `insert into public.${ident(table)} (${cols.map(ident).join(', ')})
               values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
  return c.query(sql, cols.map((k) => {
    const v = values[k];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  }));
}

module.exports = {
  DATABASE_URL, PLATFORM_TABLES, BRANCH_TABLES, TEMPLATE_TABLES, PUBLIC_READ, PASSWORD, DB_TEST_LOCK,
  requireDb, connect, shareDatabase, ensureDatabase, inTx, setContext, expectError, loadFixtures, actAs,
  catalog, suffix, ident, insertCopy,
};
