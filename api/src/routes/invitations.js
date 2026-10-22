'use strict';
// /api/invitations/:token — public view/accept of an invitation
// (docs/02-TRD.md "الدعوات (عام)", docs/05 "Authentication flow" step 2).
//
//   GET  /api/invitations/:token          → {organization:{name, slug}, email, role, status,
//                                            expires_at, account_exists}
//   POST /api/invitations/:token/accept   {password, name} → login payload + cookie
//
// 404 unknown token, 410 used / expired / revoked, 403 org_inactive when
// the clinic is not active or waiting for activation.
// Accepting: a new e-mail gets an account with this password; an e-mail
// that already has an account must give THAT account's password (it is
// never overwritten; failures count like failed logins). Then the
// membership becomes active with the invitation's role and branches, the
// staff row is created or linked, the invitation is 'accepted', the first
// admin moves a pending_activation clinic to active, and the user is
// signed in. One transaction (system context: the clinic is not yet the
// user's), audited.

const express = require('express');
const auth = require('../auth');
const { HttpError, badRequest, notFound, forbidden } = require('../errors');
const { writeAudit } = require('../audit');
const members = require('../members');
const invites = require('../invites');

const router = express.Router();

const USABLE_ORG_STATUSES = ['pending_activation', 'active'];

function gone(status) {
  if (status === 'accepted') return new HttpError(410, 'invitation_used', 'This invitation has already been used');
  if (status === 'revoked') return new HttpError(410, 'invitation_revoked', 'This invitation was cancelled');
  return new HttpError(410, 'invitation_expired', 'This invitation has expired');
}

/** Invitation + its clinic by token (optionally locked), or null. */
async function findByToken(client, token, { lock = false } = {}) {
  if (!invites.isTokenShaped(token)) return null;
  const { rows } = await client.query(
    `select i.*, o.name as org_name, o.slug as org_slug, o.status as org_status
       from public.invitations i
       join public.organizations o on o.id = i.organization_id
      where i.token_hash = $1
      ${lock ? 'for update of i' : ''}`,
    [auth.sha256(token)],
  );
  return rows[0] || null;
}

/** 404 / 410 / 403 unless the invitation can be accepted now. */
function assertUsable(inv) {
  if (!inv) throw notFound('invitation_not_found', 'Invitation not found');
  const status = invites.effectiveStatus(inv);
  if (status !== 'pending') throw gone(status);
  if (!USABLE_ORG_STATUSES.includes(inv.org_status)) throw forbidden('org_inactive', 'This clinic is not active');
}

router.get('/:token', async (req, res) => {
  const { db } = req.app.locals;
  const inv = await findByToken(db, req.params.token);
  assertUsable(inv);
  const { rowCount } = await db.query('select 1 from auth.users where lower(email) = lower($1)', [inv.email]);
  res.json({
    organization: { name: inv.org_name, slug: inv.org_slug },
    email: inv.email,
    role: inv.role,
    status: 'pending',
    expires_at: inv.expires_at,
    account_exists: rowCount > 0,
  });
});

