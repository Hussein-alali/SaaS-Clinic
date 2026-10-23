'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { setup, rawRequest, freePort, TEST_DB_URL, USER } = require('./helpers');
const { loadConfig } = require('../src/config');

const API_ROOT = path.resolve(__dirname, '..');
let h;
let dist;

before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ClinicSystem</title>');
  fs.writeFileSync(path.join(dist, 'app.4ee0f65b03.js'), 'console.log("app")');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'body-diagram.jpeg'), 'JPEG');
  fs.writeFileSync(path.join(dist, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(dist, '.git'));
  fs.writeFileSync(path.join(dist, '.git', 'config'), '[core]');
  h = await setup({ dist });
});
after(async () => {
  await h.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

const securityHeaders = (res) => {
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-powered-by'], undefined);
};

test('static: index.html no-cache, hashed bundles cached for a year, SPA fallback on every domain', async () => {
  const root = await h.request('GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.text, /ClinicSystem/);
  assert.equal(root.headers['cache-control'], 'no-cache');
  securityHeaders(root);

  const bundle = await h.request('GET', '/app.4ee0f65b03.js');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(bundle.headers['content-type'], /javascript/);
  securityHeaders(bundle);

  const asset = await h.request('GET', '/assets/body-diagram.jpeg');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=3600');

  for (const host of ['demo-physio.localhost', 'admin.localhost', 'localhost']) {
    const spa = await h.request('GET', '/patients/P-1?tab=files', { headers: { host } });
    assert.equal(spa.status, 200, host);
    assert.match(spa.text, /ClinicSystem/);
    assert.equal(spa.headers['cache-control'], 'no-cache');
  }
  const head = await h.request('HEAD', '/');
  assert.equal(head.status, 200);
});

test('static: dotfiles, missing assets and server files are never served', async () => {
  for (const p of ['/.env', '/.git/config', '/%2eenv', '/assets/../.env', '/.git/', '/assets/missing.png', '/app.0000000000.js', '/seed-admin.sql']) {
    const res = await h.request('GET', p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.text, /SECRET|\[core\]/);
  }
  const post = await h.request('POST', '/', { headers: { 'x-requested-with': 'clinicsys' } });
  assert.equal(post.status, 404);
});

test('/api: unknown routes are JSON 404s with security headers and no-store', async () => {
  const res = await h.client().get('/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: { message: 'Not found', code: 'not_found' } });
  assert.equal(res.headers['cache-control'], 'no-store');
  securityHeaders(res);
  assert.equal((await h.request('GET', '/api')).status, 404);
});

test('route modules for admin/org/invitations/platform are mounted and guarded', async () => {
  // No session: 401 (admin answers in the Edge Function shape).
  const admin = await h.client().post('/api/admin/create-user', {});
  assert.equal(admin.status, 401);
  assert.deepEqual(admin.body, { ok: false, error: 'missing_token', detail: 'Authentication required' });
  for (const p of ['/api/org/invitations', '/api/platform/stats']) {
    const res = await h.client().get(p);
    assert.equal(res.status, 401, p);
    assert.equal(res.body.error.code, 'unauthorized');
  }
  // Public: an unknown invitation token is a 404.
  const inv = await h.client().get('/api/invitations/abc');
  assert.equal(inv.status, 404);
  assert.equal(inv.body.error.code, 'invitation_not_found');
  for (const name of ['admin', 'org', 'invitations', 'platform']) {
    const router = require(`../src/routes/${name}`);
    assert.equal(typeof router, 'function', `${name} exports an Express router`);
    assert.ok(router.stack.length > 0, `${name} has routes`);
  }
});

test('CSRF: every non-GET /api request needs X-Requested-With: clinicsys; public GETs do not', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  const paths = [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/password'],
    ['PATCH', '/api/auth/profile'],
    ['POST', '/api/auth/reset/request'],
    ['POST', '/api/auth/reset/confirm'],
    ['POST', '/api/data'],
    ['POST', '/api/rpc/get_treatment'],
    ['POST', '/api/files/upload'],
    ['POST', '/api/files/sign'],
    ['POST', '/api/files/remove'],
    ['DELETE', '/api/org/invitations/x'],
    ['PUT', '/api/platform/organizations/x/modules'],
  ];
  for (const [method, p] of paths) {
    const res = await h.request(method, p, { headers: { cookie: cookie.value, 'x-org-slug': 'demo-physio' }, json: {} });
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.equal(res.body.error.code, 'csrf_header_required');
  }
  assert.equal((await h.request('GET', '/api/orgs/resolve?slug=demo-physio')).status, 200);
  assert.equal((await h.request('GET', '/api/auth/session', { headers: { cookie: cookie.value } })).status, 200);
});

test('malformed bodies are 400, never 500', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  const base = { 'x-requested-with': 'clinicsys', cookie: cookie.value, 'x-org-slug': 'demo-physio' };
  const json = await h.request('POST', '/api/auth/login', { headers: { ...base, 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(json.status, 400);
  assert.equal(json.body.error.code, 'invalid_json');
  const mp = await h.request('POST', '/api/files/upload', {
    headers: { ...base, 'content-type': 'multipart/form-data; boundary=XX' },
    body: '--XX\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nunterminated',
  });
  assert.equal(mp.status, 400);
  const notJson = await h.request('POST', '/api/data', { headers: { ...base, 'content-type': 'text/plain' }, body: 'table=patients' });
  assert.equal(notJson.status, 400);
});

test('config: production refuses to start without secrets; development has defaults', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /JWT_SECRET is required[\s\S]*FILES_SIGNING_SECRET is required[\s\S]*DATABASE_URL is required/);
  const strong = 'x'.repeat(40);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short', FILES_SIGNING_SECRET: strong, DATABASE_URL: TEST_DB_URL }), /at least 32/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: strong, FILES_SIGNING_SECRET: strong, DATABASE_URL: TEST_DB_URL }), /must be different/);
  const prod = loadConfig({
    NODE_ENV: 'production',
    JWT_SECRET: strong,
    FILES_SIGNING_SECRET: `y${strong}`,
    DATABASE_URL: TEST_DB_URL,
    APP_BASE_DOMAIN: 'ClinicSysEG.com',
    COOKIE_DOMAIN: '.clinicsyseg.com',
    COOKIE_SECURE: 'true',
  });
  assert.equal(prod.appBaseDomain, 'clinicsyseg.com');
  assert.equal(prod.publicBaseUrl, 'https://clinicsyseg.com');
  assert.equal(prod.mailTransport, 'smtp');
  assert.equal(prod.cookieSecure, true);
  const dev = loadConfig({});
  assert.equal(dev.appBaseDomain, 'localhost');
  assert.equal(dev.publicBaseUrl, 'http://localhost:3000');
  assert.equal(dev.mailTransport, 'file');
  assert.equal(dev.mailOutboxDir, path.join(API_ROOT, '.outbox'));
  assert.equal(dev.filesDir, path.join(API_ROOT, 'uploads'));
  assert.equal(dev.distDir, path.resolve(API_ROOT, '..', 'dist'));
  assert.equal(dev.dbPoolMax, 10);
  assert.throws(() => loadConfig({ MAIL_TRANSPORT: 'carrier-pigeon' }), /MAIL_TRANSPORT/);
});

test('app.js: exports the app without listening when required; refuses production without secrets', () => {
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: TEST_DB_URL };
  delete env.PASSENGER_APP_ENV;
  delete env.IN_PASSENGER;
  const required = spawnSync(process.execPath, ['-e', "const app = require('./app.js'); console.log(typeof app, typeof app.listen); app.locals.close();"], {
    cwd: API_ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(required.status, 0, required.stderr);
  assert.equal(required.stdout.trim(), 'function function', 'exported and the process exits (no listener)');

  const prodEnv = { ...env, NODE_ENV: 'production' };
  delete prodEnv.JWT_SECRET;
  delete prodEnv.FILES_SIGNING_SECRET;
  const refused = spawnSync(process.execPath, ['app.js'], { cwd: API_ROOT, env: prodEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /JWT_SECRET is required/);
});

test('app.js: `node app.js` listens on PORT and serves the API', async () => {
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: TEST_DB_URL, PORT: String(port), DIST_DIR: dist };
  const child = spawn(process.execPath, ['app.js'], { cwd: API_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('app.js did not start')), 10000);
      child.stdout.on('data', (d) => {
        if (/listening on port/.test(String(d))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`app.js exited with ${code}`)));
    });
    const res = await rawRequest(port, 'GET', '/api/orgs/resolve?slug=demo-physio');
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, 'demo-physio');
    const page = await rawRequest(port, 'GET', '/');
    assert.match(page.text, /ClinicSystem/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
});
