'use strict';
// /api/org/* — the clinic admin's own screens (docs/02-TRD.md "الإدارة
// داخل العيادة"; docs/03 C06 staff and invitations, C07 branches):
//   GET    /api/org/invitations              → [invitation]
//   POST   /api/org/invitations              {email, role, branch_ids} → 201 {invitation, email_sent}
//   POST   /api/org/invitations/:id/resend   → {invitation, email_sent}
//   DELETE /api/org/invitations/:id          → 204 (status 'revoked')
//   GET    /api/org/members                  → [member] (role, status, branches, staff row)
//   PATCH  /api/org/members/:id              {role?, branch_ids?} → member
//   GET    /api/org/usage                    → {plan, users, branches, branch_staff}
// Caller: an active admin of the current clinic. Invitations count against
// the plan's user limit (trigger → 422 plan_limit:users). Only the SHA-256
// of the token is stored; the token travels only in the e-mail.

const express = require('express');
const auth = require('../auth');
const { requireOrg } = require('../tenant');
const { badRequest, forbidden, notFound } = require('../errors');
const { writeAudit } = require('../audit');
const invites = require('../invites');
const members = require('../members');

const router = express.Router();

const requireAdmin = (req, res, next) => {
  if (req.ctx.role !== 'admin') throw forbidden('forbidden', 'Clinic admin only');
  next();
};

const invitationId = (req) => {
  const id = req.params.id;
  if (!auth.UUID_RE.test(id)) throw notFound('invitation_not_found', 'Invitation not found');
  return id;
};

/** Name and slug of the current clinic (for the e-mail). */
async function currentOrg(db, orgId) {
  const { rows } = await db.query('select id, name, slug from public.organizations where id = $1', [orgId]);
  return rows[0];
}

router.use('/invitations', requireOrg(), requireAdmin);

router.get('/invitations', async (req, res) => {
  const { db } = req.app.locals;
  res.json(await db.withContext(req.ctx, (client) => invites.listInvitations(client, req.ctx.orgId)));
});

router.post('/invitations', async (req, res) => {
  const { db, mailer, config } = req.app.locals;
  const input = invites.parseInvitationInput(req.body);
  const ctx = req.ctx;
  const { invitation, token } = await db.withContext(ctx, async (client) => {
    const r = await invites.createInvitation(client, {
      orgId: ctx.orgId, email: input.email, role: input.role, branchIds: input.branchIds, invitedBy: ctx.userId,
    });
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'invitation.create',
      tableName: 'invitations',
      rowPk: r.invitation.id,
      targetType: 'invitation',
      targetId: r.invitation.id,
      payload: { email: r.invitation.email, role: r.invitation.role, branch_ids: r.invitation.branch_ids, ip: auth.clientIp(req) },
    });
    return r;
  });
  const org = await currentOrg(db, ctx.orgId);
  const sent = await invites.sendInvitationEmail({ mailer, config }, { org, invitation, token });
  res.status(201).json({ invitation: invites.describeInvitation(invitation), email_sent: sent });
});

router.post('/invitations/:id/resend', async (req, res) => {
  const { db, mailer, config } = req.app.locals;
  const id = invitationId(req);
  const ctx = req.ctx;
  const { invitation, token } = await db.withContext(ctx, async (client) => {
    const r = await invites.resendInvitation(client, { orgId: ctx.orgId, id });
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'invitation.resend',
      tableName: 'invitations',
      rowPk: id,
      targetType: 'invitation',
      targetId: id,
      payload: { email: r.invitation.email, previous_status: r.previousStatus, ip: auth.clientIp(req) },
    });
    return r;
  });
  const org = await currentOrg(db, ctx.orgId);
  const sent = await invites.sendInvitationEmail({ mailer, config }, { org, invitation, token });
  res.json({ invitation: invites.describeInvitation(invitation), email_sent: sent });
});

router.delete('/invitations/:id', async (req, res) => {
  const { db } = req.app.locals;
  const id = invitationId(req);
  const ctx = req.ctx;
  await db.withContext(ctx, async (client) => {
    const row = await invites.revokeInvitation(client, { orgId: ctx.orgId, id });
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'invitation.revoke',
      tableName: 'invitations',
      rowPk: id,
      targetType: 'invitation',
      targetId: id,
      payload: { email: row.email, ip: auth.clientIp(req) },
    });
  });
  res.status(204).end();
});

