#!/usr/bin/env node
// Helpers of scripts/backup.sh and scripts/restore-check.sh (docs/06 S1).
//
//   node db/backup-tools.js dump <out.dump> <counts.json>   (DATABASE_URL)
//       pg_dump -Fc of the whole database and the row count of every table
//       in the schemas public and auth, both from ONE snapshot: the counts
//       describe exactly what the dump contains, so a restore can be checked
//       against them even while the clinics keep working.
//   node db/backup-tools.js counts <database-url>          → JSON on stdout
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

function pgDump(url, out, snapshot) {
  return new Promise((resolve, reject) => {
    const args = ['--format=custom', '--no-owner', '--no-privileges', '--enable-row-security', `--file=${out}`];
    if (snapshot) args.push(`--snapshot=${snapshot}`);
    args.push(`--dbname=${url}`);
    const child = spawn(process.env.PG_DUMP || 'pg_dump', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PGOPTIONS: `${process.env.PGOPTIONS || ''} -c app.system=on`.trim() },
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}`))));
  });
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
  } else if (cmd === 'counts' && a) {
    await counts(a);
  } else {
    console.error('usage: backup-tools.js dump <out.dump> <counts.json> | counts <database-url>');
    process.exit(2);
  }
})().catch((err) => {
  console.error(`backup-tools: ${err.message}`);
  process.exit(1);
});
