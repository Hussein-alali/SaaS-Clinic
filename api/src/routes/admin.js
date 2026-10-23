'use strict';
// /api/admin/* — clinic administration replacing the Supabase Edge Functions
// admin-create-user, admin-reset-password and admin-set-status
// (docs/02-TRD.md "الإدارة داخل العيادة"). src/apiclient.jsx maps
// sb.functions.invoke("admin-<name>", {body}) to POST /api/admin/<name>.
//
// Same request/response bodies as the Edge Functions: {ok:true, ...} or
// {ok:false, error, detail}; every error of this router (validation, auth,
// plan limit, database) uses that shape, 401 → "missing_token" /
// "invalid_token" like the Edge Functions.
//
// Caller: an active ADMIN of the current clinic (Host / X-Org-Slug). The
// target is always a member of THAT clinic: staff rows are read in the
// caller's RLS context (other clinics' rows do not exist for it), and the
// account is touched only through an organization_members row of the clinic
// (staff.auth_uid alone is admin-editable data and is never trusted).
// Every action writes audit_events in the same transaction.

const express = require('express');
const auth = require('../auth');
const { requireOrg } = require('../tenant');
const { HttpError, forbidden, isPgError, mapPgError } = require('../errors');
const { writeAudit } = require('../audit');
const { isValidEmail } = require('../mailer');
const members = require('../members');

const router = express.Router();

// Edge Function email check (admin-create-user), plus the mailer's stricter
// rule: the address must later be usable for password-reset e-mails.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireAdmin = (req, res, next) => {
  if (req.ctx.role !== 'admin') throw forbidden('forbidden', 'Clinic admin only');
  next();
};

const fail = (status, error, detail) => new HttpError(status, error, detail || error);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function passwordOrFail(password) {
  try {
    auth.validatePassword(password);
  } catch (err) {
    throw fail(400, 'weak_password', err.message);
  }
}

router.use(requireOrg(), requireAdmin);

