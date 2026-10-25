'use strict';
// Rate limits shared by every API process (docs/06 S5, 0011_rate_limits):
// Passenger runs several Node processes, so the counters live in
// PostgreSQL, one row per (bucket, sha256 of the key, fixed window). The
// key (an e-mail, an IP, a user id) is never stored.
//
//   hit(db, bucket, key, n = 1)  counts n and answers {allowed, count, retryAfterSec}
//   peek(db, bucket, key)         {blocked, count, retryAfterSec} without counting
//                                 (limits that count failures only: check first,
//                                 hit() on a failure, clear() on a success)
//   enforce(db, res, bucket, key) hit(), and 429 rate_limited when over the limit
//   throttle(limitPerMin)         per-process cap of requests per session or IP a
//                                 minute: a runaway screen loop, not an attack
//
// 429 answers carry Retry-After and {error: {code, message, retry_after}}.

const crypto = require('crypto');
const { HttpError } = require('./errors');

const MINUTE = 60;
const LIMITS = {
  login_email:      { limit: 10, windowSec: 15 * MINUTE },   // failures
  login_ip:         { limit: 50, windowSec: 15 * MINUTE },   // failures
  reset_email:      { limit: 3, windowSec: 60 * MINUTE },    // e-mails sent (silently dropped above)
  reset_ip:         { limit: 20, windowSec: 60 * MINUTE },
  invite_email:     { limit: 5, windowSec: 24 * 60 * MINUTE }, // create + resend to one address
  invite_org:       { limit: 200, windowSec: 24 * 60 * MINUTE },
  invitation_ip:    { limit: 30, windowSec: 10 * MINUTE },   // unknown or unusable tokens
  upload_user:      { limit: 120, windowSec: 60 * MINUTE },
  client_error_ip:  { limit: 30, windowSec: MINUTE },
};

// RATE_LIMIT_NOW (milliseconds) moves the clock in tests; ignored in production.
function nowMs() {
  const fake = Number(process.env.RATE_LIMIT_NOW);
  return process.env.NODE_ENV !== 'production' && fake > 0 ? fake : Date.now();
}

const keyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

function windowOf(bucket) {
  const spec = LIMITS[bucket];
  if (!spec) throw new Error(`unknown rate-limit bucket ${bucket}`);
  const t = Math.floor(nowMs() / 1000);
  const start = t - (t % spec.windowSec);
  return { ...spec, start, retryAfterSec: Math.max(1, start + spec.windowSec - t) };
}

async function hit(db, bucket, key, n = 1) {
  const w = windowOf(bucket);
  const { rows } = await db.query(
    `insert into public.rate_limits (bucket, key_hash, window_start, count) values ($1, $2, to_timestamp($3), $4)
     on conflict (bucket, key_hash, window_start) do update set count = public.rate_limits.count + excluded.count
     returning count`,
    [bucket, keyHash(key), w.start, n]);
  const count = rows[0].count;
  return { allowed: count <= w.limit, count, retryAfterSec: w.retryAfterSec };
}

async function peek(db, bucket, key) {
  const w = windowOf(bucket);
  const { rows } = await db.query(
    'select count from public.rate_limits where bucket = $1 and key_hash = $2 and window_start = to_timestamp($3)',
    [bucket, keyHash(key), w.start]);
  const count = rows.length ? rows[0].count : 0;
  return { blocked: count >= w.limit, count, retryAfterSec: w.retryAfterSec };
}

async function clear(db, bucket, key) {
  await db.query('delete from public.rate_limits where bucket = $1 and key_hash = $2', [bucket, keyHash(key)]);
}

function rateLimited(res, seconds) {
  res.set('Retry-After', String(seconds));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new HttpError(429, 'rate_limited', `Too many requests, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
    { retry_after: seconds });
}

async function enforce(db, res, bucket, key) {
  const r = await hit(db, bucket, key);
  if (!r.allowed) throw rateLimited(res, r.retryAfterSec);
  return r;
}

// Per process and in memory on purpose: it runs before every /api request
// and must cost nothing. Keyed by the session cookie, else the IP.
function throttle(limitPerMin) {
  const counts = new Map();
  let windowStart = 0;
  return (req, res, next) => {
    if (!(limitPerMin > 0)) return next();
    const t = Math.floor(Date.now() / 1000); // real time, even in tests
    const start = t - (t % MINUTE);
    if (start !== windowStart) { counts.clear(); windowStart = start; }
    const cookie = req.cookies && req.cookies.cs_session;
    const key = cookie ? `s:${keyHash(cookie)}` : `ip:${req.ip}`;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > limitPerMin) return next(rateLimited(res, Math.max(1, start + MINUTE - t)));
    next();
  };
}

module.exports = { LIMITS, hit, peek, clear, enforce, rateLimited, throttle, keyHash };
