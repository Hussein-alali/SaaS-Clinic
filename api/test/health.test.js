'use strict';
// GET /api/health (docs/06 S2): what scripts/deploy.sh and monitoring poll.
// No session, no clinic, no X-Requested-With; one `select 1` with a short
// timeout; the release name comes from RELEASE.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, rawRequest, freePort } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/create-app');

let h;
before(async () => { h = await setup({ env: { RELEASE: '20261025T120000Z-test' } }); });
after(async () => { await h.close(); });

test('200 with the database up, the release name and no-store', async () => {
  const res = await rawRequest(h.port, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, db: 'ok', release: '20261025T120000Z-test' });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('503 within a few seconds when the database is down', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-health-'));
  const dead = await freePort();
  const port = await freePort();
  const app = createApp(loadConfig({
    NODE_ENV: 'test', PORT: String(port), APP_BASE_DOMAIN: 'localhost',
    DATABASE_URL: `postgres://nobody:nothing@127.0.0.1:${dead}/none`,
    FILES_DIR: path.join(tmp, 'files'), MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: path.join(tmp, 'out'),
    DIST_DIR: path.join(tmp, 'dist'),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  try {
    const started = Date.now();
    const res = await rawRequest(port, 'GET', '/api/health');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, db: 'down', release: null });
    assert.ok(Date.now() - started < 4000, 'answers fast');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
