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
//   and the error is printed with its line number).
// * Needs only what a cPanel database owner has: no superuser, no CREATEROLE.
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;
// Arbitrary constant shared by every migrate.js run against the database.
const ADVISORY_LOCK_KEY = 2026102101;
// Transaction control would break the "file + its schema_migrations row in
// one transaction" guarantee, so such files are refused up front.
const TX_CONTROL_RE = /^\s*(begin|start\s+transaction|commit|end\s+transaction|rollback)\s*;\s*$/im;

const SCHEMA_MIGRATIONS_DDL = `
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz default now()
)`;

class MigrationError extends Error {}

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
  if (err.hint) parts.push(`  HINT: ${err.hint}`);
  if (err.where) parts.push(`  CONTEXT: ${err.where.split('\n').join('\n           ')}`);
  return parts.join('\n');
}

async function appliedVersions(client) {
  const { rows } = await client.query('select version from public.schema_migrations');
  return new Set(rows.map((r) => r.version));
}

// Applies every pending migration. Returns { applied: [version], already: n }.
async function migrate({ databaseUrl, dir = MIGRATIONS_DIR, log = console.log, statusOnly = false } = {}) {
  if (!databaseUrl) throw new MigrationError('DATABASE_URL is not set');
  const migrations = listMigrations(dir);
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

    const applied = [];
    for (const m of pending) {
      const sql = readMigration(m);
      const started = Date.now();
      try {
        await client.query('begin');
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

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: DATABASE_URL=postgres://... node db/migrate.js [--status]');
    return 0;
  }
  const unknown = argv.filter((a) => a !== '--status');
  if (unknown.length) {
    console.error(`migrate: unknown argument(s): ${unknown.join(' ')}`);
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error('migrate: DATABASE_URL is not set\nusage: DATABASE_URL=postgres://... node db/migrate.js [--status]');
    return 1;
  }
  try {
    await migrate({ databaseUrl: process.env.DATABASE_URL, statusOnly: argv.includes('--status') });
    return 0;
  } catch (err) {
    const msg = err instanceof MigrationError ? err.message
      : err && err.message ? `${err.message}${err.code ? ` (${err.code})` : ''}`
      : String(err);
    console.error(`migrate: FAILED\n${msg}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { migrate, listMigrations, MigrationError, MIGRATIONS_DIR };
