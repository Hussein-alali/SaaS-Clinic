'use strict';
// /api/platform/* — Super Admin (docs/02-TRD.md "Super Admin"; docs/03 A01-A04).
//
// Every route needs: a session, a row in platform_admins (403
// not_super_admin), and the platform context: the host admin.<APP_BASE_DOMAIN>,
// or — outside production only — the header X-Platform: 1 (403
// platform_required). Platform tables have no RLS and are read directly;
// clinic tables (branches, clinic_settings, audit_events) are written and
// read in the system context. No route returns patient data (BR-008).
// Every write is audited (actor_role 'super_admin') in its transaction.

const express = require('express');
const auth = require('../auth');
const { resolveTenant } = require('../tenant');
const { HttpError, badRequest, forbidden, notFound, unauthorized, isPgError } = require('../errors');
const { writeAudit, PLATFORM_AUDIT_TABLES } = require('../audit');
const members = require('../members');
const invites = require('../invites');
const { isValidEmail, requestLang } = require('../mailer');
const P = require('../platform');

const router = express.Router();
const ACTOR_ROLE = 'super_admin';
const MAIN_BRANCH_NAME = 'الفرع الرئيسي';

async function requirePlatform(req, res, next) {
  const { config, db } = req.app.locals;
  const user = await auth.loadUser(req, res);
  if (!user) throw unauthorized(req.authError || 'unauthorized', 'Authentication required');
  if (!(await auth.isSuperAdmin(db, user.id))) throw forbidden('not_super_admin', 'Super Admin only');
  const tenant = resolveTenant(req, config);
  const devHeader = !config.production && req.get('x-platform') === '1';
  if (!tenant.platform && !devHeader) {
    throw forbidden('platform_required', `Open the platform at admin.${config.appBaseDomain}`);
  }
  req.isSuperAdmin = true;
  next();
}

router.use(requirePlatform);

// ── helpers ─────────────────────────────────────────────────────────────

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const audit = (client, req, entry) => writeAudit(client, { actorUid: req.user.id, actorRole: ACTOR_ROLE, ...entry });

function page(query) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('invalid_range', 'limit must be 1-200');
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw badRequest('invalid_range', 'offset must be >= 0');
  return { limit, offset };
}

