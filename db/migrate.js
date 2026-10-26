#!/usr/bin/env node
// Applies db/migrations/NNNN_name.sql in filename order (docs/02-TRD.md,
// "Migrations"; docs/05-Backend-Schema.md, "Migration and seed data").
//
//   DATABASE_URL=postgres://user:pass@host:5432/db node db/migrate.js
//   DATABASE_URL=... node db/migrate.js --status     # list, apply nothing
//
// * Works from any directory (paths are relative to this file).
// * Each file runs in its own transaction together with its row in
//   public.schema_migrations, so a file is either fully applied and
//   recorded, or not at all.
// * Already-recorded files are skipped; a second run applies nothing.
// * A session advisory lock stops two runs from applying the same file.
// * Exit code 0 on success, 1 on any failure (the failing file is rolled back
//   and the error is printed with its line number), 5 when production has no
//   fresh backup (below).
// * Needs only what a cPanel database owner has: no superuser, no CREATEROLE.
//
// Live-database safety (docs/06 S3): the clinics keep working while a
// migration runs, so
// * each file waits at most MIGRATE_LOCK_TIMEOUT (5s) for a lock and runs at
//   most MIGRATE_STATEMENT_TIMEOUT (15min), instead of queueing every
//   request behind it; on timeout it is rolled back and can be retried;
// * with NODE_ENV=production, pending files need a backup younger than 2
//   hours in BACKUP_DIR (scripts/backup.sh; deploy.sh makes one first),
//   else exit 5 (--no-backup-check skips this on purpose);
// * from 0010 on, a destructive statement (drop table/column, rename, column
//   type change, set not null) needs a `-- contract: <reason>` comment on
//   its line or the line before: during a deploy the previous release still
//   runs against the new schema (expand/contract).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;
// Arbitrary constant shared by every migrate.js run against the database.
const ADVISORY_LOCK_KEY = 2026102101;
// Transaction control would break the "file + its schema_migrations row in
// one transaction" guarantee, so such files are refused up front.
const TX_CONTROL_RE = /^\s*(begin|start\s+transaction|commit|end\s+transaction|rollback)\s*;\s*$/im;

const LINT_FROM = 10; // migrations before 0010 predate the expand/contract rule
const DESTRUCTIVE = [
  [/\bdrop\s+table\b/i, 'drop table'],
  [/\bdrop\s+column\b/i, 'drop column'],
  [/\brename\b/i, 'rename'],
  [/\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i, 'column type change'],
  [/\bset\s+not\s+null\b/i, 'set not null'],
];
// From 0016 (the applied 0010-0015 keep the rules above): what the running
// release may still call or rely on.
const LINT_MORE_FROM = 16;
const DESTRUCTIVE_MORE = [
  [/\bdrop\s+(function|procedure|view|materialized\s+view)\b/i, 'drop function/procedure/view'],
  [/\bdrop\s+constraint\b/i, 'drop constraint'],
  [/\bdrop\s+default\b/i, 'drop default'],
];
const CONTRACT_RE = /--\s*contract:\s*\S/i;
const BACKUP_MAX_AGE_MS = 2 * 3600 * 1000;

const SCHEMA_MIGRATIONS_DDL = `
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz default now()
)`;

class MigrationError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Returns [{ version, file, fullPath }] sorted by filename. version is the
// filename without ".sql" (e.g. "0001_baseline").
function listMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Map();
  return files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m) {
      throw new MigrationError(`bad migration file name "${file}" (expected NNNN_name.sql)`);
    }
    if (seen.has(m[1])) {
      throw new MigrationError(`two migrations share the number ${m[1]}: ${seen.get(m[1])} and ${file}`);
    }
    seen.set(m[1], file);
    return { version: file.slice(0, -'.sql'.length), file, fullPath: path.join(dir, file) };
  });
}

function readMigration(m) {
  let sql = fs.readFileSync(m.fullPath, 'utf8');
  if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1); // BOM
  const tx = TX_CONTROL_RE.exec(sql);
  if (tx) {
    const line = sql.slice(0, tx.index + tx[0].search(/\S/)).split('\n').length;
    throw new MigrationError(
      `${m.file}:${line}: contains "${tx[1]}" — migrate.js already wraps each file in a transaction`);
  }
  return sql;
}

