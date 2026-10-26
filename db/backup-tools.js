#!/usr/bin/env node
// Helpers of scripts/backup.sh and scripts/restore-check.sh (docs/06 S1).
//
//   node db/backup-tools.js dump <out.dump> <counts.json>   (DATABASE_URL)
//       pg_dump -Fc of the whole database and the row count of every table
//       in the schemas public and auth, both from ONE snapshot: the counts
//       describe exactly what the dump contains, so a restore can be checked
//       against them even while the clinics keep working.
//   node db/backup-tools.js restore <in.dump>              (RESTORE_DATABASE_URL)
//       pg_restore --clean of that dump into the restore database.
//   node db/backup-tools.js counts                         (COUNTS_DATABASE_URL)
//       → JSON on stdout
//
// Database URLs come from the environment and the password reaches
// pg_dump / pg_restore as PGPASSWORD: on a command line it would show in
// `ps` to every account of a shared server (security audit, CWE-214).
//
// The clinic tables have FORCE ROW LEVEL SECURITY, which applies to the
// owner too: both commands run with app.system = 'on' (the system_access
// policy of 0003) so that nothing is hidden from the backup.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { Client } = require('pg');

const SCHEMAS = ['public', 'auth'];

async function countTables(client) {
  const { rows } = await client.query(
    `select schemaname, tablename from pg_tables where schemaname = any($1) order by 1, 2`, [SCHEMAS]);
  const counts = {};
  for (const { schemaname, tablename } of rows) {
    const name = `${schemaname}.${tablename}`;
    const q = `select count(*)::bigint as n from ${client.escapeIdentifier(schemaname)}.${client.escapeIdentifier(tablename)}`;
    counts[name] = Number((await client.query(q)).rows[0].n);
  }
  return counts;
}

/** url without its password (user, host, database and options stay) + PGPASSWORD. */
function splitPassword(url) {
  const u = new URL(url);
  const password = u.password ? decodeURIComponent(u.password) : u.searchParams.get('password');
  u.password = '';
  u.searchParams.delete('password');
  return { url: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

/** Runs a libpq tool on `url` with app.system = 'on' (see above). */
function pgTool(tool, url, args) {
  const conn = splitPassword(url);
  return new Promise((resolve, reject) => {
    const child = spawn(tool, [...args, `--dbname=${conn.url}`], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...conn.env, PGOPTIONS: `${process.env.PGOPTIONS || ''} -c app.system=on`.trim() },
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${tool} exited with ${code}`))));
  });
}

function pgDump(url, out, snapshot) {
  const args = ['--format=custom', '--no-owner', '--no-privileges', '--enable-row-security', `--file=${out}`];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  return pgTool(process.env.PG_DUMP || 'pg_dump', url, args);
}

function pgRestore(url, file) {
  return pgTool(process.env.PG_RESTORE || 'pg_restore', url,
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', file]);
}

async function dump(url, out, countsFile) {
  const client = new Client({ connectionString: url, application_name: 'clinicsys-backup' });
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    await client.query("select set_config('app.system', 'on', true)");
    const snapshot = (await client.query('select pg_export_snapshot() as s')).rows[0].s;
    const counts = await countTables(client);
    await pgDump(url, out, snapshot); // the transaction keeps the snapshot alive
    await client.query('commit');
    fs.writeFileSync(countsFile, JSON.stringify(counts));
  } finally {
    await client.end().catch(() => {});
  }
}

async function counts(url) {
  const client = new Client({ connectionString: url, application_name: 'clinicsys-restore-check' });
  await client.connect();
  try {
    await client.query("select set_config('app.system', 'on', false)");
    process.stdout.write(JSON.stringify(await countTables(client)));
  } finally {
    await client.end().catch(() => {});
  }
}

const [cmd, a, b] = process.argv.slice(2);
(async () => {
  if (cmd === 'dump' && a && b) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    await dump(process.env.DATABASE_URL, a, b);
  } else if (cmd === 'restore' && a) {
    if (!process.env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is not set');
    await pgRestore(process.env.RESTORE_DATABASE_URL, a);
  } else if (cmd === 'counts') {
    if (!process.env.COUNTS_DATABASE_URL) throw new Error('COUNTS_DATABASE_URL is not set');
    await counts(process.env.COUNTS_DATABASE_URL);
  } else {
    console.error('usage: backup-tools.js dump <out.dump> <counts.json> | restore <in.dump> | counts');
    process.exit(2);
  }
})().catch((err) => {
  console.error(`backup-tools: ${err.message}`);
  process.exit(1);
});