const qstr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const likePattern = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/** The organization row (platform table) or 404. */
async function loadOrg(db, id, { client = null, lock = false } = {}) {
  if (!auth.UUID_RE.test(String(id))) throw notFound('org_not_found', 'Organization not found');
  const { rows } = await (client || db).query(
    `select o.*, s.code as specialty_code from public.organizations o
       join public.specialties s on s.id = o.primary_specialty_id
      where o.id = $1 ${lock ? 'for update of o' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('org_not_found', 'Organization not found');
  return rows[0];
}

/** Sends an invitation e-mail after the transaction committed and stores
 *  its outcome on the row (email_status). Bilingual, the Super Admin's
 *  interface language (X-Lang) first. */
async function mailInvitation(req, org, invitation, token) {
  return invites.sendInvitationEmail(req.app.locals, { org, invitation, token, lang: requestLang(req) });
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest('invalid_date', `${field} must be YYYY-MM-DD`);
  }
  return value;
}

// ── stats ───────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  const { db } = req.app.locals;
  const [byStatus, pending, overdue, errors, queue] = await Promise.all([
    db.query('select status, count(*)::int as n from public.organizations group by status'),
    db.query("select count(*)::int as n from public.invitations where status = 'pending' and expires_at > now()"),
    db.query("select count(*)::int as n from public.organizations where status = 'suspended' and retention_until < now()"),
    db.query('select count(*)::int as n from public.error_groups where resolved_at is null'),
    db.query(`select count(*) filter (where done_at is null and dead_at is null)::int as queued,
                     count(*) filter (where dead_at is not null)::int as failed from public.jobs`),
  ]);
  const organizations = Object.fromEntries(P.ORG_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of byStatus.rows) {
    organizations[r.status] = r.n;
    total += r.n;
  }
  res.json({
    organizations: { ...organizations, total },
    pending_invitations: pending.rows[0].n,
    retention_overdue: overdue.rows[0].n,
    open_errors: errors.rows[0].n,
    jobs_queued: queue.rows[0].queued,
    jobs_failed: queue.rows[0].failed,
  });
});

// ── organizations ───────────────────────────────────────────────────────

router.get('/organizations', async (req, res) => {
  const { db } = req.app.locals;
  const q = qstr(req.query.q);
  const status = qstr(req.query.status);
  const specialty = qstr(req.query.specialty);
  if (status && !P.ORG_STATUSES.includes(status)) throw badRequest('invalid_status', `status must be one of ${P.ORG_STATUSES.join(', ')}`);
  const { limit, offset } = page(req.query);
  const where = `where ($1::text is null or o.name ilike $1 or o.slug ilike $1)
                   and ($2::text is null or o.status = $2)
                   and ($3::text is null or s.code = $3)`;
  const params = [q ? likePattern(q) : null, status, specialty];
  const [list, count] = await Promise.all([
    db.query(
      `select o.id, o.name, o.slug, o.status, s.code as specialty_code, o.plan_id,
              p.code as plan_code, p.name as plan_name, o.status_reason, o.suspended_at, o.retention_until,
              o.created_at, o.updated_at,
              (select count(*) from public.organization_members m
                where m.organization_id = o.id and m.status = 'active')::int as active_members,
              (select count(*) from public.invitations i
                where i.organization_id = o.id and i.status = 'pending' and i.expires_at > now())::int as pending_invitations
         from public.organizations o
         join public.specialties s on s.id = o.primary_specialty_id
         left join public.subscription_plans p on p.id = o.plan_id
        ${where}
        order by o.created_at desc, o.id
        limit $4 offset $5`,
      [...params, limit, offset],
    ),
    db.query(
      `select count(*)::int as n from public.organizations o
         join public.specialties s on s.id = o.primary_specialty_id ${where}`,
      params,
    ),
  ]);
  res.json({ data: list.rows, count: count.rows[0].n });
});

// POST {name, slug, specialty_code, modules:[code], plan_id, admin_email}
// → 201: organization pending_activation + main branch + clinic_settings +
// organization_modules + subscription + the first admin's invitation, in
// ONE transaction (nothing is left behind when any step fails).
router.post('/organizations', async (req, res) => {
  const { db } = req.app.locals;
  const body = bodyOf(req);
  const name = P.parseName(body.name);
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const slugCheck = await P.slugAvailability(db, slug);
  if (!slugCheck.available) {
    if (slugCheck.reason === 'taken') throw new HttpError(409, 'slug_taken', 'This address is already used');
    throw badRequest(slugCheck.reason === 'reserved' ? 'slug_reserved' : 'invalid_slug', 'This address cannot be used');
  }
  const specialty = await P.findSpecialty(db, body.specialty_code);
  const plan = body.plan_id === undefined || body.plan_id === null ? await P.defaultPlan(db) : await P.findPlan(db, body.plan_id);
  const codes = body.modules === undefined || body.modules === null
    ? await P.specialtyDefaultModules(db, specialty.id)
    : await P.validateModuleCodes(db, body.modules, plan);
  if (body.modules === undefined || body.modules === null) await P.validateModuleCodes(db, codes, plan);
  const adminEmail = typeof body.admin_email === 'string' ? body.admin_email.trim().toLowerCase() : '';
  if (!isValidEmail(adminEmail)) throw badRequest('invalid_email', 'admin_email must be a valid e-mail address');

  let created;
  try {
    created = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
      const { rows: [org] } = await client.query(
        `insert into public.organizations (name, slug, primary_specialty_id, status, plan_id, created_by)
         values ($1, $2, $3, 'pending_activation', $4, $5)
         returning id, name, slug`,
        [name, slug, specialty.id, plan ? plan.id : null, req.user.id],
      );
      const branchId = members.newRecordId('br_');
      await client.query(
        `insert into public.branches (id, organization_id, name, status) values ($1, $2, $3, 'active')`,
        [branchId, org.id, MAIN_BRANCH_NAME],
      );
      await client.query(
        'insert into public.clinic_settings (organization_id, id, name) values ($1, 1, $2)',
        [org.id, name],
      );
      await P.writeModules(client, { orgId: org.id, codes, configuredBy: req.user.id, specialtyId: specialty.id });
      if (plan) {
        await client.query(
          `insert into public.subscriptions (organization_id, plan_id, status, period_start, notes, set_by)
           values ($1, $2, 'active', current_date, 'created with the organization', $3)`,
          [org.id, plan.id, req.user.id],
        );
      }
      const { invitation, token } = await invites.createInvitation(client, {
        orgId: org.id, email: adminEmail, role: 'admin', branchIds: [], invitedBy: req.user.id,
      });
      await audit(client, req, {
        orgId: org.id, action: 'organization.create', tableName: 'organizations', rowPk: org.id,
        targetType: 'organization', targetId: org.id,
        payload: {
          name, slug, specialty_code: specialty.code, modules: codes, plan_id: plan ? plan.id : null,
          main_branch_id: branchId, admin_email: adminEmail,
        },
      });
      await audit(client, req, {
        orgId: org.id, action: 'invitation.create', tableName: 'invitations', rowPk: invitation.id,
        targetType: 'invitation', targetId: invitation.id,
        payload: { email: adminEmail, role: 'admin', branch_ids: [] },
      });
      return { org, invitation, token };
    });
  } catch (err) {
    if (isPgError(err) && err.code === '23505' && /organizations_slug_key/.test(err.constraint || err.message)) {
      throw new HttpError(409, 'slug_taken', 'This address is already used');
    }
    throw err;
  }
  const sent = await mailInvitation(req, created.org, created.invitation, created.token);
  res.status(201).json({
    ...(await P.organizationDetail(db, created.org.id)),
    invitation: invites.describeInvitation(created.invitation),
    email_sent: sent,
  });
});

router.get('/organizations/:id', async (req, res) => {
  const { db } = req.app.locals;
  const org = await loadOrg(db, req.params.id);
  res.json(await P.organizationDetail(db, org.id));
});

// PATCH {name, specialty_code, plan_id}
router.patch('/organizations/:id', async (req, res) => {
  const { db } = req.app.locals;
  const body = bodyOf(req);
  const org = await loadOrg(db, req.params.id);
  const changes = {};
  const sets = [];
  const params = [org.id];
  if (has(body, 'name')) {
    const name = P.parseName(body.name);
    if (name !== org.name) {
      params.push(name);
      sets.push(`name = $${params.length}`);
      changes.name = { from: org.name, to: name };
    }
  }
  if (has(body, 'specialty_code')) {
    const specialty = await P.findSpecialty(db, body.specialty_code);
    if (specialty.code !== org.specialty_code) {
      params.push(specialty.id);
      sets.push(`primary_specialty_id = $${params.length}`);
      changes.specialty_code = { from: org.specialty_code, to: specialty.code };
    }
  }
  if (has(body, 'plan_id')) {
    const plan = body.plan_id === null ? null : await P.findPlan(db, body.plan_id, { allowArchivedId: org.plan_id });
    const planId = plan ? plan.id : null;
    if (planId !== org.plan_id) {
      params.push(planId);
      sets.push(`plan_id = $${params.length}`);
      changes.plan_id = { from: org.plan_id, to: planId };
    }
  }
  if (!['name', 'specialty_code', 'plan_id'].some((k) => has(body, k))) {
    throw badRequest('nothing_to_update', 'Send name, specialty_code and/or plan_id');
  }
  if (sets.length) {
    await db.withContext({ userId: req.user.id, system: true }, async (client) => {
      await client.query(`update public.organizations set ${sets.join(', ')} where id = $1`, params);
      await audit(client, req, {
        orgId: org.id, action: 'organization.update', tableName: 'organizations', rowPk: org.id,
        targetType: 'organization', targetId: org.id, payload: { changes },
      });
    });
  }
  res.json(await P.organizationDetail(db, org.id));
});

// POST {status, reason}: transitions of docs/05 "Data validation"; reason
// required for suspended/closed; suspension keeps the data 6 months
// (retention_until). Access ends at once: every request re-reads the
// clinic's status (requireOrg, app_role(), signed file links).
router.post('/organizations/:id/status', async (req, res) => {
  const { db } = req.app.locals;
  const body = bodyOf(req);
  const status = typeof body.status === 'string' ? body.status : '';
  if (!P.ORG_STATUSES.includes(status)) throw badRequest('invalid_status', `status must be one of ${P.ORG_STATUSES.join(', ')}`);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > 1000) throw badRequest('invalid_reason', 'reason must be at most 1000 characters');
  if ((status === 'suspended' || status === 'closed') && !reason) {
    throw badRequest('reason_required', 'A reason is required to suspend or close a clinic');
  }
  const result = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const org = await loadOrg(db, req.params.id, { client, lock: true });
    if (!(P.STATUS_TRANSITIONS[org.status] || []).includes(status)) {
      throw new HttpError(409, 'invalid_transition', `A ${org.status} clinic cannot become ${status}`);
    }
    let sql;
    if (status === 'suspended') {
      sql = `update public.organizations
                set status = 'suspended', status_reason = $2, suspended_at = now(),
                    retention_until = now() + interval '6 months'
              where id = $1 returning status, status_reason, suspended_at, retention_until`;
    } else if (status === 'active') {
      sql = `update public.organizations
                set status = 'active', status_reason = nullif($2, ''), suspended_at = null, retention_until = null
              where id = $1 returning status, status_reason, suspended_at, retention_until`;
    } else {
      // closed keeps the retention date of the suspension; pending_activation has none.
      sql = `update public.organizations
                set status = $3, status_reason = nullif($2, '')
              where id = $1 returning status, status_reason, suspended_at, retention_until`;
    }
    const { rows: [row] } = await client.query(sql, status === 'suspended' || status === 'active' ? [org.id, reason] : [org.id, reason, status]);
    await audit(client, req, {
      orgId: org.id, action: 'organization.status', tableName: 'organizations', rowPk: org.id,
      targetType: 'organization', targetId: org.id,
      payload: { from: org.status, to: status, reason: reason || null, retention_until: row.retention_until },
    });
    return org.id;
  });
  res.json(await P.organizationDetail(db, result));
});

// PUT {codes:[...]}: the enabled set (dependencies checked); other modules
// are kept as disabled rows (disabling never deletes data, BR-007).
router.put('/organizations/:id/modules', async (req, res) => {
  const { db } = req.app.locals;
  const body = bodyOf(req);
  const org = await loadOrg(db, req.params.id);
  let plan = null;
  if (org.plan_id) plan = (await db.query('select * from public.subscription_plans where id = $1', [org.plan_id])).rows[0];
  const codes = await P.validateModuleCodes(db, body.codes, plan);
  await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const diff = await P.writeModules(client, { orgId: org.id, codes, configuredBy: req.user.id });
    await audit(client, req, {
      orgId: org.id, action: 'organization.modules', tableName: 'organization_modules', rowPk: org.id,
      targetType: 'organization', targetId: org.id, payload: { codes, ...diff },
    });
  });
  res.json(await P.organizationDetail(db, org.id));
});

// PUT {plan_id, status, period_start, period_end, notes}: a new manual
// subscription row (history is kept) and organizations.plan_id.
router.put('/organizations/:id/subscription', async (req, res) => {
  const { db } = req.app.locals;
  const body = bodyOf(req);
  const org = await loadOrg(db, req.params.id);
  const plan = await P.findPlan(db, body.plan_id, { allowArchivedId: org.plan_id });
  const status = body.status === undefined || body.status === null ? 'active' : body.status;
  if (!P.SUBSCRIPTION_STATUSES.includes(status)) {
    throw badRequest('invalid_status', `status must be one of ${P.SUBSCRIPTION_STATUSES.join(', ')}`);
  }
  const periodStart = parseDate(body.period_start, 'period_start');
  const periodEnd = parseDate(body.period_end, 'period_end');
  if (periodStart && periodEnd && periodEnd < periodStart) throw badRequest('invalid_date', 'period_end is before period_start');
  if (body.notes !== undefined && body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > 2000)) {
    throw badRequest('invalid_notes', 'notes must be text (max 2000 characters)');
  }
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const { rows: [sub] } = await client.query(
      `insert into public.subscriptions (organization_id, plan_id, status, period_start, period_end, notes, set_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [org.id, plan.id, status, periodStart, periodEnd, notes, req.user.id],
    );
    await client.query('update public.organizations set plan_id = $2 where id = $1 and plan_id is distinct from $2', [org.id, plan.id]);
    await audit(client, req, {
      orgId: org.id, action: 'subscription.set', tableName: 'subscriptions', rowPk: sub.id,
      targetType: 'organization', targetId: org.id,
      payload: { plan_id: plan.id, plan_code: plan.code, previous_plan_id: org.plan_id, status, period_start: periodStart, period_end: periodEnd, notes },
    });
  });
  res.json(await P.organizationDetail(db, org.id));
});

