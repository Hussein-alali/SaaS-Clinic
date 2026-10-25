// Backups (docs/06 task S1; docs/08 «النسخ الاحتياطي»): scripts/backup.sh
// writes a consistent dump + the clinic files + a manifest with the row count
// of every table taken from the same snapshot, rotates old backups, refuses
// unsafe places and a nearly full disk; scripts/restore-check.sh restores the
// newest dump into a second, empty database and compares the counts.
//
// The restore database is "<db>_restore" next to the test database
// (scripts/dev-db.sh creates it; on cPanel it is created once by hand).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { ensureDatabase, connect } = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const BACKUP = path.join(ROOT, 'scripts', 'backup.sh');
const RESTORE_CHECK = path.join(ROOT, 'scripts', 'restore-check.sh');
const DATABASE_URL = process.env.DATABASE_URL;
const RESTORE_URL = (() => {
  const u = new URL(DATABASE_URL || 'postgres://x@127.0.0.1/x');
  u.pathname = u.pathname.replace(/\/?$/, '') + '_restore';
  return u.toString();
})();

let tmp;
let filesDir;
before(async () => {
  await ensureDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-backup-test-'));
  filesDir = path.join(tmp, 'files');
  fs.mkdirSync(path.join(filesDir, 'org-a', 'patient-files'), { recursive: true });
  fs.writeFileSync(path.join(filesDir, 'org-a', 'patient-files', 'x-ray.txt'), 'scan');
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function run(script, args, env) {
  return spawnSync('bash', [script, ...args], {
    env: { ...process.env, DATABASE_URL, FILES_DIR: filesDir, BACKUP_MIN_FREE_MB: '1', ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
}
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !d.startsWith('.')).sort() : []);

async function liveCount(table) {
  const c = await connect();
  try {
    await c.query("select set_config('app.system', 'on', false)");
    return Number((await c.query(`select count(*)::int as n from ${table}`)).rows[0].n);
  } finally { await c.end(); }
}

test('a backup is a dump, the files and a manifest with sha256 and per-table counts', async () => {
  const dir = path.join(tmp, 'b1');
  const r = run(BACKUP, [], { BACKUP_DIR: dir, BACKUP_STAMP: '20261025T020000Z' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(list(dir), ['20261025T020000Z']);
  const snap = path.join(dir, '20261025T020000Z');
  const m = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
  assert.equal(m.stamp, '20261025T020000Z');
  assert.equal(m.kind, 'weekly', '25 Oct 2026 is a Sunday');
  assert.equal(m.db.file, 'db.dump');
  assert.equal(m.db.sha256, sha256(path.join(snap, 'db.dump')));
  assert.equal(m.db.bytes, fs.statSync(path.join(snap, 'db.dump')).size);
  assert.equal(m.files.file, 'files.tar.gz');
  assert.equal(m.files.sha256, sha256(path.join(snap, 'files.tar.gz')));
  assert.match(execFileSync('tar', ['-tzf', path.join(snap, 'files.tar.gz')], { encoding: 'utf8' }), /org-a\/patient-files\/x-ray\.txt/);
  assert.equal(m.counts['public.patients'], await liveCount('public.patients'));
  assert.equal(m.counts['auth.users'], await liveCount('auth.users'));
  assert.ok(m.counts['public.patients'] > 0, 'the seed has patients: a count of 0 would mean RLS hid them');
});

test('rotation keeps the 7 newest daily and the 4 newest weekly backups; the deploys\' --db-only backups rotate on their own (5)', () => {
  const dir = path.join(tmp, 'rot');
  const kinds = () => list(dir).map((s) => [s, JSON.parse(fs.readFileSync(path.join(dir, s, 'manifest.json'), 'utf8'))]);
  const days = (kind) => kinds().filter(([, m]) => m.kind === kind).map(([s]) => s.slice(0, 8));
  // 2026-10-04 is a Sunday; 30 days → 5 Sundays, 25 other days.
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 9, 4 + d)).toISOString().slice(0, 10).replace(/-/g, '');
    const r = run(BACKUP, [], { BACKUP_DIR: dir, BACKUP_STAMP: `${day}T020000Z` });
    assert.equal(r.status, 0, r.stderr);
  }
  const weekly = ['20261011', '20261018', '20261025', '20261101'];
  const daily = ['20261026', '20261027', '20261028', '20261029', '20261030', '20261031', '20261102'];
  assert.deepEqual(days('weekly'), weekly);
  assert.deepEqual(days('daily'), daily);
  // Nine deploys afterwards (scripts/deploy.sh takes --db-only backups), one on a Sunday.
  for (let n = 0; n < 9; n++) {
    const r = run(BACKUP, ['--db-only'], { BACKUP_DIR: dir, BACKUP_STAMP: `2026110${n < 6 ? 3 : 8}T1${n}0000Z` });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(days('weekly'), weekly, 'the nightly backups with the clinic files stay');
  assert.deepEqual(days('daily'), daily);
  const dbOnly = kinds().filter(([, m]) => m.kind === 'db-only');
  assert.equal(dbOnly.length, 5);
  assert.ok(dbOnly.every(([, m]) => m.files === null), '--db-only');
  assert.ok(kinds().filter(([, m]) => m.kind !== 'db-only').every(([, m]) => m.files && m.files.bytes > 0), 'with files.tar.gz');
});

test('refuses a backup folder inside the clinic files or inside public_html', () => {
  assert.equal(run(BACKUP, [], { BACKUP_DIR: path.join(filesDir, 'backups') }).status, 4);
  assert.equal(run(BACKUP, [], { BACKUP_DIR: path.join(tmp, 'public_html', 'backups') }).status, 4);
  assert.equal(fs.existsSync(path.join(filesDir, 'backups')), false);
});

test('refuses to fill the disk: exit 3 and nothing left behind', () => {
  const dir = path.join(tmp, 'full');
  const r = run(BACKUP, [], { BACKUP_DIR: dir, BACKUP_MIN_FREE_MB: String(1e9) });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /free space|المساحة/);
  assert.deepEqual(list(dir), []);
});

test('restore-check restores the newest dump into the restore database and compares the counts', () => {
  const dir = path.join(tmp, 'b1');
  const ok = run(RESTORE_CHECK, [], { BACKUP_DIR: dir, RESTORE_DATABASE_URL: RESTORE_URL });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /public\.patients\s+\d+\s+\d+\s+ok/);
  // A manifest that disagrees with the dump must fail the check.
  const mf = path.join(dir, '20261025T020000Z', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.counts['public.patients'] += 1;
  fs.writeFileSync(mf, JSON.stringify(m));
  const bad = run(RESTORE_CHECK, [], { BACKUP_DIR: dir, RESTORE_DATABASE_URL: RESTORE_URL });
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /public\.patients\s+\d+\s+\d+\s+DIFF/);
});

// Security audit (25 Oct 2026, CWE-214): the database password used to be
// on pg_dump's, pg_restore's and backup-tools' command lines
// (--dbname=<url>), which every account of a shared server can read with
// `ps`. The tools now get it from PGPASSWORD / the environment. pg_dump,
// pg_restore and node are wrapped here to record their arguments.
test('backup and restore-check never put the database password on a command line', () => {
  const password = decodeURIComponent(new URL(DATABASE_URL).password);
  assert.ok(password, 'the test database URL has a password');
  const bin = path.join(tmp, 'spy-bin');
  const log = path.join(tmp, 'spy.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['pg_dump', 'pg_restore', 'node']) {
    const real = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nprintf '%s pgpassword=%s args=%s\\n' "${tool}" "\${PGPASSWORD:+set}" "$*" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  }
  const PATH = `${bin}:${process.env.PATH}`;
  const dir = path.join(tmp, 'b-spy');
  const b = run(BACKUP, [], { BACKUP_DIR: dir, BACKUP_STAMP: '20261026T020000Z', PATH });
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const r = run(RESTORE_CHECK, [], { BACKUP_DIR: dir, RESTORE_DATABASE_URL: RESTORE_URL, PATH });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  for (const tool of ['pg_dump', 'pg_restore']) {
    const calls = lines.filter((l) => l.startsWith(`${tool} `));
    assert.equal(calls.length, 1, `${tool} ran once`);
    assert.match(calls[0], /pgpassword=set/, `${tool} reads the password from PGPASSWORD`);
  }
  for (const l of lines) assert.equal(l.includes(password), false, `password on a command line: ${l.slice(0, 120)}`);
});

// Security audit (25 Oct 2026, CWE-276): a backup holds every clinic's
// records and the password hashes; on a shared server it is readable by
// its owner only, whatever the account's umask.
test('a backup is private to its owner: directories 0700, files 0600', () => {
  const dir = path.join(tmp, 'b-mode');
  const r = spawnSync('bash', ['-c', `umask 022 && exec bash "${BACKUP}"`], {
    env: { ...process.env, DATABASE_URL, FILES_DIR: filesDir, BACKUP_MIN_FREE_MB: '1', BACKUP_DIR: dir, BACKUP_STAMP: '20261027T020000Z' },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const snap = path.join(dir, '20261027T020000Z');
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(dir).toString(8), '700');
  assert.equal(mode(snap).toString(8), '700');
  for (const f of fs.readdirSync(snap)) assert.equal(mode(path.join(snap, f)).toString(8), '600', f);
});
