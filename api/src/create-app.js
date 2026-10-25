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
const errorlog = require('./errorlog');
const { webhooksRouter } = require('./webhooks');
require('./job-handlers'); // the kinds of background job (docs/06 S7)

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

// A 5xx is a bug or an outage: it goes to the error list (docs/06 S6),
// after the response, and never fails the request a second time.
function track(req, err, status) {
  const { db } = req.app.locals;
  if (db) req.app.locals.background(() => errorlog.recordError(db, errorlog.fromRequest(req, err, status)));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    if (err && err.code !== 'ECONNABORTED' && err.code !== 'ECONNRESET') console.error('[api] error after headers sent:', err.message);
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) track(req, err, err.status);
    return sendError(res, err.status, err.code, err.message, err.extra);
  }
  if (isPgError(err)) {
    const [status, body] = mapPgError(err);
    if (status >= 500) {
      console.error(`[api] database error ${err.code}: ${err.message}`);
      track(req, err, status);
    }
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
  track(req, err, 500);
  return sendError(res, 500, 'internal_error', 'Internal server error');
}

// Every e-mail sent or failed is counted in mail_log (kind, ok; never the
// address): the SMTP hourly/daily limits are watched from it (docs/06 S8).
function countSends(mailer, db) {
  return {
    ...mailer,
    async send(message) {
      let ok = false;
      try {
        const result = await mailer.send(message);
        ok = true;
        return result;
      } finally {
        await db.query('insert into public.mail_log (kind, ok) values ($1, $2)', [(message && message.kind) || null, ok])
          .catch((err) => console.error('[api] mail_log not written:', err.message));
      }
    },
  };
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
  const mailer = countSends(deps.mailer || createMailer(config), db);
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
  // Signed by the provider (no browser, no session) and read raw for the
  // signature: before the CSRF check, the throttle and the JSON parser (docs/06 S10).
  api.use('/webhooks', (req, res, next) => { req.mountPath = req.baseUrl; next(); }, webhooksRouter(config));
  api.use(requireCsrfHeader);
  api.use(cookieParser());
  // A runaway screen loop must not flood the database (docs/06 S5).
  api.use(throttle(config.apiRatePerMin));
  api.use(express.json({ limit: '10mb' }));
  // req.mountPath: where the route module sits (/api/rpc...), for the error
  // list's route pattern (req.baseUrl is gone by the time errorHandler runs).
  const mount = (path, router) => api.use(path, (req, res, next) => { req.mountPath = req.baseUrl; next(); }, router);
  mount('/auth', require('./routes/auth'));
  mount('/orgs', require('./routes/orgs'));
  mount('/data', require('./routes/data'));
  mount('/rpc', require('./routes/rpc'));
  mount('/files', require('./routes/files'));
  mount('/admin', require('./routes/admin'));
  mount('/org', require('./routes/org'));
  mount('/invitations', require('./routes/invitations'));
  mount('/client-errors', require('./routes/client-errors'));
  mount('/platform', require('./routes/platform'));
  api.use((req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use('/api', api);

  app.use(staticHandlers(config));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, errorHandler, requireCsrfHeader, CSRF_HEADER_VALUE };
