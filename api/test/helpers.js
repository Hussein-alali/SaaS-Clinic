'use strict';
// Shared test harness: the API against the REAL schema.
//   - Database: API_TEST_DATABASE_URL, else DATABASE_URL, else
//     scripts/dev-db.sh on port 55003. setup() WIPES that database (drops
//     the auth and public schemas), applies db/migrations/*.sql with
//     db/migrate.js, db/seed/dev.sql and test/fixtures/extras.sql;
//     close() leaves it migrated + seeded again (without the extras), which
//     is the state db/test expects. It refuses to wipe a database that holds
//     anything but the dev seed and these fixtures (see assertTestDatabase).
//   - Needs the db/ dependencies: npm --prefix db install.
//   - node --test runs files in parallel processes. A session-level
//     advisory lock (DB_TEST_LOCK) is taken EXCLUSIVELY by each API test
//     file, and SHARED by db/test (db/test/helpers.js shareDatabase()), so
//     `node --test 'db/test/*.test.js' 'api/test/*.test.js'` can run both
//     suites against one database.
//   - The app listens on an ephemeral port; requests go through node:http so
//     tests control the Host header, cookies and X-Forwarded-For.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { Client } = require('pg');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/create-app');

const DB_DIR = path.resolve(__dirname, '..', '..', 'db');
const TEST_DB_URL =
  process.env.API_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://clinic_owner:clinic_owner_dev@127.0.0.1:55003/clinicsys';
const DB_TEST_LOCK = 2026102210; // same key in db/test/helpers.js
const SEED = fs.readFileSync(path.join(DB_DIR, 'seed', 'dev.sql'), 'utf8');
const EXTRAS = fs.readFileSync(path.join(__dirname, 'fixtures', 'extras.sql'), 'utf8');
const PASSWORD = 'Dev@12345';

function loadMigrate() {
  try {
    return require(path.join(DB_DIR, 'migrate.js')).migrate;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(`cannot load db/migrate.js (${err.message.split('\n')[0]}): run "npm --prefix db install" first`);
    }
    throw err;
  }
}

// Ids from db/seed/dev.sql (de000000-...) and test/fixtures/extras.sql (a7000000-...).
const ORG = {
  physio: 'de000000-0000-4000-8000-0000000a0001',
  dental: 'de000000-0000-4000-8000-0000000a0002',
  suspended: 'a7000000-0000-4000-8000-0000000a0003',
  closed: 'a7000000-0000-4000-8000-0000000a0004',
  pending: 'a7000000-0000-4000-8000-0000000a0005',
  draft: 'a7000000-0000-4000-8000-0000000a0006',
};

const BRANCH = {
  physio1: 'br-demo-physio-1',
  physio2: 'br-demo-physio-2',
  dental1: 'br-demo-dental-1',
  dental2: 'br-demo-dental-2',
};

const USER = {
  // db/seed/dev.sql
  superAdmin: { id: 'de000000-0000-4000-8000-000000000001', email: 'super@clinicsys.test' },
  physioAdmin: { id: 'de000000-0000-4000-8000-000000000111', email: 'admin@demo-physio.test' },
  physioReception: { id: 'de000000-0000-4000-8000-000000000112', email: 'receptionist@demo-physio.test' }, // branch 1
  physioDoctor: { id: 'de000000-0000-4000-8000-000000000113', email: 'doctor@demo-physio.test' },
  physioTherapist: { id: 'de000000-0000-4000-8000-000000000114', email: 'therapist@demo-physio.test' },
  physioReception2: { id: 'de000000-0000-4000-8000-000000000115', email: 'receptionist2@demo-physio.test' }, // branches 1+2
  dentalAdmin: { id: 'de000000-0000-4000-8000-000000000121', email: 'admin@demo-dental.test' },
  dentalReception: { id: 'de000000-0000-4000-8000-000000000122', email: 'receptionist@demo-dental.test' },
  // test/fixtures/extras.sql
  physioStaff: { id: 'a7000000-0000-4000-8000-000000000001', email: 'staff@demo-physio.test' },
  former: { id: 'a7000000-0000-4000-8000-000000000002', email: 'former@demo-physio.test' },
  outsider: { id: 'a7000000-0000-4000-8000-000000000003', email: 'outsider@clinicsys.test' },
  multi: { id: 'a7000000-0000-4000-8000-000000000004', email: 'multi@clinicsys.test' },
  disabled: { id: 'a7000000-0000-4000-8000-000000000005', email: 'disabled@clinicsys.test' },
  changer: { id: 'a7000000-0000-4000-8000-000000000006', email: 'changer@demo-physio.test' },
  resetter: { id: 'a7000000-0000-4000-8000-000000000007', email: 'reset@demo-physio.test' },
  suspendedAdmin: { id: 'a7000000-0000-4000-8000-000000000008', email: 'admin@demo-suspended.test' },
  legacy: { id: 'a7000000-0000-4000-8000-000000000009', email: 'legacy@demo-physio.test' },
};

