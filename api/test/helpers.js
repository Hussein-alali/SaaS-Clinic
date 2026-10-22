'use strict';
// Shared test harness.
//   - Database: API_TEST_DATABASE_URL, default scripts/dev-db.sh on port 55003
//     ("scripts/dev-db.sh start 55003"). Never DATABASE_URL: every setup()
//     DROPS the auth and public schemas and reloads test/fixtures/schema.sql.
//   - node --test runs files in parallel processes; a session-level advisory
//     lock makes each file own the database while it runs.
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

const TEST_DB_URL =
  process.env.API_TEST_DATABASE_URL || 'postgres://clinic_owner:clinic_owner_dev@127.0.0.1:55003/clinicsys';
const LOCK_KEY = 260626; // plan task 2.6
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'schema.sql'), 'utf8');
const PASSWORD = 'Dev@12345';

const ORG = {
  physio: '10000000-0000-4000-8000-000000000001',
  dental: '10000000-0000-4000-8000-000000000002',
  suspended: '10000000-0000-4000-8000-000000000003',
  closed: '10000000-0000-4000-8000-000000000004',
  pending: '10000000-0000-4000-8000-000000000005',
  draft: '10000000-0000-4000-8000-000000000006',
};

const USER = {
  superAdmin: { id: '00000000-0000-4000-8000-000000000002', email: 'super@clinicsys.test' },
  physioAdmin: { id: '00000000-0000-4000-8000-000000000011', email: 'admin@demo-physio.test' },
  physioReception: { id: '00000000-0000-4000-8000-000000000012', email: 'receptionist@demo-physio.test' },
  physioDoctor: { id: '00000000-0000-4000-8000-000000000013', email: 'doctor@demo-physio.test' },
  physioStaff: { id: '00000000-0000-4000-8000-000000000014', email: 'staff@demo-physio.test' },
  former: { id: '00000000-0000-4000-8000-000000000015', email: 'former@demo-physio.test' },
  physioTherapist: { id: '00000000-0000-4000-8000-000000000016', email: 'therapist@demo-physio.test' },
  dentalAdmin: { id: '00000000-0000-4000-8000-000000000021', email: 'admin@demo-dental.test' },
  suspendedAdmin: { id: '00000000-0000-4000-8000-000000000031', email: 'admin@demo-suspended.test' },
  outsider: { id: '00000000-0000-4000-8000-000000000041', email: 'outsider@clinicsys.test' },
  multi: { id: '00000000-0000-4000-8000-000000000042', email: 'multi@clinicsys.test' },
  disabled: { id: '00000000-0000-4000-8000-000000000043', email: 'disabled@clinicsys.test' },
  changer: { id: '00000000-0000-4000-8000-000000000044', email: 'changer@demo-physio.test' },
  resetter: { id: '00000000-0000-4000-8000-000000000045', email: 'reset@demo-physio.test' },
};

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

/**
 * Locks and resets the database, starts the API. Returns a harness:
 *   {app, config, port, sql(text, params), asUser(userId, orgId, sql, params),
 *    request(method, path, opts), client(opts), login(email, opts), outbox(), close()}
 */
async function setup({ env = {}, dist } = {}) {
  const lock = new Client({ connectionString: TEST_DB_URL });
  await lock.connect();
  await lock.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  await lock.query('drop schema if exists auth cascade; drop schema if exists public cascade; create schema public; create schema auth;');
  await lock.query(FIXTURE);

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

  const sql = (text, params) => lock.query(text, params);

  /** Runs SQL as a member (RLS applies) — for seeding inside a clinic. */
  async function asUser(userId, orgId, text, params) {
    await lock.query('begin');
    try {
      await lock.query("select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [userId, orgId]);
      const r = await lock.query(text, params);
      await lock.query('commit');
      return r;
    } catch (err) {
      await lock.query('rollback');
      throw err;
    }
  }

  const request = (method, urlPath, opts) => rawRequest(port, method, urlPath, opts);

  /**
   * A browser-like client: sends X-Requested-With: clinicsys, the cookie,
   * X-Org-Slug (slug), X-Branch-Id (branch), Host (host) and
   * X-Forwarded-For (ip) when given.
   */
  function client({ cookie, slug, branch, host, ip, csrf = true } = {}) {
    const base = () => {
      const h = {};
      if (csrf) h['x-requested-with'] = 'clinicsys';
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
    await lock.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await lock.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { app, config, port, tmp, sql, asUser, request, client, login, as, outbox, close };
}

module.exports = { setup, rawRequest, sessionCookie, multipart, freePort, TEST_DB_URL, ORG, USER, PASSWORD };