// Expand/contract lint: one problem per destructive line of a file numbered
// 0010 or later that has no `-- contract: <reason>` on it or the line above
// (more patterns from 0016, DESTRUCTIVE_MORE).
function lintMigration(sql, file) {
  const n = Number(file.slice(0, 4));
  if (n < LINT_FROM) return [];
  const rules = n >= LINT_MORE_FROM ? DESTRUCTIVE.concat(DESTRUCTIVE_MORE) : DESTRUCTIVE;
  const lines = sql.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n');
  const codeOf = (line) => (line || '').replace(/--.*$/, '');
  const problems = [];
  lines.forEach((line, i) => {
    // From 0016, a line ending in "alter column x" is read with the next one
    // ("type bigint" written below it is still a type change).
    const code = n >= LINT_MORE_FROM && /\balter\s+column\s+\S+\s*$/i.test(codeOf(line))
      ? `${codeOf(line)} ${codeOf(lines[i + 1])}` : codeOf(line);
    const hit = rules.find(([re]) => re.test(code));
    if (!hit || CONTRACT_RE.test(line) || (i > 0 && CONTRACT_RE.test(lines[i - 1]))) return;
    problems.push(`${file}:${i + 1}: ${hit[1]} breaks the release that is still running during a deploy; ` +
      'split it (expand now, contract in a later release) or explain it with "-- contract: <reason>" on the line before');
  });
  return problems;
}

// The newest complete backup (scripts/backup.sh: <dir>/<stamp>/manifest.json
// next to its db.dump) younger than 2 hours, or null.
function freshBackup(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  let best = null;
  for (const name of names) {
    if (name.startsWith('.')) continue; // .tmp-<stamp>: still being written
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8')); } catch (_) { continue; }
    const at = Date.parse(m.created_at);
    if (!(now - at < BACKUP_MAX_AGE_MS) || at > now + 60000) continue;
    const dump = m.db && m.db.file ? path.join(dir, name, m.db.file) : null;
    if (!dump || !fs.existsSync(dump) || fs.statSync(dump).size === 0) continue;
    if (!best || at > best.at) best = { at, stamp: m.stamp || name };
  }
  return best;
}

const PG_HINTS = {
  '55P03': 'another session holds a lock this migration needs (lock_timeout); retry when it ends',
  '57014': 'the migration ran longer than its statement_timeout (MIGRATE_STATEMENT_TIMEOUT)',
};

function describePgError(err, sql, file) {
  const parts = [];
  let where = file;
  const pos = Number(err.position);
  if (pos > 0 && typeof sql === 'string') {
    where += `:${sql.slice(0, pos - 1).split('\n').length}`;
  }
  parts.push(`${where}: ${err.message}`);
  if (err.code) parts.push(`  SQLSTATE ${err.code}`);
  if (err.detail) parts.push(`  DETAIL: ${err.detail}`);
  if (err.hint || PG_HINTS[err.code]) parts.push(`  HINT: ${err.hint || PG_HINTS[err.code]}`);
  if (err.where) parts.push(`  CONTEXT: ${err.where.split('\n').join('\n           ')}`);
  return parts.join('\n');
}

async function appliedVersions(client) {
  const { rows } = await client.query('select version from public.schema_migrations');
  return new Set(rows.map((r) => r.version));
}

