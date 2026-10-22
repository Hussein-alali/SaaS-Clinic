'use strict';
// Error shape for every /api response: { error: { message, code } }
// (docs/02-TRD.md "API contract").

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const badRequest = (code, message) => new HttpError(400, code, message);
const unauthorized = (code = 'unauthorized', message = 'Authentication required') => new HttpError(401, code, message);
const forbidden = (code = 'forbidden', message = 'Forbidden') => new HttpError(403, code, message);
const notFound = (code = 'not_found', message = 'Not found') => new HttpError(404, code, message);

// SQLSTATE classes that describe a server/infrastructure problem rather than
// a bad request; their messages can reveal internals, so they become 500/503.
const SERVER_CLASSES = new Set(['08', '53', '57', '58', 'F0', 'HV', 'XX']);

function isPgError(err) {
  return !!(err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && typeof err.severity === 'string');
}

// Maps a PostgreSQL error to [status, body]. Only message + SQLSTATE leave
// the server (no detail/hint/where/query text).
function mapPgError(err) {
  const code = err.code;
  const message = String(err.message || 'Database error');
  if (code === '23505') return [409, { message, code }];
  if (code === '42501' || /row-level security/i.test(message)) return [403, { message, code }];
  if (code === 'PL422') return [422, { message, code }];
  if (code === '57014') return [503, { message: 'Query took too long and was cancelled', code }];
  if (SERVER_CLASSES.has(code.slice(0, 2))) return [500, { message: 'Database error', code }];
  return [400, { message, code }];
}

function sendError(res, status, code, message) {
  if (res.headersSent) return;
  res.status(status).json({ error: { message, code } });
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, isPgError, mapPgError, sendError };
