'use strict';
// Tenant (clinic) context. The organization comes from the Host
// (<slug>.<APP_BASE_DOMAIN>) or, when the host carries no clinic, from the
// X-Org-Slug header (development without wildcard DNS). admin.<base> is the
// platform (Super Admin) context and never has an organization.
//
// req.ctx = {userId, orgId, role, branchId, slug, memberId} is set ONLY when
// the user has an active membership in an active organization; it is what
// db.withContext() writes into app.user_id / app.org_id / app.branch_id.

const { loadUser } = require('./auth');
const { unauthorized, forbidden } = require('./errors');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BRANCH_ID_MAX = 128;

/**
 * Where does this request point? → {platform, slug, source}
 * slug is lower-case or null; source is 'host' | 'header' | 'query' | null.
 * options.queryParam lets GET download links (<img src>, no custom headers)
 * name the clinic in development: /api/files/object/...?org=<slug>.
 */
function resolveTenant(req, config, options = {}) {
  const host = String(req.hostname || '').toLowerCase().replace(/\.$/, '');
  const base = config.appBaseDomain;
  if (host === `admin.${base}`) return { platform: true, slug: null, source: 'host' };
  if (host.endsWith(`.${base}`)) {
    const label = host.slice(0, -(base.length + 1));
    if (label && label !== 'www' && !label.includes('.')) return { platform: false, slug: label, source: 'host' };
  }
  const header = req.get('x-org-slug');
  if (header && header.trim()) return { platform: false, slug: header.trim().toLowerCase(), source: 'header' };
  if (options.queryParam) {
    const q = req.query && req.query[options.queryParam];
    if (typeof q === 'string' && q.trim()) return { platform: false, slug: q.trim().toLowerCase(), source: 'query' };
  }
  return { platform: false, slug: null, source: null };
}

const isValidSlug = (slug) => typeof slug === 'string' && SLUG_RE.test(slug);

/** Organization row by slug (case-insensitive) + its specialty code, or null. */
async function findOrganization(db, slug) {
  if (!isValidSlug(slug)) return null;
  const { rows } = await db.query(
    `select o.id, o.slug, o.name, o.status, o.plan_id, s.code as specialty_code
       from organizations o
       left join specialties s on s.id = o.primary_specialty_id
      where lower(o.slug) = $1`,
    [slug],
  );
  return rows[0] || null;
}

/** Membership of userId in the organization with this slug. */
async function findMembership(db, userId, slug) {
  if (!isValidSlug(slug)) return null;
  const { rows } = await db.query(
    `select o.id as org_id, o.slug, o.name as org_name, o.status as org_status,
            m.id as member_id, m.role, m.status as member_status
       from organizations o
       join organization_members m on m.organization_id = o.id and m.user_id = $2
      where lower(o.slug) = $1`,
    [slug, userId],
  );
  return rows[0] || null;
}

/**
 * Branches the member may use: active branches first (branches are
 * deactivated with status = 'inactive', never deleted), then oldest first.
 * admin: every branch of the organization; other roles: their
 * member_branches rows. Runs inside the caller's RLS context (branches has
 * FORCE RLS). Returns full branch rows (to_jsonb) when `full`, otherwise
 * {id} only.
 */
async function accessibleBranches(client, { orgId, role, memberId }, full = false) {
  const pick = full ? 'to_jsonb(b) as branch' : 'b.id';
  if (role === 'admin') {
    const { rows } = await client.query(
      `select ${pick} from branches b where b.organization_id = $1
        order by (b.status = 'active') desc, b.created_at nulls last, b.id`,
      [orgId],
    );
    return full ? rows.map((r) => r.branch) : rows.map((r) => ({ id: r.id }));
  }
  // member_branches is an identity table (no RLS). The branch row itself may
  // be hidden from some roles by RLS, so it is a left join: the assignment
  // still counts, it just sorts last.
  const { rows } = await client.query(
    `select mb.branch_id as id, ${full ? 'to_jsonb(b)' : 'null::jsonb'} as branch
       from member_branches mb
       left join branches b on b.id = mb.branch_id
      where mb.member_id = $1 and mb.organization_id = $2
      order by (b.status = 'active') desc nulls last, b.created_at nulls last, mb.branch_id`,
    [memberId, orgId],
  );
  return rows.map((r) => (full && r.branch ? r.branch : { id: r.id }));
}

/** X-Branch-Id when accessible, else the first accessible branch (active
 *  ones sort first), else null. */
function chooseBranch(branches, requested) {
  if (requested && branches.some((b) => b.id === requested)) return requested;
  return branches.length ? branches[0].id : null;
}

/**
 * Middleware factory: valid session + active membership in the active
 * organization the request points to; sets req.ctx. 401 without a session,
 * 403 otherwise (no clinic, platform host, not a member, inactive).
 */
function requireOrg(options = {}) {
  return async function requireOrgMiddleware(req, res, next) {
    const { config, db } = req.app.locals;
    const user = await loadUser(req, res);
    if (!user) throw unauthorized(req.authError || 'unauthorized', 'Authentication required');
    const tenant = resolveTenant(req, config, options);
    req.tenant = tenant;
    if (tenant.platform || !tenant.slug) throw forbidden('org_required', 'No clinic selected for this request');
    const m = await findMembership(db, user.id, tenant.slug);
    if (!m || m.member_status !== 'active') throw forbidden('not_a_member', 'You are not a member of this clinic');
    if (m.org_status !== 'active') throw forbidden('org_inactive', 'This clinic is not active');

    const requested = (req.get('x-branch-id') || '').trim().slice(0, BRANCH_ID_MAX) || null;
    const base = { userId: user.id, orgId: m.org_id, role: m.role, memberId: m.member_id };
    const branches = await db.withContext({ userId: user.id, orgId: m.org_id }, (client) => accessibleBranches(client, base));
    req.ctx = { ...base, branchId: chooseBranch(branches, requested), slug: m.slug };
    next();
  };
}

/** Public settings + enabled modules shown before sign-in (/api/orgs/*). */
async function organizationPublicInfo(db, org) {
  const [modules, settings] = await Promise.all([
    db.query(
      `select m.code
         from organization_modules om
         join modules m on m.id = om.module_id
        where om.organization_id = $1 and om.enabled and coalesce(m.status, 'active') = 'active'
        order by m.code`,
      [org.id],
    ),
    // clinic_settings is a clinic table (FORCE RLS): read it in that clinic's context.
    db.withContext({ orgId: org.id }, (client) =>
      client.query(
        'select name, subtitle, logo, primary_color from clinic_settings where organization_id = $1 and id = 1',
        [org.id],
      ),
    ),
  ]);
  const s = settings.rows[0] || {};
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    status: org.status,
    specialty_code: org.specialty_code || null,
    modules: modules.rows.map((r) => r.code),
    settings: {
      display_name: s.name ?? null,
      subtitle: s.subtitle ?? null,
      logo: s.logo ?? null,
      primary_color: s.primary_color ?? null,
    },
  };
}

module.exports = {
  SLUG_RE,
  isValidSlug,
  resolveTenant,
  findOrganization,
  findMembership,
  accessibleBranches,
  chooseBranch,
  requireOrg,
  organizationPublicInfo,
};
