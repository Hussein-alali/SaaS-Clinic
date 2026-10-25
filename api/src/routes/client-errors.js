'use strict';
// POST /api/client-errors {message, stack, route, component} → 204
// (docs/06 S6): the browser's uncaught errors and React render errors
// (src/errors.jsx). No session needed (the login screen can fail too); the
// account and clinic are attached when the request has them. At most 8 KB,
// 30 a minute per IP; stored scrubbed by api/src/errorlog.js.

const express = require('express');
const auth = require('../auth');
const { HttpError, badRequest } = require('../errors');
const errorlog = require('../errorlog');
const ratelimit = require('../ratelimit');
const { isPlainObject } = require('../data-query');

const router = express.Router();
const MAX_BODY = 8 * 1024;
const text = (v) => (typeof v === 'string' ? v : null);

router.post('/', async (req, res) => {
  const { db, config } = req.app.locals;
  if (!isPlainObject(req.body)) throw badRequest('invalid_request', 'Body must be a JSON object');
  if (JSON.stringify(req.body).length > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Error report too large');
  const ip = auth.clientIp(req);
  if (ip) await ratelimit.enforce(db, res, 'client_error_ip', ip);

  const user = await auth.loadUser(req, res);
  let orgId = null;
  const slug = req.get('x-org-slug');
  if (user && slug && /^[a-z0-9-]{1,63}$/.test(slug)) {
    const { rows } = await db.query(
      `select o.id from public.organizations o join public.organization_members m on m.organization_id = o.id
        where o.slug = $1 and m.user_id = $2`, [slug, user.id]);
    orgId = rows[0] ? rows[0].id : null;
  }
  const b = req.body;
  const component = text(b.component);
  await errorlog.recordError(db, {
    source: 'client',
    message: text(b.message) || 'Error',
    stack: [text(b.stack), component && `component:${component}`].filter(Boolean).join('\n') || null,
    route: text(b.route),
    orgId,
    userId: user ? user.id : null,
    release: text(b.release) || config.release,
    userAgent: req.get('user-agent'),
  });
  res.status(204).end();
});

module.exports = router;
