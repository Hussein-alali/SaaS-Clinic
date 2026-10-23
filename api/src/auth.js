'use strict';
// Sessions (docs/02-TRD.md "Authentication and roles"):
//   - accounts in auth.users, bcrypt (cost 10) via bcryptjs;
//   - JWT HS256 {sub, sv} in the httpOnly cookie cs_session, 12 h or 30 days
//     ("remember me");
//   - every authenticated request reloads the user and rejects a disabled
//     account or a session_version that no longer matches the token.
// Roles are never taken from the JWT: tenant.js reads them per request.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { HttpError, badRequest, unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'cs_session';
const SHORT_TTL_S = 12 * 60 * 60;
const LONG_TTL_S = 30 * 24 * 60 * 60;
const BCRYPT_COST = 10;
const PASSWORD_MIN = 6; // same rule as the frontend and the old Edge Functions
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Passwords ─────────────────────────────────────────────────────────────

/** Throws 400 weak_password unless 6+ characters and at most 72 UTF-8 bytes. */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw badRequest('weak_password', `Password must be at least ${PASSWORD_MIN} characters`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw badRequest('weak_password', `Password must be at most ${PASSWORD_MAX_BYTES} bytes`);
  }
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

let dummyHash = null;
/** bcrypt compare that costs the same when the account has no hash. */
async function verifyPassword(password, hash) {
  if (typeof hash === 'string' && hash.startsWith('$2')) {
    try {
      return await bcrypt.compare(password, hash);
    } catch (_) {
      return false;
    }
  }
  if (!dummyHash) dummyHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);
  await bcrypt.compare(password, dummyHash);
  return false;
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ── Failure rate limiting (in memory, per process) ─────────────────────────

/** Sliding window: `max` failures per key within `windowMs` block the key. */
class FailureLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000, maxKeys = 50000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  recent(key, now) {
    const list = this.hits.get(key);
    if (!list) return [];
    const fresh = list.filter((t) => now - t < this.windowMs);
    if (fresh.length) this.hits.set(key, fresh);
    else this.hits.delete(key);
    return fresh;
  }

  /** Seconds until the key is allowed again, or 0 when it is not blocked. */
  retryAfter(key, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.max] + this.windowMs - now) / 1000));
  }

  fail(key, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(now);
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune(now = Date.now()) {
    for (const [key, list] of this.hits) {
      if (now - list[list.length - 1] >= this.windowMs) this.hits.delete(key);
    }
    // Still too many keys: drop the oldest entries (Map keeps insertion order).
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/** Client address (Express "trust proxy" applied), or null when unknown
 *  (e.g. a proxy talking over a Unix socket): callers then skip per-IP
 *  limits instead of putting every client in one shared bucket. */
const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || null;

// ── Cookie + JWT ──────────────────────────────────────────────────────────

function cookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!config.cookieSecure,
    domain: config.cookieDomain || undefined,
    path: '/',
  };
}

/** Signs {sub, sv} and sets cs_session (12 h, or 30 days with remember). */
function issueSession(res, config, user, remember) {
  const ttl = remember ? LONG_TTL_S : SHORT_TTL_S;
  const token = jwt.sign({ sub: user.id, sv: user.session_version }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: ttl,
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), maxAge: ttl * 1000 });
  return token;
}

function clearSession(res, config) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

const userName = (row) => {
  const meta = row.raw_user_meta_data || {};
  return typeof meta.name === 'string' ? meta.name : typeof meta.full_name === 'string' ? meta.full_name : null;
};

const publicUser = (row) => ({ id: row.id, email: row.email, name: userName(row) });

/**
 * Loads req.user from the cookie (once per request). Returns the user or
 * null; sets req.authError when a cookie was present but is not valid.
 */
async function loadUser(req, res) {
  if (req.user !== undefined) return req.user;
  req.user = null;
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { config, db } = req.app.locals;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_) {
    req.authError = 'invalid_session';
    clearSession(res, config);
    return null;
  }
  if (!payload || typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub) || !Number.isInteger(payload.sv)) {
    req.authError = 'invalid_session';
    clearSession(res, config);
    return null;
  }
  const { rows } = await db.query(
    'select id, email, status, session_version, raw_user_meta_data from auth.users where id = $1',
    [payload.sub],
  );
  const row = rows[0];
  if (!row || row.status !== 'active' || row.session_version !== payload.sv) {
    req.authError = 'session_revoked';
    clearSession(res, config);
    return null;
  }
  req.user = {
    ...publicUser(row),
    sessionVersion: row.session_version,
    remember: typeof payload.exp === 'number' && typeof payload.iat === 'number' && payload.exp - payload.iat > SHORT_TTL_S,
  };
  return req.user;
}

/** Middleware: 401 unless the request carries a valid, current session. */
async function requireSession(req, res, next) {
  const user = await loadUser(req, res);
  if (!user) {
    throw unauthorized(req.authError || 'unauthorized', req.authError ? 'Session expired, please sign in again' : 'Authentication required');
  }
  next();
}

async function isSuperAdmin(db, userId) {
  const { rowCount } = await db.query('select 1 from platform_admins where user_id = $1', [userId]);
  return rowCount > 0;
}

/** Middleware: valid session + a row in platform_admins (Super Admin). */
async function requireSuperAdmin(req, res, next) {
  const user = await loadUser(req, res);
  if (!user) throw unauthorized(req.authError || 'unauthorized', 'Authentication required');
  if (!(await isSuperAdmin(req.app.locals.db, user.id))) throw forbidden('not_super_admin', 'Super Admin only');
  req.isSuperAdmin = true;
  next();
}

/**
 * Login/session response:
 *   {user:{id,email,name}, is_super_admin,
 *    memberships:[{organization_id, slug, name, role, status, specialty_code}]}
 * Memberships are the active ones in active organizations.
 */
async function sessionPayload(db, user) {
  const [superAdmin, members] = await Promise.all([
    isSuperAdmin(db, user.id),
    db.query(
      `select o.id as organization_id, o.slug, o.name, m.role, m.status, s.code as specialty_code
         from organization_members m
         join organizations o on o.id = m.organization_id
         left join specialties s on s.id = o.primary_specialty_id
        where m.user_id = $1 and m.status = 'active' and o.status = 'active'
        order by o.name, o.slug`,
      [user.id],
    ),
  ]);
  return {
    user: { id: user.id, email: user.email, name: user.name },
    is_super_admin: superAdmin,
    memberships: members.rows,
  };
}

function tooManyAttempts(res, seconds) {
  res.set('Retry-After', String(seconds));
  return new HttpError(429, 'too_many_attempts', 'Too many attempts, try again later');
}

module.exports = {
  SESSION_COOKIE,
  SHORT_TTL_S,
  LONG_TTL_S,
  UUID_RE,
  FailureLimiter,
  clientIp,
  validatePassword,
  hashPassword,
  verifyPassword,
  sha256,
  issueSession,
  clearSession,
  cookieOptions,
  publicUser,
  loadUser,
  requireSession,
  requireSuperAdmin,
  isSuperAdmin,
  sessionPayload,
  tooManyAttempts,
};
