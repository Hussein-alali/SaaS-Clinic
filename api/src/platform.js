'use strict';
// Helpers for /api/platform/* (Super Admin): slug rules, module
// dependencies, plan input and the organization detail view
// (docs/02-TRD.md "Super Admin", docs/05-Backend-Schema.md "organizations",
// "Data validation").

const { HttpError, badRequest } = require('./errors');
const { UUID_RE } = require('./auth');
const { describeInvitation } = require('./invites');

// docs/05 "organizations.slug": 3-32 characters, lower-case letters, digits
// and hyphens, no leading/trailing hyphen (same as organizations_slug_chk).
const SLUG_FORMAT = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;
const PLAN_CODE_FORMAT = /^[a-z0-9][a-z0-9_-]*$/;

const ORG_STATUSES = Object.freeze(['draft', 'pending_activation', 'active', 'suspended', 'closed']);
// docs/05 "Data validation": draft → pending_activation → active ⇄ suspended → closed.
const STATUS_TRANSITIONS = Object.freeze({
  draft: ['pending_activation'],
  pending_activation: ['active'],
  active: ['suspended'],
  suspended: ['active', 'closed'],
  closed: [],
});
const SUBSCRIPTION_STATUSES = Object.freeze(['trial', 'active', 'past_due', 'cancelled']);

/** {available, reason}: reason is null, 'invalid_format', 'reserved' or 'taken'. */
async function slugAvailability(db, slug) {
  if (typeof slug !== 'string' || !SLUG_FORMAT.test(slug)) return { available: false, reason: 'invalid_format' };
  const { rows: [r] } = await db.query(
    `select exists (select 1 from public.reserved_slugs where slug = $1) as reserved,
            exists (select 1 from public.organizations where lower(slug) = $1) as taken`,
    [slug],
  );
  if (r.reserved) return { available: false, reason: 'reserved' };
  if (r.taken) return { available: false, reason: 'taken' };
  return { available: true, reason: null };
}

function parseName(value, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 2 || name.length > 120) throw badRequest('invalid_name', 'Name must be 2-120 characters');
  return name;
}

/** Active specialty by code → {id, code}, else 400. */
async function findSpecialty(db, code) {
  if (typeof code !== 'string' || !code) throw badRequest('invalid_specialty', 'specialty_code is required');
  const { rows } = await db.query("select id, code, status from public.specialties where code = $1", [code]);
  if (!rows[0] || rows[0].status !== 'active') throw badRequest('invalid_specialty', `Unknown or inactive specialty: ${code}`);
  return rows[0];
}

/** Plan row by id (uuid) → row, else 400 invalid_plan. Archived plans only when allowArchivedId equals it. */
async function findPlan(db, id, { allowArchivedId = null } = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest('invalid_plan', 'plan_id must be a plan id');
  const { rows } = await db.query('select * from public.subscription_plans where id = $1', [id]);
  const plan = rows[0];
  if (!plan) throw badRequest('invalid_plan', 'Unknown plan');
  if (plan.status !== 'active' && plan.id !== allowArchivedId) throw badRequest('invalid_plan', 'This plan is archived');
  return plan;
}

/** The default plan ('default'), or null. */
async function defaultPlan(db) {
  const { rows } = await db.query("select * from public.subscription_plans where code = 'default' and status = 'active'");
  return rows[0] || null;
}

/**
 * Validates a set of module codes to enable (docs/05 "Data validation":
 * every depends_on enabled too; only modules 'active' in the catalog;
 * the plan's included_modules when it lists them — core.* is always
 * allowed). Returns the de-duplicated, sorted codes.
 */
