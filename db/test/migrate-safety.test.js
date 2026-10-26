// Live-database safety of db/migrate.js (docs/06 S3, docs/02 «الجاهزية
// للتوسع»): a migration waits at most MIGRATE_LOCK_TIMEOUT (5 s) for a lock
// and runs at most MIGRATE_STATEMENT_TIMEOUT (15 min) instead of queueing
// every clinic's requests behind it; in production it needs a backup younger
// than 2 hours (scripts/backup.sh); and from 0010 on, a destructive statement
// (drop table/column, rename, column type change, set not null) needs a
// `-- contract: <reason>` comment, because the release still running during
// a deploy must keep working (expand/contract).
//
//   DATABASE_URL=postgres://... node --test 'db/test/*.test.js'
//
// Migrations here come from temporary directories and fail: nothing is
// applied or recorded. The lock test waits on a view this file creates and
// drops: a table would be counted and locked by a backup running in
// db/test/backup.test.js at the same time (pg_tables, pg_dump's LOCK TABLE),
// and its DROP would then wait on that backup while pg_dump waits on the DROP.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const { migrate, main, lintMigration, listMigrations, readMigration, freshBackup } = require('../migrate.js');
const { shareDatabase } = require('./helpers');

const DATABASE_URL = process.env.DATABASE_URL;
const suffix = () => crypto.randomBytes(4).toString('hex');

before(async () => { if (DATABASE_URL) await shareDatabase(); });

async function connect() {
  const c = new Client({ connectionString: DATABASE_URL, application_name: 'clinicsys-db-test' });
  await c.connect();
  return c;
}

function tmpDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-migrate-safety-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

async function recorded(version) {
  const c = await connect();
  try {
    return (await c.query('select count(*)::int as n from public.schema_migrations where version = $1', [version])).rows[0].n;
  } finally { await c.end(); }
}

// ── expand/contract lint ────────────────────────────────────────────────
test('lint: from 0010 on, destructive statements need a «-- contract:» reason', () => {
  const bad = [
    'alter table public.patients drop column notes;',
    'drop table public.old_things;',
    'alter table public.patients rename column notes to remarks;',
    'alter table public.patients rename to people;',
    'alter table public.patients alter column age type bigint;',
    'alter table public.patients alter column age set data type bigint;',
    'alter table public.patients alter column phone set not null;',
    'alter table public.patients\n  drop column notes;',
  ];
  for (const sql of bad) {
    const problems = lintMigration(sql, '0010_x.sql');
    assert.equal(problems.length, 1, sql);
    assert.match(problems[0], /^0010_x\.sql:\d+: .*-- contract:/);
  }
  // From 0016 also what the running release may still call or rely on, and
  // a type change written over two lines (the applied 0010-0015 keep the old rules).
  const more = [
    'drop function public.list_invoices_filtered(text, date, date);',
    'drop procedure public.p();',
    'drop view public.v_report;',
    'drop materialized view public.mv;',
    'alter table public.patients drop constraint patients_phone_check;',
    'alter table public.patients alter column age drop default;',
    'alter table public.patients alter column age\n  type bigint;',
  ];
  for (const sql of more) {
    assert.equal(lintMigration(sql, '0016_x.sql').length, 1, sql);
    assert.deepEqual(lintMigration(sql, '0015_x.sql'), [], `not for ${sql} in 0015`);
  }
  assert.deepEqual(lintMigration('drop trigger if exists t on public.patients;\ncreate trigger t before insert on public.patients for each row execute function f();', '0016_x.sql'), [],
    'a trigger dropped and created again in the same file is fine');
  // The reason on the line before, or at the end of the same line.
  assert.deepEqual(lintMigration('-- contract: notes moved to patient_notes in 0009, unused since\nalter table public.patients drop column notes;', '0010_x.sql'), []);
  assert.deepEqual(lintMigration('alter table public.patients drop column notes; -- contract: unused since 0009', '0010_x.sql'), []);
  // A bare marker is not a reason; words in comments and additive DDL are fine.
  assert.equal(lintMigration('-- contract:\ndrop table public.t;', '0010_x.sql').length, 1);
  assert.deepEqual(lintMigration([
    '-- we never drop table rows here; rename nothing',
    '/* alter column x type int */',
    'alter table public.patients add column notes2 text;',
    'create index if not exists patients_name on public.patients (name);',
    'alter table public.patients alter column notes2 set default \'\';',
  ].join('\n'), '0010_x.sql'), []);
  // Files before 0010 predate the rule.
  assert.deepEqual(lintMigration('drop table public.t;', '0009_x.sql'), []);
});

