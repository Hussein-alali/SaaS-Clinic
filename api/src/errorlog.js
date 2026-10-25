'use strict';
// Error tracking inside the database (docs/06 S6, 0012_error_log): the
// API's 5xx and unhandled errors and the browser's reports are grouped by
// fingerprint in error_groups, with at most one sample per group a minute
// in error_events. Text is scrubbed first: e-mails, phone numbers and long
// digit runs, query strings (NFR-012: no health data). recordError()
// never throws: tracking an error must not cause another.

const crypto = require('crypto');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 8+ digits, optionally with +, spaces or dashes: phones, national ids, file
// numbers. A stack's line:column (app.js:120:33) is left alone.
const NUMBER_RE = /\+?\d[\d -]{6,}\d/g;
const QUERY_RE = /\?[^\s'"()<>]*/g;
const MAX = { message: 500, stack: 4096, route: 200, method: 10, code: 50, release: 100, userAgent: 300 };

function scrub(text, max) {
  if (text === undefined || text === null) return null;
  const s = String(text).replace(EMAIL_RE, '[email]').replace(QUERY_RE, '').replace(NUMBER_RE, '[number]');
  return s.length > max ? s.slice(0, max) : s;
}

// Same error, same group: digits and ids are normalized away, and so is the
// content hash of a bundle file name (app.<hash>.js), which changes per release.
function fingerprint(source, message, stack) {
  const norm = (s) => String(s || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\.[0-9a-f]{8,}\.js/g, '.js')
    .replace(/\d+/g, '#');
  const frame = String(stack || '').split('\n').map((l) => l.trim()).find((l) => /^at |@/.test(l)) || '';
  return crypto.createHash('sha256').update(`${source}\n${norm(message)}\n${norm(frame)}`).digest('hex');
}

// { source: 'api'|'client', message, stack, route, method, status, code,
//   orgId, userId, release, userAgent } → true when stored, false otherwise.
async function recordError(db, e = {}) {
  try {
    const source = e.source === 'client' ? 'client' : 'api';
    const message = scrub(e.message || 'Error', MAX.message) || 'Error';
    const stack = scrub(e.stack, MAX.stack);
    const route = scrub(e.route, MAX.route);
    const fp = fingerprint(source, message, stack);
    const status = Number.isInteger(e.status) ? e.status : null;
    const code = scrub(e.code, MAX.code);
    const release = scrub(e.release, MAX.release);
    const { rows } = await db.query(
      `insert into public.error_groups as g (fingerprint, source, message, route, status, code, last_release, last_event_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (fingerprint) do update set
         count = g.count + 1, last_seen = now(), message = excluded.message,
         route = coalesce(excluded.route, g.route), status = coalesce(excluded.status, g.status),
         code = coalesce(excluded.code, g.code), last_release = coalesce(excluded.last_release, g.last_release),
         resolved_at = null,
         last_event_at = case when g.last_event_at is null or g.last_event_at < now() - interval '1 minute'
                              then now() else g.last_event_at end
       returning last_event_at = now() as sample`,
      [fp, source, message, route, status, code, release]);
    if (rows[0] && rows[0].sample) {
      await db.query(
        `insert into public.error_events (fingerprint, message, stack, route, method, status, code, organization_id, user_id, release, user_agent)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [fp, message, stack, route, scrub(e.method, MAX.method), status, code,
          e.orgId || null, e.userId || null, release, scrub(e.userAgent, MAX.userAgent)]);
    }
    return true;
  } catch (err) {
    console.error('[api] could not record an error:', err && err.message);
    return false;
  }
}

// The request's side of an API error (route pattern, never the URL with ids).
function fromRequest(req, err, status) {
  const routePath = req.route && req.route.path;
  const base = req.mountPath || req.baseUrl || '';
  const route = routePath ? `${base}${routePath === '/' ? '' : routePath}` : (req.originalUrl || req.url || '').split('?')[0];
  return {
    source: 'api',
    message: (err && err.message) || String(err),
    stack: err && err.stack,
    route,
    method: req.method,
    status,
    code: err && typeof err.code === 'string' ? err.code : null,
    orgId: (req.ctx && req.ctx.orgId) || null,
    userId: (req.user && req.user.id) || (req.ctx && req.ctx.userId) || null,
    release: req.app && req.app.locals.config && req.app.locals.config.release,
    userAgent: req.get && req.get('user-agent'),
  };
}

module.exports = { scrub, fingerprint, recordError, fromRequest, MAX };
