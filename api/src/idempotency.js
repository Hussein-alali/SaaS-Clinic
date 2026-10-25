'use strict';
// Idempotency-Key for requests that must not run twice (docs/06 S4): a
// quick payment clicked twice, or sent again after a timeout whose answer
// was lost. The key is claimed in the same transaction as the work, so
// either both commit (a repeat gets the stored answer) or neither does (a
// repeat runs the work). A second request with the key while the first is
// still running waits for it on the primary key, then gets its answer.
// Rows older than a day are removed by the maintenance job (docs/06 S7).

const { badRequest, HttpError } = require('./errors');

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// The request's Idempotency-Key, null without one; 400 when malformed.
function idempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return null;
  if (!KEY_RE.test(key)) {
    throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8 to 100 letters, digits, "_" or "-"');
  }
  return key;
}

// Inside the request's transaction: the stored answer of an earlier
// request with this key (same user and clinic), or run() and its answer
// stored. run() resolves to { status, body }.
async function withIdempotency(client, { scope, key, orgId, userId }, run) {
  const claimed = await client.query(
    `insert into public.idempotency_keys (scope, key, organization_id, user_id) values ($1, $2, $3, $4)
     on conflict (scope, key) do nothing`, [scope, key, orgId || null, userId || null]);
  if (!claimed.rowCount) {
    const { rows: [prev] } = await client.query(
      'select organization_id, user_id, status, response from public.idempotency_keys where scope = $1 and key = $2',
      [scope, key]);
    if (!prev || prev.user_id !== (userId || null) || prev.organization_id !== (orgId || null)) {
      throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key belongs to another request');
    }
    return { status: prev.status, body: prev.response, replayed: true };
  }
  const { status, body } = await run();
  await client.query('update public.idempotency_keys set status = $3, response = $4::jsonb where scope = $1 and key = $2',
    [scope, key, status, JSON.stringify(body === undefined ? null : body)]);
  return { status, body, replayed: false };
}

module.exports = { idempotencyKey, withIdempotency, KEY_RE };
