'use strict';
// Error tracking inside the database (docs/06 S6, 0012_error_log): API
// 5xx errors and browser reports are grouped by fingerprint, scrubbed of
// e-mails and numbers, sampled at most once a minute per group, and listed
// for the Super Admin (A08).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rawRequest, USER, ORG } = require('./helpers');
const { RPC_WHITELIST } = require('../src/rpc-whitelist');
const errorlog = require('../src/errorlog');

let h, admin, sa;
before(async () => {
  h = await setup();
  // A function that fails like a server bug (SQLSTATE XX000 → 500), with a
  // phone number and an e-mail in its message.
  await h.sql(`create function public.apitest_server_bug() returns jsonb language plpgsql as $$
    begin raise exception 'call 01012345678 or a@b.test' using errcode = 'XX000'; end $$`);
  RPC_WHITELIST.add('apitest_server_bug');
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  sa = await h.as('superAdmin', { platform: true });
});
after(async () => {
  RPC_WHITELIST.delete('apitest_server_bug');
  await h.close();
});

// API errors are recorded after the response (app.locals.background).
const groups = async () => { await h.app.locals.drain(); return (await h.sql('select * from public.error_groups order by last_seen desc')).rows; };
const eventsOf = async (fp) => (await h.sql('select * from public.error_events where fingerprint = $1 order by id', [fp])).rows;

test('scrub(): e-mails, phone numbers and long digit runs, query strings; length caps', () => {
  assert.equal(errorlog.scrub('call 01012345678 or a@b.test', 500), 'call [number] or [email]');
  assert.equal(errorlog.scrub('id +20 101 234 5678 at https://x.test/p?token=abc&n=1 ok', 500), 'id [number] at https://x.test/p ok');
  assert.equal(errorlog.scrub('x'.repeat(50), 10), 'x'.repeat(10));
  assert.equal(errorlog.scrub(null, 10), null);
  // A line:column in a stack is not a number to hide.
  assert.equal(errorlog.scrub('at f (app.js:120:33)', 500), 'at f (app.js:120:33)');
});

test('an API 500: one group, counted twice, one sample within the minute, scrubbed, never the raw text', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await admin.rpc('apitest_server_bug', {});
    assert.equal(r.status, 500);
    assert.equal(r.body.error.message, 'Database error', 'the client never sees the internals');
  }
  const [g] = (await groups()).filter((x) => x.source === 'api');
  assert.ok(g, 'a group');
  assert.equal(Number(g.count), 2);
  assert.equal(g.message, 'call [number] or [email]');
  assert.equal(g.route, '/api/rpc/:fn');
  assert.equal(g.status, 500);
  const ev = await eventsOf(g.fingerprint);
  assert.equal(ev.length, 1, 'one sample a minute');
  assert.equal(ev[0].organization_id, ORG.physio);
  assert.equal(ev[0].user_id, USER.physioAdmin.id);
  assert.equal(ev[0].method, 'POST');
  const all = JSON.stringify(await h.sql('select * from public.error_groups g join public.error_events e using (fingerprint)'));
  assert.ok(!all.includes('01012345678') && !all.includes('a@b.test'));
});

test('recordError() never throws, even when the database is unreachable', async () => {
  const broken = { query: async () => { throw new Error('down'); } };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal(await errorlog.recordError(broken, { source: 'api', message: 'x' }), false);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /could not record/.test(e)));
});

test('POST /api/client-errors: no session needed; source client; org and user when signed in; 8 KB; rate-limited per IP', async () => {
  const anon = h.client({ ip: '10.60.0.1' });
  const r = await anon.post('/api/client-errors', { message: 'TypeError: x is undefined for 01098765432', stack: 'at Foo (app.abc1234567.js:1:200)', route: '#/patients' });
  assert.equal(r.status, 204, r.text);
  const signedIn = await h.as('physioReception', { slug: 'demo-physio', ip: '10.60.0.2' });
  assert.equal((await signedIn.post('/api/client-errors', { message: 'ReferenceError: y', route: '#/appointments?x=1' })).status, 204);
  const client = (await groups()).filter((g) => g.source === 'client');
  assert.deepEqual(client.map((g) => g.message).sort(), ['ReferenceError: y', 'TypeError: x is undefined for [number]']);
  const ref = client.find((g) => g.message === 'ReferenceError: y');
  assert.equal(ref.route, '#/appointments', 'no query string');
  const [ev] = await eventsOf(ref.fingerprint);
  assert.equal(ev.user_id, USER.physioReception.id);
  assert.equal(ev.organization_id, ORG.physio);

  const big = await anon.post('/api/client-errors', { message: 'x', stack: 'y'.repeat(9000) });
  assert.equal(big.status, 413);
  assert.equal((await rawRequest(h.port, 'POST', '/api/client-errors', { json: { message: 'no csrf header' } })).status, 403);
  const flood = h.client({ ip: '10.60.0.9' });
  for (let i = 0; i < 30; i++) assert.equal((await flood.post('/api/client-errors', { message: `e${i}` })).status, 204);
  assert.equal((await flood.post('/api/client-errors', { message: 'one more' })).status, 429);
  assert.equal((await anon.post('/api/client-errors', 'not an object')).status, 400);
});

test('platform: GET /errors newest first (open by default), one group with its samples, resolve; a new occurrence reopens it', async () => {
  assert.equal((await admin.get('/api/platform/errors')).status, 403, 'Super Admin only');
  const list = await sa.get('/api/platform/errors');
  assert.equal(list.status, 200, list.text);
  assert.ok(list.body.count >= 3);
  const seen = list.body.data.map((g) => Date.parse(g.last_seen));
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  const g = list.body.data.find((x) => x.source === 'api');
  const one = await sa.get(`/api/platform/errors/${g.fingerprint}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.group.fingerprint, g.fingerprint);
  assert.ok(one.body.events.length >= 1);
  assert.ok(!('stack' in g), 'the list carries no stacks');

  const done = await sa.post(`/api/platform/errors/${g.fingerprint}/resolve`, {});
  assert.equal(done.status, 200);
  assert.ok(done.body.group.resolved_at);
  assert.ok(!(await sa.get('/api/platform/errors')).body.data.some((x) => x.fingerprint === g.fingerprint), 'not in the open list');
  assert.ok((await sa.get('/api/platform/errors?status=resolved')).body.data.some((x) => x.fingerprint === g.fingerprint));
  assert.equal((await sa.get('/api/platform/stats')).body.open_errors, list.body.count - 1);

  await admin.rpc('apitest_server_bug', {});
  await h.app.locals.drain();
  const again = (await sa.get('/api/platform/errors')).body.data.find((x) => x.fingerprint === g.fingerprint);
  assert.ok(again, 'open again');
  assert.equal(again.resolved_at, null);
  assert.equal((await sa.get('/api/platform/errors/0000')).status, 404);
  assert.equal((await sa.post('/api/platform/errors/not-a-fingerprint/resolve', {})).status, 404);
});