router.post('/:token/accept', async (req, res) => {
  const { config, db, loginLimiter } = req.app.locals;
  const token = req.params.token;
  const body = req.body || {};
  const password = typeof body.password === 'string' ? body.password : '';
  const nameIn = typeof body.name === 'string' ? body.name.trim() : '';
  if (!password || password.length > 1024) throw badRequest('weak_password', 'Password is required');
  if (nameIn.length > 120) throw badRequest('invalid_name', 'Name must be at most 120 characters');

  // Rate limit like /api/auth/login (the password may be an existing account's).
  const peek = await findByToken(db, token);
  assertUsable(peek);
  const ip = auth.clientIp(req);
  const keys = [`email:${peek.email.toLowerCase()}`];
  if (ip) keys.push(`ip:${ip}`);
  const wait = Math.max(...keys.map((k) => loginLimiter.retryAfter(k)));
  if (wait) throw auth.tooManyAttempts(res, wait);

  let result;
  try {
    result = await db.withContext({ system: true }, async (client) => {
      const inv = await findByToken(client, token, { lock: true });
      assertUsable(inv);
      const orgId = inv.organization_id;

      // ── the account ───────────────────────────────────────────────────
      const { rows: found } = await client.query(
        `select id, email, encrypted_password, status, session_version, raw_user_meta_data
           from auth.users where lower(email) = lower($1) for update`,
        [inv.email],
      );
      let user = found[0];
      let created = false;
      if (user) {
        const ok = await auth.verifyPassword(password, user.encrypted_password);
        if (!ok) {
          throw Object.assign(new HttpError(401, 'invalid_credentials', 'This e-mail already has an account: enter its password'), {
            countsAsFailure: true,
          });
        }
        if (user.status !== 'active') throw forbidden('account_disabled', 'This account is disabled');
        if (nameIn && !auth.publicUser(user).name) {
          const { rows } = await client.query(
            `update auth.users
                set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', $2::text),
                    updated_at = now()
              where id = $1
              returning id, email, encrypted_password, status, session_version, raw_user_meta_data`,
            [user.id, nameIn],
          );
          user = rows[0];
        }
      } else {
        auth.validatePassword(password);
        if (!nameIn) throw badRequest('invalid_name', 'Name is required');
        const hash = await auth.hashPassword(password);
        const { rows } = await client.query(
          `insert into auth.users (email, encrypted_password, raw_user_meta_data, status, email_confirmed_at, last_sign_in_at)
           values ($1, $2, jsonb_build_object('name', $3::text), 'active', now(), now())
           returning id, email, encrypted_password, status, session_version, raw_user_meta_data`,
          [inv.email, hash, nameIn],
        );
        user = rows[0];
        created = true;
      }
      const displayName = auth.publicUser(user).name || nameIn || null;

      // ── membership, branches, staff row ───────────────────────────────
      const member = await members.activateMembership(client, {
        orgId, userId: user.id, role: inv.role, invitedBy: inv.invited_by,
      });
      let branchIds = [];
      if (inv.role !== 'admin' && inv.branch_ids && inv.branch_ids.length) {
        // Branches deleted since the invitation are skipped.
        const { rows } = await client.query(
          'select id from public.branches where organization_id = $1 and id = any($2::text[]) order by id',
          [orgId, inv.branch_ids],
        );
        branchIds = rows.map((r) => r.id);
      }
      await members.setMemberBranches(client, { orgId, memberId: member.id, branchIds });
      const staffId = await members.upsertStaffRow(client, {
        orgId, userId: user.id, email: user.email, name: displayName, role: inv.role, createdBy: inv.invited_by,
      });
      await client.query("update public.invitations set status = 'accepted' where id = $1", [inv.id]);

      // ── first admin activates the clinic ──────────────────────────────
      let activated = false;
      if (inv.role === 'admin' && inv.org_status === 'pending_activation') {
        await client.query("update public.organizations set status = 'active', status_reason = null where id = $1", [orgId]);
        activated = true;
      }
      await client.query('update auth.users set last_sign_in_at = now() where id = $1', [user.id]);

      const base = { orgId, actorUid: user.id, actorRole: inv.role };
      if (created) {
        await writeAudit(client, {
          ...base, action: 'user.create', tableName: 'users', rowPk: user.id, targetType: 'user', targetId: user.id,
          payload: { email: user.email, via: 'invitation' },
        });
      }
      await writeAudit(client, {
        ...base,
        action: 'invitation.accept',
        tableName: 'invitations',
        rowPk: inv.id,
        targetType: 'member',
        targetId: member.id,
        payload: {
          invitation_id: inv.id, email: user.email, role: inv.role, branch_ids: branchIds, staff_id: staffId,
          account: created ? 'created' : 'existing', previous_member_status: member.prevStatus, ip,
        },
      });
      if (activated) {
        await writeAudit(client, {
          ...base, action: 'organization.activate', tableName: 'organizations', rowPk: orgId,
          targetType: 'organization', targetId: orgId,
          payload: { from: 'pending_activation', to: 'active', by: 'first_admin_invitation' },
        });
      }
      return {
        user,
        organization: { id: orgId, slug: inv.org_slug, name: inv.org_name, status: activated ? 'active' : inv.org_status },
        role: inv.role,
      };
    });
  } catch (err) {
    if (err && err.countsAsFailure) keys.forEach((k) => loginLimiter.fail(k));
    throw err;
  }
  loginLimiter.reset(keys[0]);
  auth.issueSession(res, config, result.user, false);
  const payload = await auth.sessionPayload(db, auth.publicUser(result.user));
  res.json({ ...payload, organization: result.organization, role: result.role });
});

module.exports = router;
