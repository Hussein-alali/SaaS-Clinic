'use strict';
// /api/auth/* (docs/02-TRD.md "المصادقة والجلسة").

const express = require('express');
const { badRequest, unauthorized } = require('../errors');
const auth = require('../auth');
const ratelimit = require('../ratelimit');
const jobs = require('../jobs');
const passwordReset = require('../password-reset');
const { isValidEmail, requestLang } = require('../mailer');

const router = express.Router();

const INVALID_LOGIN = 'Invalid login credentials';

const str = (v) => (typeof v === 'string' ? v : '');

router.post('/login', async (req, res) => {
  const { config, db } = req.app.locals;
  const body = req.body || {};
  const email = str(body.email).trim();
  const password = str(body.password);
  if (!email || !password || email.length > 254 || password.length > 1024) {
    throw badRequest('invalid_request', 'Email and password are required');
  }
  const ip = auth.clientIp(req);
  const keys = [['login_email', email.toLowerCase()]];
  if (ip) keys.push(['login_ip', ip]);
  await auth.refuseBlocked(db, res, keys);

  const { rows } = await db.query(
    `select id, email, encrypted_password, status, session_version, raw_user_meta_data
       from auth.users where lower(email) = lower($1)`,
    [email],
  );
  const row = rows[0];
  const ok = await auth.verifyPassword(password, row && row.encrypted_password);
  if (!row || !ok || row.status !== 'active') {
    await Promise.all(keys.map(([bucket, key]) => ratelimit.hit(db, bucket, key)));
    throw unauthorized('invalid_credentials', INVALID_LOGIN); // one message for every failure
  }
  await ratelimit.clear(db, ...keys[0]); // the e-mail counter; the IP counter keeps counting
  await db.query('update auth.users set last_sign_in_at = now() where id = $1', [row.id]);
  auth.issueSession(res, config, row, body.remember === true);
  res.json(await auth.sessionPayload(db, auth.publicUser(row)));
});

router.post('/logout', (req, res) => {
  auth.clearSession(res, req.app.locals.config);
  res.status(204).end();
});

router.get('/session', auth.requireSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await auth.sessionPayload(req.app.locals.db, req.user));
});

router.post('/password', auth.requireSession, async (req, res) => {
  const { config, db } = req.app.locals;
  const password = (req.body || {}).password;
  auth.validatePassword(password);
  const hash = await auth.hashPassword(password);
  const row = await db.withContext({}, async (client) => {
    const { rows } = await client.query(
      `update auth.users
          set encrypted_password = $2, session_version = session_version + 1, updated_at = now()
        where id = $1 and status = 'active'
        returning id, email, session_version, raw_user_meta_data`,
      [req.user.id, hash],
    );
    if (rows[0]) {
      await client.query('update auth.password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [req.user.id]);
    }
    return rows[0];
  });
  if (!row) throw unauthorized('session_revoked', 'Session expired, please sign in again');
  // Every other session is now invalid; this one continues with the new version.
  auth.issueSession(res, config, row, req.user.remember);
  res.status(204).end();
});

router.patch('/profile', auth.requireSession, async (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name || name.length > 120) throw badRequest('invalid_name', 'Name must be 1-120 characters');
  const { rows } = await req.app.locals.db.query(
    `update auth.users
        set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', $2::text),
            updated_at = now()
      where id = $1
      returning id, email, raw_user_meta_data`,
    [req.user.id, name],
  );
  res.json({ user: auth.publicUser(rows[0]) });
});

// lang: the requester's interface language (X-Lang), first in the e-mail.
// An e-mail that fails is sent again (new link) by a job (docs/06 S7).
async function sendResetEmail(app, email, lang) {
  const { db } = app.locals;
  const { rows } = await db.query("select id, email from auth.users where lower(email) = lower($1) and status = 'active'", [email]);
  const user = rows[0];
  if (!user) return;
  // At most 3 reset e-mails per account an hour (the rest are dropped silently).
  if (!(await ratelimit.hit(db, 'reset_email', user.id)).allowed) return;
  try {
    await passwordReset.sendResetLink(app.locals, db, user, lang);
  } catch (err) {
    console.error('[api] password-reset e-mail failed:', err && err.message);
    await jobs.enqueue(db, 'email.password_reset', { userId: user.id, lang },
      { runAt: new Date(Date.now() + 60e3), dedupeKey: `email.password_reset:${user.id}` });
  }
}

router.post('/reset/request', async (req, res) => {
  const email = str((req.body || {}).email).trim();
  const ip = auth.clientIp(req);
  if (ip) await ratelimit.enforce(req.app.locals.db, res, 'reset_ip', ip);
  // 204 always (contract), whether or not the address is valid or has an
  // account; the lookup and the e-mail happen after the response, so the
  // timing does not tell either.
  const lang = requestLang(req);
  if (isValidEmail(email)) req.app.locals.background(() => sendResetEmail(req.app, email, lang));
  res.status(204).end();
});

router.post('/reset/confirm', async (req, res) => {
  const { db } = req.app.locals;
  const body = req.body || {};
  const token = str(body.token);
  if (token.length < 20 || token.length > 200) throw badRequest('invalid_token', 'Reset link is invalid or has expired');
  auth.validatePassword(body.password);
  const hash = await auth.hashPassword(body.password);
  await db.withContext({}, async (client) => {
    const { rows } = await client.query(
      `update auth.password_reset_tokens set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning user_id`,
      [auth.sha256(token)],
    );
    if (!rows[0]) throw badRequest('invalid_token', 'Reset link is invalid or has expired');
    const userId = rows[0].user_id;
    await client.query(
      `update auth.users
          set encrypted_password = $2, session_version = session_version + 1, updated_at = now()
        where id = $1`,
      [userId, hash],
    );
    await client.query('update auth.password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [userId]);
  });
  res.status(204).end();
});

module.exports = router;