const KNOWN_SLUGS = ['demo-physio', 'demo-dental', 'demo-suspended', 'demo-closed', 'demo-pending', 'demo-draft'];
// Clinics the tests create through the API (/api/platform/organizations) use
// this slug prefix, and their accounts end in .test like every test account.
const TEST_SLUG_PREFIX = 'apitest-';

/**
 * Refuses to wipe a database that holds anything but test data: every
 * account must be *.test and every clinic one of the test slugs; a
 * single-clinic (pre-0003) database must have no patients.
 */
async function assertTestDatabase(client) {
  const { rows: [t] } = await client.query(`
    select to_regclass('auth.users') is not null as users,
           to_regclass('public.organizations') is not null as orgs,
           to_regclass('public.patients') is not null as patients`);
  const problems = [];
  if (t.users) {
    const { rows } = await client.query(`select email from auth.users where lower(email) !~ '\\.test$' limit 3`);
    if (rows.length) problems.push(`accounts that are not *.test (${rows.map((r) => r.email).join(', ')})`);
  }
  if (t.orgs) {
    const { rows } = await client.query(
      'select slug from public.organizations where slug <> all($1) and left(slug, $3) <> $2 limit 3',
      [KNOWN_SLUGS, TEST_SLUG_PREFIX, TEST_SLUG_PREFIX.length],
    );
    if (rows.length) problems.push(`clinics that are not test clinics (${rows.map((r) => r.slug).join(', ')})`);
  } else if (t.patients) {
    const { rows } = await client.query('select count(*)::int as n from public.patients');
    if (rows[0].n) problems.push(`${rows[0].n} patient row(s)`);
  }
  if (problems.length) {
    throw new Error(
      `refusing to wipe ${TEST_DB_URL.replace(/:[^:@/]*@/, ':***@')}: it has ${problems.join(' and ')}. ` +
        'Point API_TEST_DATABASE_URL at a scratch database (scripts/dev-db.sh reset <port>).',
    );
  }
}

