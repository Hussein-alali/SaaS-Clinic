'use strict';
// Incoming webhooks (docs/06 S10, api/src/webhooks.js): a provider is on
// only with WEBHOOK_<NAME>_SECRET; each delivery is signed (HMAC-SHA256 of
// "<event id>.<timestamp>.<raw body>"), recent (5 minutes), deduplicated by
// its event id, and queued as a job instead of processed in the request. No provider
// exists today: "fakepay" stands for one. setup() wipes and re-seeds the
// database for this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup } = require('./helpers');
const { verifySignature, sign } = require('../src/webhooks');
const { loadConfig } = require('../src/config');

const SECRET = 'whsec_test_0123456789abcdef0123456789';
let h;
before(async () => { h = await setup({ env: { WEBHOOK_FAKEPAY_SECRET: SECRET } }); });
after(async () => { await h.close(); });

const now = () => Math.floor(Date.now() / 1000);
const hmac = (secret, id, ts, body) => crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('hex');

test('verifySignature: HMAC-SHA256 of "<event id>.<timestamp>.<raw body>", constant-time, within the replay window', () => {
  const body = '{"type":"payment.succeeded","data":{"amount":100}}';
  const ts = now();
  const id = 'evt_unit_1';
  const good = hmac(SECRET, id, ts, body);
  const v = (o) => verifySignature({ secret: SECRET, eventId: id, rawBody: body, signatureHex: good, timestamp: ts, ...o });
  assert.equal(sign(SECRET, id, ts, body), good);
  assert.equal(v({}), true);
  assert.equal(v({ signatureHex: `sha256=${good}`, timestamp: String(ts) }), true, 'sha256= prefix');
  assert.equal(v({ secret: 'other' }), false, 'another secret');
  assert.equal(v({ rawBody: body.replace('100', '900') }), false, 'body changed');
  assert.equal(v({ signatureHex: hmac(SECRET, id, ts + 1, body) }), false, 'timestamp changed');
  assert.equal(v({ eventId: 'evt_unit_2' }), false, 'event id changed: a replay cannot pass as a new event');
  const old = ts - 600;
  assert.equal(v({ signatureHex: hmac(SECRET, id, old, body), timestamp: old }), false, '10 minutes old');
  const ahead = ts + 600;
  assert.equal(v({ signatureHex: hmac(SECRET, id, ahead, body), timestamp: ahead }), false, '10 minutes ahead');
  assert.equal(v({ signatureHex: hmac(SECRET, id, old, body), timestamp: old, now: (old + 60) * 1000 }), true, 'clock passed in');
  for (const bad of ['', 'zz', good.slice(0, 63), `${good}00`, null, undefined, 42]) {
    assert.equal(v({ signatureHex: bad }), false, `signature ${bad}`);
  }
  for (const bad of ['', 'abc', null, '1e3', ts + 0.5]) assert.equal(v({ timestamp: bad }), false, `timestamp ${bad}`);
  assert.equal(v({ secret: '', signatureHex: hmac('', id, ts, body) }), false, 'no secret, no webhook');
  assert.equal(v({ eventId: '' }), false, 'no event id');
});

test('config: WEBHOOK_<NAME>_SECRET turns a provider on (lower case, "_" → "-"); a short secret is refused; none by default', () => {
  assert.deepEqual({ ...loadConfig({}).webhooks }, {});
  const c = loadConfig({ WEBHOOK_FAKEPAY_SECRET: SECRET, WEBHOOK_PAY_MOB_SECRET: SECRET, WEBHOOK_EMPTY_SECRET: '' });
  assert.deepEqual({ ...c.webhooks }, { fakepay: SECRET, 'pay-mob': SECRET });
  assert.throws(() => loadConfig({ WEBHOOK_FAKEPAY_SECRET: 'short' }), /WEBHOOK_FAKEPAY_SECRET must be at least 32/);
});

// A delivery as the provider sends it: no session, no CSRF header, raw JSON.
function deliver(body, { id = `evt_${crypto.randomUUID()}`, ts = now(), secret = SECRET, provider = 'fakepay', signature } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return h.request('POST', `/api/webhooks/${provider}`, {
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': id,
      'x-webhook-timestamp': String(ts),
      'x-webhook-signature': signature === undefined ? hmac(secret, id, ts, raw) : signature,
    },
    body: raw,
  });
}
const jobsFor = async (eventId) => (await h.sql(
  "select kind, payload, attempts, done_at from public.jobs where kind like 'webhook.%' and payload->>'eventId' = $1", [eventId])).rows;