async function validateModuleCodes(db, codes, plan) {
  if (!Array.isArray(codes) || codes.length > 200 || !codes.every((c) => typeof c === 'string' && c.length <= 64)) {
    throw badRequest('invalid_modules', 'modules must be an array of module codes');
  }
  const wanted = [...new Set(codes.map((c) => c.trim()))].sort();
  const { rows } = await db.query('select code, status, depends_on from public.modules');
  const catalog = new Map(rows.map((r) => [r.code, r]));
  const unknown = wanted.filter((c) => !catalog.has(c));
  if (unknown.length) throw badRequest('unknown_module', `Unknown module(s): ${unknown.join(', ')}`);
  const unavailable = wanted.filter((c) => catalog.get(c).status !== 'active');
  if (unavailable.length) throw badRequest('module_unavailable', `Module(s) not available yet: ${unavailable.join(', ')}`);
  const set = new Set(wanted);
  const missing = [];
  for (const code of wanted) {
    for (const dep of catalog.get(code).depends_on || []) {
      if (!set.has(dep)) missing.push(`${code} needs ${dep}`);
    }
  }
  if (missing.length) throw badRequest('module_dependency', `Missing module dependencies: ${missing.join('; ')}`);
  if (plan && Array.isArray(plan.included_modules)) {
    const outside = wanted.filter((c) => !c.startsWith('core.') && !plan.included_modules.includes(c));
    if (outside.length) {
      throw new HttpError(422, 'plan_limit_modules', `The plan does not include: ${outside.join(', ')}`);
    }
  }
  return wanted;
}

/** The specialty's default modules that are active in the catalog. */
async function specialtyDefaultModules(db, specialtyId) {
  const { rows } = await db.query(
    `select m.code from public.specialty_modules sm join public.modules m on m.id = sm.module_id
      where sm.specialty_id = $1 and m.status = 'active' order by m.code`,
    [specialtyId],
  );
  return rows.map((r) => r.code);
}

/**
 * Writes organization_modules: `codes` enabled, every other row of the
 * clinic (and every default module of `specialtyId`, when given) present
 * but disabled. Rows are never deleted (BR-007). Returns
 * {enabled:[codes newly on], disabled:[codes newly off]}.
 */
async function writeModules(client, { orgId, codes, configuredBy, specialtyId = null }) {
  const { rows } = await client.query(
    `with wanted as (
       select m.id, (m.code = any($2::text[])) as enabled
         from public.modules m
        where m.code = any($2::text[])
           or exists (select 1 from public.organization_modules om where om.organization_id = $1 and om.module_id = m.id)
           or ($4::uuid is not null and exists (select 1 from public.specialty_modules sm
                                                 where sm.specialty_id = $4::uuid and sm.module_id = m.id))
     ), before as (
       select om.module_id, om.enabled from public.organization_modules om where om.organization_id = $1
     ), up as (
       insert into public.organization_modules (organization_id, module_id, enabled, configured_by)
       select $1, w.id, w.enabled, $3 from wanted w
       on conflict (organization_id, module_id) do update
         set enabled = excluded.enabled, configured_by = excluded.configured_by
         where public.organization_modules.enabled is distinct from excluded.enabled
       returning module_id, enabled
     )
     select m.code, up.enabled, b.enabled as was
       from up join public.modules m on m.id = up.module_id
       left join before b on b.module_id = up.module_id
      order by m.code`,
    [orgId, codes, configuredBy || null, specialtyId],
  );
  return {
    enabled: rows.filter((r) => r.enabled && r.was !== true).map((r) => r.code),
    disabled: rows.filter((r) => !r.enabled && r.was === true).map((r) => r.code),
  };
}

const PLAN_LIMIT_FIELDS = ['max_users', 'max_branches', 'max_storage_mb'];

/** Validates POST/PATCH /plans bodies → column values (only the given fields when partial). */
async function parsePlanInput(db, body, { partial }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has('code')) {
    if (typeof b.code !== 'string' || !PLAN_CODE_FORMAT.test(b.code) || b.code.length > 40) {
      throw badRequest('invalid_code', 'code: lower-case letters, digits, "_" or "-" (max 40)');
    }
    out.code = b.code;
  }
  if (!partial || has('name')) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120) throw badRequest('invalid_name', 'name must be 1-120 characters');
    out.name = name;
  }
  for (const k of PLAN_LIMIT_FIELDS) {
    if (has(k)) {
      const v = b[k];
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 1000000)) {
        throw badRequest('invalid_limit', `${k} must be null (unlimited) or a whole number >= 0`);
      }
      out[k] = v;
    } else if (!partial) out[k] = null;
  }
  if (has('included_modules') || !partial) {
    const v = has('included_modules') ? b.included_modules : null;
    if (v === null) out.included_modules = null;
    else {
      if (!Array.isArray(v) || !v.every((c) => typeof c === 'string')) {
        throw badRequest('invalid_modules', 'included_modules must be null or an array of module codes');
      }
      const codes = [...new Set(v)].sort();
      const { rows } = await db.query('select code from public.modules where code = any($1::text[])', [codes]);
      if (rows.length !== codes.length) {
        const known = new Set(rows.map((r) => r.code));
        throw badRequest('unknown_module', `Unknown module(s): ${codes.filter((c) => !known.has(c)).join(', ')}`);
      }
      out.included_modules = codes;
    }
  }
  if (has('status') || !partial) {
    const v = has('status') ? b.status : 'active';
    if (!['active', 'archived'].includes(v)) throw badRequest('invalid_status', 'status must be active or archived');
    out.status = v;
  }
  if (partial && !Object.keys(out).length) throw badRequest('nothing_to_update', 'No plan field given');
  return out;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