/** Drops auth + public, applies the real migrations and the dev seed (+ the API fixtures). */
async function resetDatabase(client, { extras = true } = {}) {
  await assertTestDatabase(client);
  await client.query(
    'drop schema if exists auth cascade; drop schema if exists public cascade; create schema public;',
  );
  await loadMigrate()({ databaseUrl: TEST_DB_URL, log: () => {} });
  try {
    await client.query(SEED);
    if (extras) await client.query(EXTRAS);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.query("select set_config('app.system', 'off', false)").catch(() => {});
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Raw HTTP request; resolves {status, headers, body (parsed JSON or null), raw, text}. */
function rawRequest(port, method, urlPath, { headers = {}, json, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      h['content-type'] = 'application/json';
    } else if (body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    }
    if (payload) h['content-length'] = String(payload.length);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let parsed = null;
        if (/application\/json/.test(res.headers['content-type'] || '') && raw.length) parsed = JSON.parse(text);
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(res) {
  const list = res.headers['set-cookie'] || [];
  const line = list.find((c) => c.startsWith('cs_session='));
  return line ? { header: line, value: line.split(';')[0] } : null;
}

/** multipart/form-data body for /api/files/upload. */
function multipart(fields, file) {
  const boundary = `----clinicsys${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Same shape as newRecordId() in src/apiclient.jsx: prefix + base36 time + 6 random base36. */
function newRecordId(prefix) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let rnd = '';
  for (const b of crypto.randomBytes(6)) rnd += alphabet[b % 36];
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}

/**
 * Locks and resets the database, starts the API. Returns a harness:
 *   {app, config, port, sql(text, params), asSystem(text, params),
 *    asUser(userId, orgId, text, params, branchId), request(method, path, opts),
 *    client(opts), login(email, opts), as(user, opts), outbox(), close()}
 */
async function setup({ env = {}, dist } = {}) {
  const lock = new Client({ connectionString: TEST_DB_URL, application_name: 'clinicsys-api-test' });
  await lock.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [DB_TEST_LOCK]);
    await resetDatabase(lock, { extras: true });
  } catch (err) {
    await lock.end().catch(() => {});
    throw err;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-api-test-'));
  const distDir = dist || path.join(tmp, 'dist');
  const port = await freePort();
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: TEST_DB_URL,
    APP_BASE_DOMAIN: 'localhost',
    FILES_DIR: path.join(tmp, 'files'),
    MAIL_TRANSPORT: 'file',
    MAIL_OUTBOX_DIR: path.join(tmp, 'outbox'),
    DIST_DIR: distDir,
    ...env,
  });
  const app = createApp(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

  /** SQL as the table owner without a request context: platform tables and
   *  auth.* (no RLS). Clinic tables have FORCE RLS and show no rows here. */
  const sql = (text, params) => lock.query(text, params);

  async function inContext(settings, text, params) {
    await lock.query('begin');
    try {
      await lock.query(
        `select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.branch_id', $3, true), set_config('app.system', $4, true)`,
        [settings.userId || '', settings.orgId || '', settings.branchId || '', settings.system ? 'on' : 'off'],
      );
      const r = await lock.query(text, params);
      await lock.query('commit');
      return r;
    } catch (err) {
      await lock.query('rollback');
      throw err;
    }
  }
  /** SQL in the system context (app.system = 'on'): every clinic row. */
  const asSystem = (text, params) => inContext({ system: true }, text, params);
  /** SQL as a member of a clinic (RLS applies), optionally in a branch. */
  const asUser = (userId, orgId, text, params, branchId) => inContext({ userId, orgId, branchId }, text, params);

  const request = (method, urlPath, opts) => rawRequest(port, method, urlPath, opts);

  /**
   * A browser-like client: sends X-Requested-With: clinicsys, the cookie,
   * X-Org-Slug (slug), X-Branch-Id (branch), Host (host) and
   * X-Forwarded-For (ip) when given; platform: true adds X-Platform: 1
   * (the development form of the admin.<base> platform context).
   */
  function client({ cookie, slug, branch, host, ip, csrf = true, platform = false } = {}) {
    const base = () => {
      const h = {};
      if (csrf) h['x-requested-with'] = 'clinicsys';
      if (platform) h['x-platform'] = '1';
      if (cookie) h.cookie = typeof cookie === 'string' ? cookie : cookie.value;
      if (slug) h['x-org-slug'] = slug;
      if (branch) h['x-branch-id'] = branch;
      if (host) h.host = host;
      if (ip) h['x-forwarded-for'] = ip;
      return h;
    };
    return {
      get: (p, headers = {}) => request('GET', p, { headers: { ...base(), ...headers } }),
      post: (p, json, headers = {}) => request('POST', p, { headers: { ...base(), ...headers }, json }),
      patch: (p, json, headers = {}) => request('PATCH', p, { headers: { ...base(), ...headers }, json }),
      put: (p, json, headers = {}) => request('PUT', p, { headers: { ...base(), ...headers }, json }),
      del: (p, headers = {}) => request('DELETE', p, { headers: { ...base(), ...headers } }),
      data: (body, headers = {}) => request('POST', '/api/data', { headers: { ...base(), ...headers }, json: body }),
      rpc: (fn, args, headers = {}) => request('POST', `/api/rpc/${fn}`, { headers: { ...base(), ...headers }, json: { args } }),
      upload: (fields, file, headers = {}) => {
        const mp = multipart(fields, file);
        return request('POST', '/api/files/upload', {
          headers: { ...base(), ...headers, 'content-type': mp.contentType },
          body: mp.body,
        });
      },
    };
  }

  /** Logs in and returns {cookie, res}. Throws unless 200. */
  async function login(email, { password = PASSWORD, remember, ip } = {}) {
    const res = await client({ ip }).post('/api/auth/login', { email, password, remember });
    if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${res.text}`);
    return { cookie: sessionCookie(res), res };
  }

  /** Signed-in client for a user in a clinic (slug) with optional branch. */
  async function as(userKeyOrEmail, opts = {}) {
    const email = USER[userKeyOrEmail] ? USER[userKeyOrEmail].email : userKeyOrEmail;
    const { cookie } = await login(email);
    return client({ cookie, ...opts });
  }

  function outbox() {
    const dir = config.mailOutboxDir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    try {
      // Leave the database as db/test expects it: migrated + dev seed only.
      if (!process.env.API_TEST_KEEP_DB) await resetDatabase(lock, { extras: false });
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [DB_TEST_LOCK]).catch(() => {});
      await lock.end();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { app, config, port, tmp, sql, asSystem, asUser, request, client, login, as, outbox, close };
}

module.exports = {
  setup,
  rawRequest,
  sessionCookie,
  multipart,
  freePort,
  newRecordId,
  resetDatabase,
  TEST_DB_URL,
  DB_TEST_LOCK,
  ORG,
  BRANCH,
  USER,
  PASSWORD,
  TEST_SLUG_PREFIX,
};