test('a valid delivery: 200 {received:true} at once, and one job webhook.<provider>.<type> with the event', async () => {
  const id = 'evt_valid_1';
  const res = await deliver({ type: 'payment.succeeded', data: { amount: 100, reference: 'R-1' } }, { id });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { received: true });
  const jobs = await jobsFor(id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'webhook.fakepay.payment.succeeded');
  assert.deepEqual(jobs[0].payload.data, { amount: 100, reference: 'R-1' });
  assert.equal(jobs[0].payload.provider, 'fakepay');
  assert.equal(jobs[0].payload.type, 'payment.succeeded');
  assert.equal(jobs[0].done_at, null, 'processed by the job runner, not in the request');
});

test('the same event again (a provider retry): 200 {received:true, duplicate:true}, still one job', async () => {
  const id = 'evt_dup_1';
  const body = { type: 'payment.succeeded', data: { amount: 5 } };
  assert.deepEqual((await deliver(body, { id })).body, { received: true });
  const again = await deliver(body, { id, ts: now() + 1 });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, { received: true, duplicate: true });
  // Two deliveries of one event at the same moment: still one job.
  const id2 = 'evt_race_1';
  const both = await Promise.all([deliver(body, { id: id2 }), deliver(body, { id: id2 })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(both.filter((r) => r.body.duplicate).length, 1);
  assert.equal((await jobsFor(id)).length, 1);
  assert.equal((await jobsFor(id2)).length, 1);
});

test('refused with 400 and nothing queued: wrong signature, another secret, a timestamp 10 minutes old, a changed body', async () => {
  const body = { type: 'payment.succeeded', data: { amount: 1 } };
  const cases = [
    ['evt_bad_sig', { signature: 'ab'.repeat(32) }],
    ['evt_bad_secret', { secret: 'whsec_another_secret_0123456789abcd' }],
    ['evt_stale', { ts: now() - 600 }],
    ['evt_no_sig', { signature: '' }],
  ];
  for (const [id, opts] of cases) {
    const res = await deliver(body, { id, ...opts });
    assert.equal(res.status, 400, `${id}: ${res.text}`);
    assert.equal(res.body.error.code, 'invalid_signature', id);
    assert.equal((await jobsFor(id)).length, 0, id);
  }
  // Signed for one body, sent with another.
  const ts = now();
  const res = await deliver(JSON.stringify({ type: 'payment.succeeded', data: { amount: 999 } }),
    { id: 'evt_changed', ts, signature: hmac(SECRET, 'evt_changed', ts, JSON.stringify(body)) });
  assert.equal(res.status, 400);
  assert.equal((await jobsFor('evt_changed')).length, 0);
  // A captured delivery sent again within the window under a new event id.
  const raw = JSON.stringify(body);
  const sig = hmac(SECRET, 'evt_captured', ts, raw);
  assert.equal((await deliver(raw, { id: 'evt_captured', ts, signature: sig })).status, 200);
  const replay = await deliver(raw, { id: 'evt_captured_again', ts, signature: sig });
  assert.equal(replay.status, 400, replay.text);
  assert.equal((await jobsFor('evt_captured_again')).length, 0);
});

test('400 invalid_webhook for an unreadable delivery (no id, no type, not JSON); 404 for a provider without a secret', async () => {
  for (const [label, raw, opts] of [
    ['not JSON', 'type=payment', {}],
    ['no type', JSON.stringify({ data: {} }), {}],
    ['bad type', JSON.stringify({ type: 'a b/c', data: {} }), {}],
    ['no id', JSON.stringify({ type: 'payment.succeeded' }), { id: '' }],
  ]) {
    const res = await deliver(raw, opts);
    assert.equal(res.status, 400, `${label}: ${res.text}`);
    assert.equal(res.body.error.code, 'invalid_webhook', label);
  }
  const other = await deliver({ type: 'payment.succeeded' }, { provider: 'otherpay' });
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'not_found');
  // Other API routes still need the CSRF header (the webhook path is the exception).
  const data = await h.request('POST', '/api/data', { json: { table: 'patients' } });
  assert.equal(data.status, 403);
});
