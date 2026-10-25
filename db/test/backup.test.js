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

test('rotation keeps the 7 newest daily and the 4 newest weekly backups', () => {
  const dir = path.join(tmp, 'rot');
  // 2026-10-04 is a Sunday; 30 days → 5 Sundays, 25 other days.
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 9, 4 + d)).toISOString().slice(0, 10).replace(/-/g, '');
    const r = run(BACKUP, ['--db-only'], { BACKUP_DIR: dir, BACKUP_STAMP: `${day}T020000Z` });
    assert.equal(r.status, 0, r.stderr);
  }
  const kept = list(dir).map((s) => [s, JSON.parse(fs.readFileSync(path.join(dir, s, 'manifest.json'), 'utf8')).kind]);
  const weekly = kept.filter(([, k]) => k === 'weekly').map(([s]) => s.slice(0, 8));
  const daily = kept.filter(([, k]) => k === 'daily').map(([s]) => s.slice(0, 8));
  assert.deepEqual(weekly, ['20261011', '20261018', '20261025', '20261101']);
  assert.deepEqual(daily, ['20261026', '20261027', '20261028', '20261029', '20261030', '20261031', '20261102']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, kept[0][0], 'manifest.json'), 'utf8')).files, null, '--db-only');
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