// ── POST /api/admin/create-user {email, password, name, role, phone[, branch_ids]} ──
router.post('/create-user', async (req, res) => {
  const { db } = req.app.locals;
  const body = req.body || {};
  const email = str(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const name = str(body.name);
  const role = str(body.role) || 'receptionist';
  const phone = body.phone === undefined || body.phone === null ? null : str(body.phone).slice(0, 40) || null;

  // isValidEmail first: it bounds the length (254) before EMAIL_RE runs.
  // EMAIL_RE backtracks quadratically, so an unbounded address (the JSON
  // body may be 10 MB) blocked the event loop for every clinic.
  if (!isValidEmail(email) || !EMAIL_RE.test(email)) throw fail(400, 'invalid_email', 'Invalid e-mail address');
  passwordOrFail(password);
  if (!members.STAFF_ROLES.includes(role)) throw fail(400, 'invalid_role', `role must be one of ${members.STAFF_ROLES.join(', ')}`);
  if (!name || name.length > 120) throw fail(400, 'missing_name', 'Name is required (max 120 characters)');

  const hash = await auth.hashPassword(password);
  const ctx = req.ctx;
  const result = await db.withContext(ctx, async (client) => {
    // Branches: the request's branch_ids, else the caller's current branch.
    const requested = body.branch_ids === undefined ? (ctx.branchId ? [ctx.branchId] : []) : body.branch_ids;
    const branchIds = await members.validateBranchIds(client, ctx.orgId, requested, role);

    const { rows: found } = await client.query(
      'select id, email, status from auth.users where lower(email) = lower($1) for update',
      [email],
    );
    let user = found[0];
    let created = false;
    if (user) {
      // Link only an account that belongs to this clinic alone (a former
      // member re-added): its password may be set by this clinic's admin.
      // Accounts of other clinics or of the platform join by invitation,
      // where the owner confirms with their own password.
      const { rows: [mine] } = await client.query(
        'select status from public.organization_members where organization_id = $1 and user_id = $2',
        [ctx.orgId, user.id],
      );
      if (mine && mine.status === 'active') throw fail(409, 'email_exists', 'This e-mail is already a member of this clinic');
      // No membership here at all (e.g. an imported account that belongs to
      // no clinic): not this clinic's account, so its password is not this
      // admin's to set.
      const ties = await members.accountTies(client, user.id, ctx.orgId);
      if (!mine || ties.otherClinics || ties.superAdmin || user.status !== 'active') {
        throw fail(409, 'email_exists', 'This e-mail already has an account; send it an invitation instead');
      }
      await client.query(
        `update auth.users
            set encrypted_password = $2, session_version = session_version + 1,
                raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', $3::text),
                updated_at = now()
          where id = $1`,
        [user.id, hash, name],
      );
    } else {
      // Pending invitations of this e-mail are superseded below; they do not count.
      const ins = await client.query(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data, status, email_confirmed_at)
         values ($1, $2, jsonb_build_object('name', $3::text), 'active', now())
         returning id, email, status`,
        [email, hash, name],
      );
      user = ins.rows[0];
      created = true;
    }

    await members.assertUserSeat(client, ctx.orgId, { email });
    const member = await members.activateMembership(client, { orgId: ctx.orgId, userId: user.id, role, invitedBy: ctx.userId });
    await members.setMemberBranches(client, { orgId: ctx.orgId, memberId: member.id, branchIds });
    const staffId = await members.upsertStaffRow(client, {
      orgId: ctx.orgId, userId: user.id, email, name, role, phone, createdBy: ctx.userId,
    });
    const superseded = await client.query(
      `update public.invitations set status = 'revoked'
        where organization_id = $1 and lower(email) = lower($2) and status = 'pending'
        returning id`,
      [ctx.orgId, email],
    );
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'staff.create',
      tableName: 'staff',
      rowPk: staffId,
      targetType: 'member',
      targetId: member.id,
      payload: {
        staff_id: staffId, staff_email: email, role, branch_ids: branchIds,
        account: created ? 'created' : 'linked', previous_member_status: member.prevStatus,
        revoked_invitations: superseded.rows.map((r) => r.id), ip: auth.clientIp(req),
      },
    });
    return { uid: user.id, staffId, created };
  });
  res.json({ ok: true, uid: result.uid, staff_id: result.staffId, linked: !result.created });
});

/** The clinic's staff row by staff_id (or auth_uid), read with the caller's RLS. */
async function findStaff(client, { staffId, authUid }) {
  const { rows } = staffId
    ? await client.query('select staff_id, email, auth_uid, name, status from public.staff where staff_id = $1', [staffId])
    : await client.query(
        `select staff_id, email, auth_uid, name, status from public.staff
          where auth_uid = $1 order by created_at nulls last, staff_id limit 1`,
        [authUid],
      );
  if (!rows[0]) throw fail(404, 'staff_not_found', 'Staff member not found');
  return rows[0];
}

/** The target account's membership in the caller's clinic, or null. */
async function membershipOf(client, orgId, userId) {
  if (!userId) return null;
  const { rows } = await client.query(
    'select id, role, status from public.organization_members where organization_id = $1 and user_id = $2 for update',
    [orgId, userId],
  );
  return rows[0] || null;
}

// ── POST /api/admin/reset-password {staff_id | auth_uid, password} ──
router.post('/reset-password', async (req, res) => {
  const { db, config } = req.app.locals;
  const body = req.body || {};
  const staffId = str(body.staff_id);
  const authUid = str(body.auth_uid);
  if (!staffId && !authUid) throw fail(400, 'missing_target', 'staff_id or auth_uid is required');
  if (!staffId && !auth.UUID_RE.test(authUid)) throw fail(404, 'staff_not_found', 'Staff member not found');
  const password = typeof body.password === 'string' ? body.password : '';
  passwordOrFail(password);
  const hash = await auth.hashPassword(password);
  const ctx = req.ctx;

  const result = await db.withContext(ctx, async (client) => {
    const target = await findStaff(client, { staffId, authUid });
    if (!target.auth_uid) throw fail(400, 'no_auth_account', 'This staff member has no login account');
    const member = await membershipOf(client, ctx.orgId, target.auth_uid);
    if (!member) throw fail(400, 'no_auth_account', 'This staff member has no login account in this clinic');
    // A password belongs to the account, not to one clinic: an account that
    // also works in another clinic (or is a Super Admin) resets it itself.
    const ties = await members.accountTies(client, target.auth_uid, ctx.orgId);
    if (ties.otherClinics || ties.superAdmin) {
      throw fail(403, 'shared_account', 'This account is also used outside this clinic; its owner must reset the password');
    }
    const { rows } = await client.query(
      `update auth.users
          set encrypted_password = $2, session_version = session_version + 1, updated_at = now()
        where id = $1
        returning id, email, session_version`,
      [target.auth_uid, hash],
    );
    await client.query('update auth.password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [target.auth_uid]);
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'staff.password_reset',
      tableName: 'staff',
      rowPk: target.staff_id,
      targetType: 'member',
      targetId: member.id,
      payload: { staff_id: target.staff_id, staff_email: target.email, ip: auth.clientIp(req) },
    });
    return { staffId: target.staff_id, user: rows[0] };
  });
  // Every session of the account ended (password change, docs/05 "Authentication
  // flow"); an admin who reset their own password keeps this one.
  if (result.user && result.user.id === ctx.userId) auth.issueSession(res, config, result.user, req.user.remember);
  res.json({ ok: true, staff_id: result.staffId });
});

// ── POST /api/admin/set-status {staff_id, active} (or {staff_id, status}) ──
router.post('/set-status', async (req, res) => {
  const { db } = req.app.locals;
  const body = req.body || {};
  const staffId = str(body.staff_id);
  if (!staffId) throw fail(400, 'missing_target', 'staff_id is required');
  let active;
  if (typeof body.active === 'boolean') active = body.active;
  else if (body.status === 'active' || body.status === 'inactive') active = body.status === 'active';
  else throw fail(400, 'invalid_status', 'Send active: true|false (or status: "active"|"inactive")');
  const ctx = req.ctx;

  const result = await db.withContext(ctx, async (client) => {
    const target = await findStaff(client, { staffId });
    if (target.auth_uid && target.auth_uid === ctx.userId && !active) {
      throw fail(400, 'cannot_deactivate_self', 'You cannot deactivate your own account');
    }
    const prevStatus = target.status || 'active';
    const newStatus = active ? 'active' : 'inactive';
    const member = await membershipOf(client, ctx.orgId, target.auth_uid);
    if (member && active && member.status !== 'active') {
      await members.assertUserSeat(client, ctx.orgId);
    }
    await client.query('update public.staff set status = $2 where staff_id = $1', [target.staff_id, newStatus]);
    let sessionsEnded = false;
    if (member) {
      const memberStatus = active ? 'active' : 'disabled';
      if (member.status !== memberStatus) {
        await client.query('update public.organization_members set status = $2 where id = $1', [member.id, memberStatus]);
      }
      if (!active) {
        // Data access ends with the membership (app_role() → NULL); bumping
        // session_version also ends the account's open sessions now. The
        // account itself (auth.users.status) is not disabled: it may belong
        // to other clinics, and accounts are not the clinic admin's to lock.
        await client.query(
          'update auth.users set session_version = session_version + 1, updated_at = now() where id = $1',
          [target.auth_uid],
        );
        sessionsEnded = true;
      }
    }
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: active ? 'staff.activate' : 'staff.deactivate',
      tableName: 'staff',
      rowPk: target.staff_id,
      targetType: member ? 'member' : 'staff',
      targetId: member ? member.id : target.staff_id,
      payload: {
        staff_id: target.staff_id, staff_email: target.email, prev_status: prevStatus, new_status: newStatus,
        prev_member_status: member ? member.status : null, sessions_ended: sessionsEnded, ip: auth.clientIp(req),
      },
    });
    return { staffId: target.staff_id, status: newStatus };
  });
  res.json({ ok: true, staff_id: result.staffId, status: result.status });
});

// Edge Function error shape for everything this router throws.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    let error = err.code;
    if (err.status === 401) error = err.code === 'unauthorized' ? 'missing_token' : 'invalid_token';
    if (err.code === 'PL422') error = String(err.message).replace(/^plan_limit:/, 'plan_limit_');
    return res.status(err.status).json({ ok: false, error, detail: err.message });
  }
  if (isPgError(err)) {
    const [status, body] = mapPgError(err);
    if (status >= 500) console.error(`[api] database error ${err.code}: ${err.message}`);
    let error = body.code;
    if (err.code === 'PL422') error = String(err.message).replace(/^plan_limit:/, 'plan_limit_');
    else if (err.code === '23505') error = 'email_exists';
    return res.status(status).json({ ok: false, error, detail: body.message });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid_json', detail: 'Malformed JSON body' });
  console.error('[api] admin route failed:', err && (err.stack || err.message || err));
  return res.status(500).json({ ok: false, error: 'internal_error', detail: 'Internal server error' });
});

module.exports = router;
