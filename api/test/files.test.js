'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, USER, ORG } = require('./helpers');
const files = require('../src/files');

let h;
let admin;
let dental;
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  dental = await h.as('dentalAdmin', { slug: 'demo-dental' });
});
after(async () => {
  await h.close();
});

const PDF = Buffer.from('%PDF-1.4\n% test file\n');
const up = (c, objectPath, opts = {}) =>
  c.upload(
    { bucket: opts.bucket || 'patient-files', path: objectPath, ...(opts.upsert !== undefined ? { upsert: String(opts.upsert) } : {}) },
    // the stored name comes from `path`; the multipart filename is just the browser's file name
    { name: 'upload.bin', type: opts.type || 'application/pdf', data: opts.data || PDF },
  );

test('upload stores FILES_DIR/<org>/<bucket>/<path>; download needs session + clinic', async () => {
  const res = await up(admin, 'P-PHY-1/F-1-report.pdf');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { path: 'P-PHY-1/F-1-report.pdf', fullPath: 'patient-files/P-PHY-1/F-1-report.pdf' });
  const onDisk = path.join(h.config.filesDir, ORG.physio, 'patient-files', 'P-PHY-1', 'F-1-report.pdf');
  assert.deepEqual(fs.readFileSync(onDisk), PDF);
  assert.deepEqual(fs.readdirSync(path.join(h.config.filesDir, '.tmp')), [], 'temporary upload removed');

  const get = await admin.get('/api/files/object/patient-files/P-PHY-1/F-1-report.pdf');
  assert.equal(get.status, 200);
  assert.deepEqual(get.raw, PDF);
  assert.equal(get.headers['content-type'], 'application/pdf');
  assert.match(get.headers['content-disposition'], /^inline; filename\*=UTF-8''F-1-report\.pdf$/);
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.match(get.headers['content-security-policy'], /sandbox/);

  // <img src> cannot send X-Org-Slug: ?org= names the clinic, membership still checked
  const { cookie } = await h.login(USER.physioAdmin.email);
  const viaQuery = await h.client({ cookie, csrf: false }).get('/api/files/object/patient-files/P-PHY-1/F-1-report.pdf?org=demo-physio');
  assert.equal(viaQuery.status, 200);
  assert.equal((await h.client({ csrf: false }).get('/api/files/object/patient-files/P-PHY-1/F-1-report.pdf?org=demo-physio')).status, 401);
  assert.equal((await admin.get('/api/files/object/patient-files/P-PHY-1/missing.pdf')).status, 404);
});

test('upsert: 409 when the object exists, replaced with upsert=true (admin/receptionist only)', async () => {
  assert.equal((await up(admin, 'P-PHY-1/F-2.pdf')).status, 200);
  const dup = await up(admin, 'P-PHY-1/F-2.pdf');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'already_exists');
  const v2 = Buffer.from('%PDF-1.4\n% version 2\n');
  const replaced = await up(admin, 'P-PHY-1/F-2.pdf', { upsert: true, data: v2 });
  assert.equal(replaced.status, 200);
  assert.deepEqual((await admin.get('/api/files/object/patient-files/P-PHY-1/F-2.pdf')).raw, v2);
  const doctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  const docReplace = await up(doctor, 'P-PHY-1/F-2.pdf', { upsert: true });
  assert.equal(docReplace.status, 403);
});