// ── invitations of any clinic ──────────────────────────────────────────

const INVITABLE_ORG_STATUSES = ['pending_activation', 'active'];

router.get('/organizations/:id/invitations', async (req, res) => {
  const { db } = req.app.locals;
  const org = await loadOrg(db, req.params.id);
  res.json(await invites.listInvitations(db, org.id));
});

router.post('/organizations/:id/invitations', async (req, res) => {
  const { db } = req.app.locals;
  const org = await loadOrg(db, req.params.id);
  if (!INVITABLE_ORG_STATUSES.includes(org.status)) throw new HttpError(409, 'org_inactive', `This clinic is ${org.status}`);
  const input = invites.parseInvitationInput(req.body);
  const { invitation, token } = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const r = await invites.createInvitation(client, {
      orgId: org.id, email: input.email, role: input.role, branchIds: input.branchIds, invitedBy: req.user.id,
    });
    await invites.limitSends(db, res, { orgId: org.id, email: r.invitation.email });
    await audit(client, req, {
      orgId: org.id, action: 'invitation.create', tableName: 'invitations', rowPk: r.invitation.id,
      targetType: 'invitation', targetId: r.invitation.id,
      payload: { email: r.invitation.email, role: r.invitation.role, branch_ids: r.invitation.branch_ids },
    });
    return r;
  });
  const sent = await mailInvitation(req, org, invitation, token);
  res.status(201).json({ invitation: invites.describeInvitation(invitation), email_sent: sent });
});

