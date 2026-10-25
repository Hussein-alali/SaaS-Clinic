'use strict';
// Incoming webhooks (docs/06 S10): the foundation for the providers that
// will call the platform (online payments, SMS/WhatsApp delivery receipts).
// None is configured today — subscriptions are set by hand — and
// WEBHOOK_<NAME>_SECRET turns one on at POST /api/webhooks/<name>
// (config.webhooks). Each delivery is:
//   1. verified: HMAC-SHA256 of "<event id>.<timestamp>.<raw body>" with
//      the provider's secret, compared in constant time, and a timestamp at
//      most 5 minutes from now: a captured delivery can be neither replayed
//      later nor sent again under another event id — else 400
//      invalid_signature;
//   2. deduplicated: its event id is claimed in idempotency_keys (scope
//      webhook:<name>), so a provider's retry answers
//      200 {received:true, duplicate:true} and does nothing more;
//   3. queued, not processed: job webhook.<name>.<type> with
//      {provider, eventId, type, data, receivedAt}, in the transaction of
//      the claim; the answer is 200 {received:true} at once and the job
//      runner does the work, with retries (docs/06 S7). A provider is added
//      with its handlers in src/job-handlers.js; until then its jobs fail
//      visibly (A01 «مهام خلفية فشلت»).
// The default parse() reads the headers X-Webhook-Id, X-Webhook-Timestamp
// (Unix seconds) and X-Webhook-Signature (hex, "sha256=" allowed) and a
// JSON body {type, data}; a real provider passes its own.

const crypto = require('crypto');
const express = require('express');
const { badRequest, notFound } = require('./errors');
const { withIdempotency } = require('./idempotency');
const jobs = require('./jobs');

const TOLERANCE_SEC = 300;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

const sign = (secret, eventId, timestamp, rawBody) =>
  crypto.createHmac('sha256', secret).update(`${eventId}.${timestamp}.${rawBody}`).digest('hex');

function verifySignature({ secret, eventId, rawBody, signatureHex, timestamp, toleranceSec = TOLERANCE_SEC, now = Date.now() }) {
  if (!secret || !eventId || typeof eventId !== 'string' || typeof rawBody !== 'string' || typeof signatureHex !== 'string') return false;
  const ts = typeof timestamp === 'number' ? timestamp : /^\d{1,12}$/.test(String(timestamp || '')) ? Number(timestamp) : NaN;
  if (!Number.isSafeInteger(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const hex = signatureHex.replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(sign(secret, eventId, ts, rawBody), 'hex'));
}

function parseDefault(rawBody, headers) {
  let body;
  try { body = JSON.parse(rawBody); } catch (_) { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return {
    eventId: headers['x-webhook-id'],
    timestamp: headers['x-webhook-timestamp'],
    signature: headers['x-webhook-signature'],
    type: body.type,
    data: body.data === undefined ? null : body.data,
  };
}

// The handler of one provider: raw body (the signature covers its bytes),
// no session, no CSRF header (the provider is no browser).
function webhookRoute({ provider, secret, parse = parseDefault, toleranceSec = TOLERANCE_SEC }) {
  const router = express.Router();
  router.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = parse(rawBody, req.headers);
    if (!event || typeof event.eventId !== 'string' || !EVENT_ID_RE.test(event.eventId)
        || typeof event.type !== 'string' || !TYPE_RE.test(event.type)) {
      throw badRequest('invalid_webhook', 'The delivery has no readable event id or type');
    }
    if (!verifySignature({ secret, eventId: event.eventId, rawBody, signatureHex: event.signature, timestamp: event.timestamp, toleranceSec })) {
      throw badRequest('invalid_signature', 'Bad signature or timestamp outside the replay window');
    }
    const { db } = req.app.locals;
    const out = await db.withContext({ system: true }, (client) => withIdempotency(
      client, { scope: `webhook:${provider}`, key: event.eventId },
      async () => {
        await jobs.enqueue(client, `webhook.${provider}.${event.type}`, {
          provider, eventId: event.eventId, type: event.type, data: event.data, receivedAt: new Date().toISOString(),
        });
        return { status: 200, body: { received: true } };
      }));
    res.status(200).json(out.replayed ? { received: true, duplicate: true } : out.body);
  });
  return router;
}

// /api/webhooks/<name> for every configured provider; any other name 404.
function webhooksRouter(config) {
  const router = express.Router();
  for (const [provider, secret] of Object.entries(config.webhooks || {})) {
    if (PROVIDER_RE.test(provider) && secret) router.use(`/${provider}`, webhookRoute({ provider, secret }));
  }
  router.use(() => { throw notFound('not_found', 'Not found'); });
  return router;
}

module.exports = { verifySignature, sign, webhookRoute, webhooksRouter, parseDefault, TOLERANCE_SEC };