test('cross-clinic access is impossible', async () => {
  await up(admin, 'P-PHY-1/secret.pdf');
  // the same path in the other clinic is another (missing) object
  assert.equal((await dental.get('/api/files/object/patient-files/P-PHY-1/secret.pdf')).status, 404);
  assert.equal((await dental.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-1/secret.pdf' })).status, 404);
  const removed = await dental.post('/api/files/remove', { bucket: 'patient-files', paths: ['P-PHY-1/secret.pdf'] });
  assert.deepEqual(removed.body, { removed: [] });
  assert.ok(fs.existsSync(path.join(h.config.filesDir, ORG.physio, 'patient-files', 'P-PHY-1', 'secret.pdf')));
  // pointing at the other clinic is a membership check, not a path
  const { cookie } = await h.login(USER.dentalAdmin.email);
  const asPhysio = await h.client({ cookie, slug: 'demo-physio' }).get('/api/files/object/patient-files/P-PHY-1/secret.pdf');
  assert.equal(asPhysio.status, 403);
  // uploads from dental land in dental's folder
  await up(dental, 'P-PHY-1/secret.pdf', { data: Buffer.from('dental copy') });
  assert.equal(fs.readFileSync(path.join(h.config.filesDir, ORG.dental, 'patient-files', 'P-PHY-1', 'secret.pdf'), 'utf8'), 'dental copy');
  assert.deepEqual(fs.readFileSync(path.join(h.config.filesDir, ORG.physio, 'patient-files', 'P-PHY-1', 'secret.pdf')), PDF);
});

test('path traversal and bad buckets are rejected', async () => {
  const badPaths = ['../x.pdf', 'a/../../x.pdf', '/etc/passwd', 'a\\b.pdf', 'a\u0000b.pdf', '.hidden/x.pdf', 'a//b.pdf', 'a/./b.pdf', 'a/', '', 'x..pdf'];
  for (const p of badPaths) {
    if (p === '') continue;
    const res = await up(admin, p);
    assert.equal(res.status, 400, JSON.stringify(p));
    assert.equal(res.body.error.code, 'invalid_path');
    const sign = await admin.post('/api/files/sign', { bucket: 'patient-files', path: p });
    assert.equal(sign.status, 400, `sign ${JSON.stringify(p)}`);
  }
  const empty = await admin.upload({ bucket: 'patient-files', path: '' }, { name: 'x.pdf', data: PDF });
  assert.equal(empty.status, 400);
  for (const p of ['%2e%2e/%2e%2e/x.pdf', '..%2Fx.pdf', 'a/%2e%2e/%2e%2e/b.pdf', 'a%5Cb.pdf', 'a%00b.pdf']) {
    const res = await admin.get(`/api/files/object/patient-files/${p}`);
    assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  const traversal = await admin.get('/api/files/object/patient-files/%2e%2e/%2e%2e/%2e%2e/etc/passwd');
  assert.equal(traversal.status, 400);
  const bucket = await up(admin, 'P-PHY-1/x.pdf', { bucket: 'avatars' });
  assert.equal(bucket.status, 400);
  assert.equal(bucket.body.error.code, 'invalid_bucket');
  assert.equal((await admin.get('/api/files/object/other-bucket/P-PHY-1/F-1-report.pdf')).status, 400);
  assert.equal((await admin.post('/api/files/remove', { bucket: 'patient-files', paths: ['../../x'] })).status, 400);
  // nothing escaped the clinic folder
  const top = fs.readdirSync(h.config.filesDir).sort();
  assert.deepEqual(top.filter((d) => !['.tmp', ORG.physio, ORG.dental].includes(d)), []);
});

test('20 MB upload limit → 413', async () => {
  const big = Buffer.alloc(files.MAX_FILE_BYTES + 1, 0x61);
  const res = await up(admin, 'P-PHY-1/too-big.pdf', { data: big });
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'file_too_large');
  assert.ok(!fs.existsSync(path.join(h.config.filesDir, ORG.physio, 'patient-files', 'P-PHY-1', 'too-big.pdf')));
  const exact = await up(admin, 'P-PHY-1/exactly-20mb.pdf', { data: Buffer.alloc(files.MAX_FILE_BYTES, 0x61) });
  assert.equal(exact.status, 200);
  await admin.post('/api/files/remove', { bucket: 'patient-files', paths: ['P-PHY-1/exactly-20mb.pdf'] });
});

test('storage limit of the plan → 422 (dental plan: 1 MB)', async () => {
  const half = Buffer.alloc(600 * 1024, 0x62);
  assert.equal((await up(dental, 'P-DEN-1/a.pdf', { data: half })).status, 200);
  const over = await up(dental, 'P-DEN-1/b.pdf', { data: half });
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'plan_limit_storage');
  await dental.post('/api/files/remove', { bucket: 'patient-files', paths: ['P-DEN-1/a.pdf'] });
});

test('signed URLs: HMAC token, expiresIn capped at 600 s, expiry and tampering refused', async () => {
  await up(admin, 'P-PHY-2/scan.png', { type: 'image/png', data: Buffer.from('PNGDATA') });
  const sign = await admin.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-2/scan.png', expiresIn: 3600 });
  assert.equal(sign.status, 200);
  assert.match(sign.body.signedUrl, /^\/api\/files\/signed\?token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token = sign.body.signedUrl.split('token=')[1];
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['b', 'e', 'o', 'p']);
  assert.equal(payload.o, ORG.physio);
  assert.ok(payload.e - Math.floor(Date.now() / 1000) <= 600, 'never valid longer than 10 minutes');

  const dl = await h.request('GET', sign.body.signedUrl); // no cookie, no headers
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'PNGDATA');
  assert.equal(dl.headers['content-type'], 'image/png');

  const [p, s] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ ...payload, o: ORG.dental })).toString('base64url');
  for (const t of [`${forgedPayload}.${s}`, `${p}.${s.slice(0, -2)}AA`, `${p}`, 'garbage', '']) {
    const r = await h.request('GET', `/api/files/signed?token=${t}`);
    assert.equal(r.status, 403, t);
  }
  const expired = files.signToken(h.config, { orgId: ORG.physio, bucket: 'patient-files', objectPath: 'P-PHY-2/scan.png', expiresAt: Math.floor(Date.now() / 1000) - 1 });
  const e = await h.request('GET', `/api/files/signed?token=${expired}`);
  assert.equal(e.status, 403);
  assert.equal(e.body.error.code, 'token_expired');

  const short = await admin.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-2/scan.png', expiresIn: 1 });
  await new Promise((r) => setTimeout(r, 2100));
  const late = await h.request('GET', short.body.signedUrl);
  assert.equal(late.status, 403, 'expired after expiresIn');

  for (const expiresIn of [0, -5, 'x']) {
    assert.equal((await admin.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-2/scan.png', expiresIn })).status, 400);
  }
  assert.equal((await admin.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-2/none.png' })).status, 404);

  // a suspended clinic's links stop working
  const live = await admin.post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-2/scan.png' });
  await h.sql("update organizations set status = 'suspended' where id = $1", [ORG.physio]);
  try {
    assert.equal((await h.request('GET', live.body.signedUrl)).status, 403);
  } finally {
    await h.sql("update organizations set status = 'active' where id = $1", [ORG.physio]);
  }
  assert.equal((await h.request('GET', live.body.signedUrl)).status, 200);
});

test('roles: staff cannot read; others remove only what they uploaded; admin removes anything', async () => {
  const staff = await h.as('physioStaff', { slug: 'demo-physio' });
  assert.equal((await staff.get('/api/files/object/patient-files/P-PHY-1/F-1-report.pdf')).status, 403);
  assert.equal((await up(staff, 'P-PHY-1/staff.pdf')).status, 403);

  const doctor = await h.as('physioDoctor', { slug: 'demo-physio' });
  assert.equal((await up(doctor, 'P-PHY-3/doc-own.pdf')).status, 200);
  await up(admin, 'P-PHY-3/admin-own.pdf');
  const r1 = await doctor.post('/api/files/remove', { bucket: 'patient-files', paths: ['P-PHY-3/doc-own.pdf', 'P-PHY-3/admin-own.pdf', 'P-PHY-3/none.pdf'] });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { removed: ['P-PHY-3/doc-own.pdf'] });
  const r2 = await admin.post('/api/files/remove', { bucket: 'patient-files', paths: ['P-PHY-3/admin-own.pdf'] });
  assert.deepEqual(r2.body, { removed: ['P-PHY-3/admin-own.pdf'] });
  assert.equal((await admin.get('/api/files/object/patient-files/P-PHY-3/admin-own.pdf')).status, 404);
  assert.equal((await admin.post('/api/files/remove', { bucket: 'patient-files', paths: [] })).status, 400);
});

test('dangerous types are never rendered inline', async () => {
  await up(admin, 'P-PHY-1/page.html', { type: 'text/html', data: Buffer.from('<script>alert(1)</script>') });
  const res = await admin.get('/api/files/object/patient-files/P-PHY-1/page.html');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.match(res.headers['content-disposition'], /^attachment;/);
  await up(admin, 'P-PHY-1/logo.svg', { type: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>') });
  const svg = await admin.get('/api/files/object/patient-files/P-PHY-1/logo.svg');
  assert.equal(svg.headers['content-type'], 'application/octet-stream');
  assert.match(svg.headers['content-disposition'], /^attachment;/);
});

test('files need the CSRF header for writes, a session and a clinic', async () => {
  const { cookie } = await h.login(USER.physioAdmin.email);
  const noCsrf = await h.client({ cookie, slug: 'demo-physio', csrf: false }).upload({ bucket: 'patient-files', path: 'P-PHY-1/c.pdf' }, { name: 'c.pdf', data: PDF });
  assert.equal(noCsrf.status, 403);
  assert.equal((await h.client({ slug: 'demo-physio' }).upload({ bucket: 'patient-files', path: 'P-PHY-1/c.pdf' }, { name: 'c.pdf', data: PDF })).status, 401);
  assert.equal((await h.client({ cookie }).post('/api/files/sign', { bucket: 'patient-files', path: 'P-PHY-1/F-1-report.pdf' })).status, 403);
  const noFile = await admin.upload({ bucket: 'patient-files', path: 'P-PHY-1/c.pdf' });
  assert.equal(noFile.status, 400);
});