const invitationIdOf = (req) => {
  if (!auth.UUID_RE.test(req.params.invitationId)) throw notFound('invitation_not_found', 'Invitation not found');
  return req.params.invitationId;
};

router.post('/organizations/:id/invitations/:invitationId/resend', async (req, res) => {
  const { db } = req.app.locals;
  const org = await loadOrg(db, req.params.id);
  const id = invitationIdOf(req);
  if (!INVITABLE_ORG_STATUSES.includes(org.status)) throw new HttpError(409, 'org_inactive', `This clinic is ${org.status}`);
  const { invitation, token } = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const r = await invites.resendInvitation(client, { orgId: org.id, id });
    await invites.limitSends(db, res, { orgId: org.id, email: r.invitation.email });
    await audit(client, req, {
      orgId: org.id, action: 'invitation.resend', tableName: 'invitations', rowPk: id,
      targetType: 'invitation', targetId: id, payload: { email: r.invitation.email, previous_status: r.previousStatus },
    });
    return r;
  });
  const sent = await mailInvitation(req, org, invitation, token);
  res.json({ invitation: invites.describeInvitation(invitation), email_sent: sent });
});

router.delete('/organizations/:id/invitations/:invitationId', async (req, res) => {
  const { db } = req.app.locals;
  const org = await loadOrg(db, req.params.id);
  const id = invitationIdOf(req);
  await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const row = await invites.revokeInvitation(client, { orgId: org.id, id });
    await audit(client, req, {
      orgId: org.id, action: 'invitation.revoke', tableName: 'invitations', rowPk: id,
      targetType: 'invitation', targetId: id, payload: { email: row.email },
    });
  });
  res.status(204).end();
});