// Applies every pending migration. Returns { applied: [version], already: n }.
// backupDir: refuse pending files unless it holds a fresh backup (production).
async function migrate({ databaseUrl, dir = MIGRATIONS_DIR, log = console.log, statusOnly = false,
  lockTimeout = '5s', statementTimeout = '15min', backupDir = null } = {}) {
  if (!databaseUrl) throw new MigrationError('DATABASE_URL is not set');
  const migrations = listMigrations(dir);
  const sqlOf = new Map();
  if (!statusOnly) {
    const problems = [];
    for (const m of migrations) {
      sqlOf.set(m.version, readMigration(m));
      problems.push(...lintMigration(sqlOf.get(m.version), m.file));
    }
    if (problems.length) throw new MigrationError(problems.join('\n'), 'contract');
  }
  const client = new Client({ connectionString: databaseUrl, application_name: 'clinicsys-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const done = await appliedVersions(client);

    const onDisk = new Set(migrations.map((m) => m.version));
    for (const v of [...done].sort()) {
      if (!onDisk.has(v)) log(`warning: ${v} is recorded in schema_migrations but has no file in ${dir}`);
    }

    const pending = migrations.filter((m) => !done.has(m.version));
    if (statusOnly) {
      for (const m of migrations) log(`${done.has(m.version) ? 'applied ' : 'pending '} ${m.file}`);
      return { applied: [], already: migrations.length - pending.length, pending: pending.map((m) => m.version) };
    }

    if (pending.length && backupDir && !freshBackup(backupDir)) {
      throw new MigrationError(
        `لا توجد نسخة احتياطية حديثة (أقل من ساعتين) في ${backupDir}: شغّل scripts/backup.sh --db-only أولًا.\n` +
        `no backup younger than 2 hours in ${backupDir}: run scripts/backup.sh --db-only first ` +
        `(or pass --no-backup-check on purpose); ${pending.length} migration(s) pending, nothing applied`, 'backup_required');
    }

    const applied = [];
    for (const m of pending) {
      const sql = sqlOf.get(m.version);
      const started = Date.now();
      try {
        await client.query('begin');
        await client.query("select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
          [lockTimeout, statementTimeout]);
        await client.query(sql);
        await client.query('insert into public.schema_migrations (version) values ($1)', [m.version]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        if (err instanceof MigrationError) throw err;
        throw new MigrationError(`${describePgError(err, sql, m.file)}\n  (rolled back; nothing from ${m.file} was applied)`);
      }
      applied.push(m.version);
      log(`applied  ${m.file} (${Date.now() - started} ms)`);
    }

    const already = migrations.length - pending.length;
    if (applied.length === 0) {
      log(`nothing to apply (${already} migration${already === 1 ? '' : 's'} already applied)`);
    } else {
      log(`done: ${applied.length} applied, ${already} already applied`);
    }
    return { applied, already };
  } finally {
    await client.query('select pg_advisory_unlock_all()').catch(() => {});
    await client.end().catch(() => {});
  }
}

const USAGE = 'usage: DATABASE_URL=postgres://... node db/migrate.js [--status] [--no-backup-check]';

// Exit codes: 0 done · 1 failed · 5 production without a fresh backup.
async function main(argv, { env = process.env, dir = MIGRATIONS_DIR, log = console.log, error = console.error } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a !== '--status' && a !== '--no-backup-check');
  if (unknown.length) {
    error(`migrate: unknown argument(s): ${unknown.join(' ')}`);
    return 1;
  }
  if (!env.DATABASE_URL) {
    error(`migrate: DATABASE_URL is not set\n${USAGE}`);
    return 1;
  }
  const production = env.NODE_ENV === 'production';
  try {
    await migrate({
      databaseUrl: env.DATABASE_URL, dir, log, statusOnly: argv.includes('--status'),
      lockTimeout: env.MIGRATE_LOCK_TIMEOUT || '5s',
      statementTimeout: env.MIGRATE_STATEMENT_TIMEOUT || '15min',
      backupDir: production && !argv.includes('--no-backup-check')
        ? (env.BACKUP_DIR || path.join(os.homedir(), 'clinicsys-backups')) : null,
    });
    return 0;
  } catch (err) {
    const msg = err instanceof MigrationError ? err.message
      : err && err.message ? `${err.message}${err.code ? ` (${err.code})` : ''}`
      : String(err);
    error(`migrate: FAILED\n${msg}`);
    return err instanceof MigrationError && err.code === 'backup_required' ? 5 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { migrate, main, listMigrations, readMigration, lintMigration, freshBackup, MigrationError, MIGRATIONS_DIR };
