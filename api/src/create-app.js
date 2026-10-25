'use strict';
// Builds the Express application: security headers, /api/* (CSRF header,
// cookies, JSON), the route modules, the static dist/ build and a single
// error handler that answers {error:{message, code}}.

const express = require('express');
const cookieParser = require('cookie-parser');
const { createDb } = require('./db');
const { createMailer } = require('./mailer');
const { TableCatalog, FunctionCatalog } = require('./catalog');
const { HttpError, isPgError, mapPgError, sendError } = require('./errors');
const { staticHandlers } = require('./static');
const { throttle } = require('./ratelimit');

const CSRF_HEADER_VALUE = 'clinicsys';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function securityHeaders(config) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

/** Every state-changing /api request must carry X-Requested-With: clinicsys. */
function requireCsrfHeader(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('x-requested-with') !== CSRF_HEADER_VALUE) {
    return sendError(res, 403, 'csrf_header_required', 'Missing X-Requested-With header');
  }
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    if (err && err.code !== 'ECONNABORTED' && err.code !== 'ECONNRESET') console.error('[api] error after headers sent:', err.message);
    return;
  }
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.extra);
  if (isPgError(err)) {
    const [status, body] = mapPgError(err);
    if (status >= 500) console.error(`[api] database error ${err.code}: ${err.message}`);
    return res.status(status).json({ error: body });
  }
  if (err && err.type === 'entity.parse.failed') return sendError(res, 400, 'invalid_json', 'Malformed JSON body');
  if (err && err.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large', 'Request body too large');
  if (err && err.type && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return sendError(res, err.status, 'invalid_request', 'Invalid request body');
  }
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET')) return undefined;
  // No request data in logs (NFR-012): message and stack only.
  console.error('[api] unhandled error:', err && (err.stack || err.message || err));
  return sendError(res, 500, 'internal_error', 'Internal server error');
}

/**
 * createApp(config, {db, mailer}) → Express app.
 * app.locals: config, db, mailer, catalog, functions, background(fn),
 *             drain(), close(). Rate limits: src/ratelimit.js (PostgreSQL).
 */
function createApp(config, deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  const db = deps.db || createDb(config);
  const mailer = deps.mailer || createMailer(config);
  const pending = new Set();

  Object.assign(app.locals, {
    config,
    db,
    mailer,
    catalog: new TableCatalog(db),
    functions: new FunctionCatalog(db),
    /** Runs fn after the response (e-mails); errors are logged, never thrown. */
    background(fn) {
      const p = Promise.resolve()
        .then(fn)
        .catch((err) => console.error('[api] background task failed:', err && err.message))
        .finally(() => pending.delete(p));
      pending.add(p);
      return p;
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    async close() {
      await app.locals.drain();
      await db.close();
    },
  });

  app.use(securityHeaders(config));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Before the CSRF check and the session: deploys and monitoring call it bare.
  api.use('/health', require('./routes/health'));
  api.use(requireCsrfHeader);
  api.use(cookieParser());
  // A runaway screen loop must not flood the database (docs/06 S5).
  api.use(throttle(config.apiRatePerMin));
  api.use(express.json({ limit: '10mb' }));
  api.use('/auth', require('./routes/auth'));
  api.use('/orgs', require('./routes/orgs'));
  api.use('/data', require('./routes/data'));
  api.use('/rpc', require('./routes/rpc'));
  api.use('/files', require('./routes/files'));
  api.use('/admin', require('./routes/admin'));
  api.use('/org', require('./routes/org'));
  api.use('/invitations', require('./routes/invitations'));
  api.use('/platform', require('./routes/platform'));
  api.use((req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use('/api', api);

  app.use(staticHandlers(config));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, errorHandler, requireCsrfHeader, CSRF_HEADER_VALUE };