/**
 * Organization detail for the Super Admin (A04): the organization + plan,
 * all catalog modules with `enabled`, branches, members (with branch_ids),
 * invitations, the current subscription and usage counts. No patient data.
 * Returns null when the organization does not exist.
 */
async function organizationDetail(db, orgId) {
  const { rows: [org] } = await db.query(
    `select o.id, o.name, o.slug, o.status, o.status_reason, o.suspended_at, o.retention_until,
            s.code as specialty_code, o.plan_id, o.created_by, o.created_at, o.updated_at,
            case when p.id is null then null else jsonb_build_object(
              'id', p.id, 'code', p.code, 'name', p.name, 'max_users', p.max_users,
              'max_branches', p.max_branches, 'max_storage_mb', p.max_storage_mb,
              'included_modules', p.included_modules, 'status', p.status) end as plan
       from public.organizations o
       join public.specialties s on s.id = o.primary_specialty_id
       left join public.subscription_plans p on p.id = o.plan_id
      where o.id = $1`,
    [orgId],
  );
  if (!org) return null;
  const [modules, members, invitations, subscription, branches] = await Promise.all([
    db.query(
      `select m.code, m.name_ar, m.category, m.depends_on, m.status, coalesce(om.enabled, false) as enabled
         from public.modules m
         left join public.organization_modules om on om.module_id = m.id and om.organization_id = $1
        order by m.category, m.code`,
      [orgId],
    ),
    db.query(
      `select m.id, m.user_id, u.email,
              coalesce(u.raw_user_meta_data->>'name', u.raw_user_meta_data->>'full_name') as name,
              m.role, m.status, m.joined_at, m.created_at,
              coalesce(array_agg(mb.branch_id order by mb.branch_id) filter (where mb.branch_id is not null), '{}') as branch_ids
         from public.organization_members m
         join auth.users u on u.id = m.user_id
         left join public.member_branches mb on mb.member_id = m.id
        where m.organization_id = $1
        group by m.id, u.id
        order by m.created_at, u.email`,
      [orgId],
    ),
    db.query('select * from public.invitations where organization_id = $1 order by created_at desc, id', [orgId]),
    db.query(
      `select id, plan_id, status, period_start, period_end, notes, set_by, created_at
         from public.subscriptions where organization_id = $1
        order by created_at desc, id desc limit 1`,
      [orgId],
    ),
    // branches has FORCE RLS: read in the system context.
    db.withContext({ system: true }, (client) =>
      client.query(
        `select id, name, status, address, phone, rooms, working_hours, created_at
           from public.branches where organization_id = $1
          order by (status = 'active') desc, created_at nulls last, id`,
        [orgId],
      ),
    ),
  ]);
  const invites = invitations.rows.map(describeInvitation);
  return {
    organization: {
      ...org,
      suspended_at: iso(org.suspended_at),
      retention_until: iso(org.retention_until),
      created_at: iso(org.created_at),
      updated_at: iso(org.updated_at),
    },
    modules: modules.rows,
    branches: branches.rows,
    members: members.rows,
    invitations: invites,
    subscription: subscription.rows[0] || null,
    usage: {
      active_members: members.rows.filter((m) => m.status === 'active').length,
      pending_invitations: invites.filter((i) => i.status === 'pending').length,
      active_branches: branches.rows.filter((b) => b.status === 'active').length,
    },
  };
}

module.exports = {
  SLUG_FORMAT,
  ORG_STATUSES,
  STATUS_TRANSITIONS,
  SUBSCRIPTION_STATUSES,
  slugAvailability,
  parseName,
  findSpecialty,
  findPlan,
  defaultPlan,
  validateModuleCodes,
  specialtyDefaultModules,
  writeModules,
  parsePlanInput,
  organizationDetail,
};