// ── catalogs ────────────────────────────────────────────────────────────

router.get('/slug-available', async (req, res) => {
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  res.json(await P.slugAvailability(req.app.locals.db, slug));
});

router.get('/specialties', async (req, res) => {
  const { rows } = await req.app.locals.db.query(
    `select s.id, s.code, s.name_ar, s.name_en, s.status,
            coalesce(array_agg(m.code order by m.code) filter (where m.code is not null), '{}') as default_modules
       from public.specialties s
       left join public.specialty_modules sm on sm.specialty_id = s.id
       left join public.modules m on m.id = sm.module_id
      group by s.id
      order by s.code`,
  );
  res.json(rows);
});

router.get('/modules', async (req, res) => {
  const { rows } = await req.app.locals.db.query(
    'select id, code, name_ar, category, depends_on, status from public.modules order by category, code',
  );
  res.json(rows);
});

// ── plans ───────────────────────────────────────────────────────────────

const PLAN_COLUMNS = `p.id, p.code, p.name, p.max_users, p.max_branches, p.max_storage_mb,
  p.included_modules, p.status, p.created_at, p.updated_at`;

router.get('/plans', async (req, res) => {
  const { rows } = await req.app.locals.db.query(
    `select ${PLAN_COLUMNS},
            (select count(*) from public.organizations o where o.plan_id = p.id)::int as organizations
       from public.subscription_plans p
      order by (p.status = 'active') desc, p.code`,
  );
  res.json(rows);
});

