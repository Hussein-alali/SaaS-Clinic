'use strict';
// api/scripts/create-super-admin.js, run as a child process against the test database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { setup, TEST_DB_URL, USER, PASSWORD } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'create-super-admin.js');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

function run(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const isSuper = async (email) => {
  const { rowCount } = await h.sql('select 1 from platform_admins p join auth.users u on u.id = p.user_id where lower(u.email) = lower($1)', [email]);
  return rowCount === 1;
};

test('creates a new Super Admin who can sign in and use /api/platform; audited', async () => {
  const r = await run(['--email', 'Owner@ClinicSys.test', '--password', 'Owner#2026', '--name', 'Platform Owner']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Super Admin created: owner@clinicsys\.test \([0-9a-f-]{36}\)/);
  assert.equal(await isSuper('owner@clinicsys.test'), true);
  const { cookie, res } = await h.login('owner@clinicsys.test', { password: 'Owner#2026' });
  assert.equal(res.body.is_super_admin, true);
  assert.equal(res.body.user.name, 'Platform Owner');
  const stats = await h.client({ cookie, platform: true }).get('/api/platform/stats');
  assert.equal(stats.status, 200);
  const { rows } = await h.asSystem("select * from audit_events where action = 'platform_admin.create'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].organization_id, null);
  assert.equal(rows[0].payload.email, 'owner@clinicsys.test');
  assert.ok(!JSON.stringify(rows[0].payload).includes('Owner#2026'));
});

test('promotes an existing account (password kept unless given); a second run only updates', async () => {
  const before = await h.login(USER.physioAdmin.email);
  const r = await run(['--email', USER.physioAdmin.email]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Super Admin promoted: admin@demo-physio\.test/);
  assert.equal(await isSuper(USER.physioAdmin.email), true);
  const still = await h.client({ cookie: before.cookie }).get('/api/auth/session');
  assert.equal(still.status, 200, 'no password given: sessions continue');
  assert.equal(still.body.is_super_admin, true);

  const again = await run([`--email=${USER.physioAdmin.email}`, '--password', 'Changed#2026']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Super Admin updated/);
  assert.equal((await h.client({ cookie: before.cookie }).get('/api/auth/session')).status, 401, 'a new password ends sessions');
  await h.login(USER.physioAdmin.email, { password: 'Changed#2026' });
  const { rows } = await h.sql('select count(*)::int as n from platform_admins where user_id = $1', [USER.physioAdmin.id]);
  assert.equal(rows[0].n, 1);
  // a disabled account is re-activated
  const dis = await run(['--email', USER.disabled.email]);
  assert.equal(dis.code, 0, dis.stderr);
  await h.login(USER.disabled.email, { password: PASSWORD });
});

test('--password-stdin, and errors exit with 1 without changing anything', async () => {
  const r = await run(['--email', 'stdin@clinicsys.test', '--password-stdin'], { stdin: 'Stdin#2026\n' });
  assert.equal(r.code, 0, r.stderr);
  await h.login('stdin@clinicsys.test', { password: 'Stdin#2026' });

  const failures = [
    [['--email', 'not-an-email', '--password', 'Valid#2026'], /valid e-mail/],
    [['--email', 'weak@clinicsys.test', '--password', '123'], /at least 6/],
    [['--email', 'nopass@clinicsys.test'], /needs --password/],
    [['--email', 'x@clinicsys.test', '--bogus', 'y'], /unknown option --bogus/],
    [['--email'], /needs a value/],
    [['stray'], /unexpected argument/],
  ];
  for (const [args, message] of failures) {
    const f = await run(args);
    assert.equal(f.code, 1, args.join(' '));
    assert.match(f.stderr, message);
  }
  for (const email of ['weak@clinicsys.test', 'nopass@clinicsys.test', 'x@clinicsys.test']) {
    const { rowCount } = await h.sql('select 1 from auth.users where email = $1', [email]);
    assert.equal(rowCount, 0, email);
  }
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage:/);
});