test('lint: every migration in db/migrations passes, and migrate() refuses one that does not', async () => {
  for (const m of listMigrations()) assert.deepEqual(lintMigration(readMigration(m), m.file), [], m.file);
  const dir = tmpDir({ '9990_contract.sql': 'alter table public.nothing_here drop column x;\n' });
  try {
    await assert.rejects(migrate({ databaseUrl: DATABASE_URL || 'postgres://unused', dir, log: () => {} }),
      /9990_contract\.sql:1: .*-- contract:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── timeouts ────────────────────────────────────────────────────────────
test('a migration that waits for a lock fails within MIGRATE_LOCK_TIMEOUT (5 s), rolled back and not recorded', { skip: !DATABASE_URL }, async () => {
  const view = `migrate_lock_${suffix()}`;
  const admin = await connect();
  const reader = await connect();
  const dir = tmpDir({ '9991_waits.sql': `create or replace view public.${view} as select 1 as x, 2 as y;\n` });
  try {
    await admin.query("set lock_timeout = '20s'");
    await admin.query(`create view public.${view} as select 1 as x`);
    // An open transaction that read the view: replacing it has to wait.
    await reader.query('begin');
    await reader.query(`select * from public.${view}`);
    const started = Date.now();
    await assert.rejects(migrate({ databaseUrl: DATABASE_URL, dir, log: () => {} }),
      (err) => /SQLSTATE 55P03/.test(err.message) && /lock/i.test(err.message) && /rolled back/.test(err.message));
    const waited = Date.now() - started;
    assert.ok(waited >= 4500 && waited < 8000, `waited ${waited} ms`);
    assert.equal(await recorded('9991_waits'), 0);
  } finally {
    await reader.query('rollback').catch(() => {});
    await reader.end();
    await admin.query(`drop view if exists public.${view}`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a migration that runs longer than MIGRATE_STATEMENT_TIMEOUT is stopped', { skip: !DATABASE_URL }, async () => {
  const dir = tmpDir({ '9992_slow.sql': 'select pg_sleep(5);\n' });
  try {
    const started = Date.now();
    await assert.rejects(migrate({ databaseUrl: DATABASE_URL, dir, log: () => {}, statementTimeout: '1s' }),
      (err) => /SQLSTATE 57014/.test(err.message));
    assert.ok(Date.now() - started < 4000);
    assert.equal(await recorded('9992_slow'), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the production backup gate ──────────────────────────────────────────
function writeBackup(root, stamp, createdAt, { dump = 'x' } = {}) {
  const d = path.join(root, stamp);
  fs.mkdirSync(d, { recursive: true });
  if (dump !== null) fs.writeFileSync(path.join(d, 'db.dump'), dump);
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({
    stamp, kind: 'daily', created_at: new Date(createdAt).toISOString(), db: { file: 'db.dump', bytes: 1, sha256: '' },
  }));
}

test('freshBackup(): the newest complete backup younger than 2 hours, else null', () => {
  const root = tmpDir();
  const now = Date.parse('2026-10-25T12:00:00Z');
  try {
    assert.equal(freshBackup(path.join(root, 'missing'), now), null);
    writeBackup(root, '20261025T080000Z', now - 4 * 3600e3);
    assert.equal(freshBackup(root, now), null, 'too old');
    writeBackup(root, '20261025T110000Z', now - 3600e3, { dump: null });
    assert.equal(freshBackup(root, now), null, 'manifest without its dump');
    writeBackup(root, '.tmp-20261025T113000Z', now - 1800e3);
    assert.equal(freshBackup(root, now), null, 'a backup still being written');
    writeBackup(root, '20261025T111500Z', now - 45 * 60e3);
    assert.equal(freshBackup(root, now).stamp, '20261025T111500Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production: pending migrations need a fresh backup (exit 5), --no-backup-check skips it, nothing pending needs none', { skip: !DATABASE_URL }, async () => {
  const backups = tmpDir();
  // A file that fails on purpose: when the gate lets it through, the error
  // is SQL's, and nothing is applied or recorded either way.
  const dir = tmpDir({ '9993_gate.sql': 'select * from public.migrate_gate_missing;\n' });
  const empty = tmpDir();
  const env = { DATABASE_URL, NODE_ENV: 'production', BACKUP_DIR: backups };
  const errors = [];
  const quiet = { log: () => {}, error: (m) => errors.push(m) };
  try {
    assert.equal(await main([], { env, dir, ...quiet }), 5);
    assert.match(errors.at(-1), /scripts\/backup\.sh --db-only/);
    assert.match(errors.at(-1), /نسخة احتياطية/);
    assert.equal(await main(['--no-backup-check'], { env, dir, ...quiet }), 1);
    assert.match(errors.at(-1), /migrate_gate_missing/);
    writeBackup(backups, '20261025T110000Z', Date.now() - 10 * 60e3);
    assert.equal(await main([], { env, dir, ...quiet }), 1, 'a fresh backup lets the migration run');
    assert.match(errors.at(-1), /migrate_gate_missing/);
    assert.equal(await main([], { env: { ...env, BACKUP_DIR: path.join(backups, 'none') }, dir: empty, ...quiet }), 0, 'nothing pending');
    assert.equal(await main([], { env: { ...env, NODE_ENV: 'development', BACKUP_DIR: path.join(backups, 'none') }, dir, ...quiet }), 1, 'no gate outside production');
    assert.match(errors.at(-1), /migrate_gate_missing/);
    assert.equal(await recorded('9993_gate'), 0);
  } finally {
    for (const d of [backups, dir, empty]) fs.rmSync(d, { recursive: true, force: true });
  }
});