async function savePlan(req, res, { id = null } = {}) {
  const { db } = req.app.locals;
  const input = await P.parsePlanInput(db, bodyOf(req), { partial: !!id });
  const cols = Object.keys(input);
  const values = cols.map((c) => input[c]);
  try {
    const plan = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
      let row;
      if (id) {
        const { rows: [before] } = await client.query('select * from public.subscription_plans where id = $1 for update', [id]);
        if (!before) throw notFound('plan_not_found', 'Plan not found');
        const { rows } = await client.query(
          `update public.subscription_plans p set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
            where p.id = $1 returning ${PLAN_COLUMNS}`,
          [id, ...values],
        );
        row = rows[0];
        await audit(client, req, {
          action: 'plan.update', tableName: 'subscription_plans', rowPk: id, targetType: 'plan', targetId: id,
          payload: { changes: Object.fromEntries(cols.map((c) => [c, { from: before[c], to: input[c] }])) },
        });
      } else {
        const { rows } = await client.query(
          `insert into public.subscription_plans as p (${cols.join(', ')})
           values (${cols.map((c, i) => `$${i + 1}`).join(', ')}) returning ${PLAN_COLUMNS}`,
          values,
        );
        row = rows[0];
        await audit(client, req, {
          action: 'plan.create', tableName: 'subscription_plans', rowPk: row.id, targetType: 'plan', targetId: row.id,
          payload: input,
        });
      }
      return row;
    });
    res.status(id ? 200 : 201).json(plan);
  } catch (err) {
    if (isPgError(err) && err.code === '23505') throw new HttpError(409, 'plan_code_taken', 'A plan with this code exists');
    throw err;
  }
}

router.post('/plans', (req, res) => savePlan(req, res));

router.patch('/plans/:id', (req, res) => {
  if (!auth.UUID_RE.test(req.params.id)) throw notFound('plan_not_found', 'Plan not found');
  return savePlan(req, res, { id: req.params.id });
});

// ── audit ───────────────────────────────────────────────────────────────
// GET ?organization_id=&actor=<uuid|email>&action=<name|prefix*>&from=&to=&limit=&offset=
// → {data, count}, newest first. payload only for the API's own platform /
// membership events (clinic RPC rows may hold patient data, BR-008).