// ── Members (C06) ───────────────────────────────────────────────────────
// organization_members, member_branches and auth.users have no RLS
// (identity tables): the clinic is fixed by req.ctx.orgId. staff has FORCE
// RLS and is read in the admin's context (every staff row of the clinic).

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

/** The clinic's members, active first, each with its staff row (by account, else e-mail). */
async function listMembers(client, orgId, selfId, onlyId = null) {
  const { rows } = await client.query(
    `select m.id, m.user_id, u.email, m.role, m.status, m.joined_at, m.created_at,
            coalesce(u.raw_user_meta_data->>'name', u.raw_user_meta_data->>'full_name') as account_name,
            coalesce(array_agg(mb.branch_id order by mb.branch_id) filter (where mb.branch_id is not null), '{}') as branch_ids
       from public.organization_members m
       join auth.users u on u.id = m.user_id
       left join public.member_branches mb on mb.member_id = m.id
      where m.organization_id = $1 and ($2::uuid is null or m.id = $2::uuid)
      group by m.id, u.id
      order by (m.status = 'active') desc, m.created_at, u.email`,
    [orgId, onlyId],
  );
  const { rows: staff } = await client.query(
    `select staff_id, name, phone, status, auth_uid, lower(email) as email
       from public.staff where organization_id = $1
      order by created_at nulls last, staff_id`,
    [orgId],
  );
  const byUid = new Map();
  const byEmail = new Map();
  for (const s of staff) {
    if (s.auth_uid && !byUid.has(s.auth_uid)) byUid.set(s.auth_uid, s);
    if (s.email && !byEmail.has(s.email)) byEmail.set(s.email, s);
  }
  return rows.map((r) => {
    const s = byUid.get(r.user_id) || byEmail.get(String(r.email || '').toLowerCase()) || null;
    return {
      id: r.id,
      user_id: r.user_id,
      email: r.email,
      name: (s && s.name) || r.account_name || String(r.email || '').split('@')[0],
      role: r.role,
      status: r.status,
      branch_ids: r.branch_ids || [],
      joined_at: iso(r.joined_at),
      created_at: iso(r.created_at),
      staff_id: s ? s.staff_id : null,
      staff_status: s ? s.status || 'active' : null,
      phone: s ? s.phone || null : null,
      is_self: r.user_id === selfId,
    };
  });
}

router.use('/members', requireOrg(), requireAdmin);

router.get('/members', async (req, res) => {
  const { db } = req.app.locals;
  res.set('Cache-Control', 'no-store');
  res.json(await db.withContext(req.ctx, (client) => listMembers(client, req.ctx.orgId, req.ctx.userId)));
});

