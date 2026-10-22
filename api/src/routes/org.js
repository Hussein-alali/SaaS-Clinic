'use strict';
// /api/org/* — staff invitations managed by the clinic admin
// (docs/02-TRD.md "الإدارة داخل العيادة"; docs/03 C06):
//   GET    /api/org/invitations              → [invitation]
//   POST   /api/org/invitations              {email, role, branch_ids} → 201 {invitation, email_sent}
//   POST   /api/org/invitations/:id/resend   → {invitation, email_sent}
//   DELETE /api/org/invitations/:id          → 204 (status 'revoked')
// Caller: an active admin of the current clinic. Invitations count against
// the plan's user limit (trigger → 422 plan_limit:users). Only the SHA-256
// of the token is stored; the token travels only in the e-mail.

const express = require('express');
const auth = require('../auth');
const { requireOrg } = require('../tenant');
const { forbidden, notFound } = require('../errors');
const { writeAudit } = require('../audit');
const invites = require('../invites');

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

module.exports = router;