router.get('/audit', async (req, res) => {
  const { db } = req.app.locals;
  const { limit, offset } = page(req.query);
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const orgId = qstr(req.query.organization_id);
  if (orgId) {
    if (!auth.UUID_RE.test(orgId)) throw badRequest('invalid_filter', 'organization_id must be a uuid');
    add('a.organization_id = ?', orgId);
  }
  const actor = qstr(req.query.actor);
  if (actor) {
    if (auth.UUID_RE.test(actor)) add('a.actor_uid = ?', actor);
    else add('lower(u.email) = lower(?)', actor);
  }
  const action = qstr(req.query.action);
  if (action) {
    if (action.length > 100) throw badRequest('invalid_filter', 'action is too long');
    if (action.endsWith('*')) add("a.action like ? escape '\\'", `${action.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`);
    else add('a.action = ?', action);
  }
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    const v = qstr(req.query[key]);
    if (!v) continue;
    if (Number.isNaN(Date.parse(v))) throw badRequest('invalid_filter', `${key} must be a date or timestamp`);
    if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(v)) add("a.created_at < (?::date + 1)", v); // the whole day
    else add(`a.created_at ${op} ?::timestamptz`, v);
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const from = `from public.audit_events a
                left join auth.users u on u.id = a.actor_uid
                left join public.organizations o on o.id = a.organization_id`;
  // audit_events has FORCE RLS: the Super Admin reads it in the system context.
  const result = await db.withContext({ userId: req.user.id, system: true }, async (client) => {
    const list = await client.query(
      `select a.id, a.created_at, a.organization_id, o.slug as organization_slug, a.actor_uid,
              u.email as actor_email, a.actor_role, a.action, a.table_name, a.row_pk, a.target_type,
              a.target_id, a.result,
              case when a.table_name = any($${params.length + 1}::text[]) then a.payload end as payload
         ${from} ${whereSql}
        order by a.created_at desc, a.id desc
        limit $${params.length + 2} offset $${params.length + 3}`,
      [...params, PLATFORM_AUDIT_TABLES, limit, offset],
    );
    const count = await client.query(`select count(*)::int as n ${from} ${whereSql}`, params);
    return { data: list.rows, count: count.rows[0].n };
  });
  res.json(result);
});

// ── errors (A08, docs/06 S6) ────────────────────────────────────────────
// error_groups / error_events (0012) hold scrubbed text only; no RLS.

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const GROUP_COLUMNS = 'fingerprint, source, message, route, status, code, count::float8 as count, first_seen, last_seen, last_release, resolved_at';

async function errorGroup(db, fingerprint) {
  if (!FINGERPRINT_RE.test(fingerprint)) throw notFound('error_not_found', 'Error not found');
  const { rows } = await db.query(`select ${GROUP_COLUMNS} from public.error_groups where fingerprint = $1`, [fingerprint]);
  if (!rows[0]) throw notFound('error_not_found', 'Error not found');
  return rows[0];
}

router.get('/errors', async (req, res) => {
  const { db } = req.app.locals;
  const { limit, offset } = page(req.query);
  const status = qstr(req.query.status) || 'open';
  const where = { open: 'where resolved_at is null', resolved: 'where resolved_at is not null', all: '' }[status];
  if (where === undefined) throw badRequest('invalid_filter', 'status must be open, resolved or all');
  const [list, count] = await Promise.all([
    db.query(`select ${GROUP_COLUMNS} from public.error_groups ${where} order by last_seen desc limit $1 offset $2`, [limit, offset]),
    db.query(`select count(*)::int as n from public.error_groups ${where}`),
  ]);
  res.json({ data: list.rows, count: count.rows[0].n });
});

router.get('/errors/:fingerprint', async (req, res) => {
  const { db } = req.app.locals;
  const group = await errorGroup(db, req.params.fingerprint);
  const { rows: events } = await db.query(
    `select e.id, e.created_at, e.message, e.stack, e.route, e.method, e.status, e.code, e.release, e.user_agent,
            e.organization_id, o.slug as organization_slug, e.user_id
       from public.error_events e left join public.organizations o on o.id = e.organization_id
      where e.fingerprint = $1 order by e.created_at desc, e.id desc limit 20`, [group.fingerprint]);
  res.json({ group, events });
});

router.post('/errors/:fingerprint/resolve', async (req, res) => {
  const { db } = req.app.locals;
  const group = await errorGroup(db, req.params.fingerprint);
  const { rows } = await db.query(
    `update public.error_groups set resolved_at = now() where fingerprint = $1 returning ${GROUP_COLUMNS}`, [group.fingerprint]);
  res.json({ group: rows[0] });
});

module.exports = router;