// Role and/or branches of one member. The role is the membership role
// (what app_role() reads) and the staff row follows it. Non-admin roles
// need at least one ACTIVE branch; admin has no member_branches rows (every
// branch). A role outside the clinic roles (e.g. "super_admin") is refused
// and recorded as a denied audit event (AT-09). Changing a role ends the
// member's open sessions, so the screens reload with the new navigation.
router.patch('/members/:id', async (req, res) => {
  const { db } = req.app.locals;
  const ctx = req.ctx;
  const id = req.params.id;
  if (!auth.UUID_RE.test(id)) throw notFound('member_not_found', 'Member not found');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const hasRole = body.role !== undefined;
  const hasBranches = body.branch_ids !== undefined;
  if (!hasRole && !hasBranches) throw badRequest('invalid_request', 'Send role and/or branch_ids');
  if (hasRole && (typeof body.role !== 'string' || !members.MEMBER_ROLES.includes(body.role.trim()))) {
    await db.withContext(ctx, (client) => writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'member.update',
      tableName: 'organization_members',
      rowPk: id,
      targetType: 'member',
      targetId: id,
      result: 'denied',
      payload: { requested_role: String(body.role).slice(0, 60), reason: 'invalid_role', ip: auth.clientIp(req) },
    }));
    throw badRequest('invalid_role', `role must be one of ${members.MEMBER_ROLES.join(', ')}`);
  }

  const updated = await db.withContext(ctx, async (client) => {
    const { rows: [m] } = await client.query(
      `select id, user_id, role, status from public.organization_members
        where id = $1 and organization_id = $2 for update`,
      [id, ctx.orgId],
    );
    if (!m) throw notFound('member_not_found', 'Member not found');
    const { rows: current } = await client.query(
      'select branch_id from public.member_branches where member_id = $1 order by branch_id',
      [id],
    );
    const prevBranches = current.map((r) => r.branch_id);
    const newRole = hasRole ? body.role.trim() : m.role;
    if (m.user_id === ctx.userId && newRole !== m.role) {
      throw badRequest('cannot_change_own_role', 'You cannot change your own role');
    }
    let newBranches = prevBranches;
    if (hasBranches || newRole !== m.role) {
      newBranches = await members.validateBranchIds(client, ctx.orgId, hasBranches ? body.branch_ids : prevBranches, newRole);
      await members.setMemberBranches(client, { orgId: ctx.orgId, memberId: id, branchIds: newBranches });
    }
    if (newRole !== m.role) {
      await client.query('update public.organization_members set role = $2 where id = $1', [id, newRole]);
      await client.query(
        'update public.staff set role = $3 where organization_id = $1 and auth_uid = $2',
        [ctx.orgId, m.user_id, newRole],
      );
      await client.query(
        'update auth.users set session_version = session_version + 1, updated_at = now() where id = $1',
        [m.user_id],
      );
    }
    await writeAudit(client, {
      orgId: ctx.orgId,
      actorUid: ctx.userId,
      actorRole: ctx.role,
      action: 'member.update',
      tableName: 'organization_members',
      rowPk: id,
      targetType: 'member',
      targetId: id,
      payload: {
        prev_role: m.role, new_role: newRole, prev_branch_ids: prevBranches, new_branch_ids: newBranches,
        sessions_ended: newRole !== m.role, ip: auth.clientIp(req),
      },
    });
    const [row] = await listMembers(client, ctx.orgId, ctx.userId, id);
    return row;
  });
  res.json(updated);
});

// ── Plan usage (counters «X من Y» in C06 / C07) ─────────────────────────
// users = active members + pending unexpired invitations (the seat rule of
// the plan-limit triggers); branches = active branches. max_* null = no limit.
router.use('/usage', requireOrg(), requireAdmin);

router.get('/usage', async (req, res) => {
  const { db } = req.app.locals;
  const ctx = req.ctx;
  const [{ rows: [plan] }, { rows: [seats] }, { rows: staffRows }, branchRows] = await Promise.all([
    db.query(
      `select p.id, p.code, p.name, p.max_users, p.max_branches, p.max_storage_mb
         from public.organizations o
         left join public.subscription_plans p on p.id = o.plan_id
        where o.id = $1`,
      [ctx.orgId],
    ),
    db.query(
      `select (select count(*) from public.organization_members
                where organization_id = $1 and status = 'active')::int as active,
              (select count(*) from public.invitations
                where organization_id = $1 and status = 'pending' and expires_at > now())::int as pending`,
      [ctx.orgId],
    ),
    db.query(
      `select mb.branch_id, count(*)::int as n
         from public.member_branches mb
         join public.organization_members m on m.id = mb.member_id and m.status = 'active'
        where mb.organization_id = $1
        group by mb.branch_id`,
      [ctx.orgId],
    ),
    db.withContext(ctx, (client) => client.query(
      `select count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status <> 'active')::int as inactive
         from public.branches where organization_id = $1`,
      [ctx.orgId],
    )),
  ]);
  const p = plan && plan.id ? plan : null;
  const b = branchRows.rows[0] || { active: 0, inactive: 0 };
  res.set('Cache-Control', 'no-store');
  res.json({
    plan: p && {
      id: p.id, code: p.code, name: p.name,
      max_users: p.max_users, max_branches: p.max_branches, max_storage_mb: p.max_storage_mb,
    },
    users: {
      active: seats.active,
      pending_invitations: seats.pending,
      used: seats.active + seats.pending,
      max: p ? p.max_users : null,
    },
    branches: { active: b.active, inactive: b.inactive, total: b.active + b.inactive, max: p ? p.max_branches : null },
    branch_staff: Object.fromEntries(staffRows.map((r) => [r.branch_id, r.n])),
  });
});

module.exports = router;
