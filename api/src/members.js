'use strict';
// Memberships, staff rows and plan seats, shared by /api/admin/create-user,
// /api/invitations/:token/accept and the invitation routes.
//
// Every function takes a pg client inside a transaction (db.withContext):
//   - organization_members, member_branches, invitations, auth.users have no
//     RLS (platform/identity tables, docs/05 convention 4): the routes check
//     the caller before calling these;
//   - staff and branches have FORCE RLS: the client must be the clinic
//     admin's context or the system context.

const crypto = require('crypto');
const { HttpError, badRequest } = require('./errors');

/** organization_members.role / invitations.role (docs/05 "organization_members"). */
const MEMBER_ROLES = Object.freeze(['admin', 'receptionist', 'doctor', 'therapist', 'staff']);
/** staff.role CHECK in 0001 (no 'staff'); also the admin-create-user ROLE_SLUGS. */
const STAFF_ROLES = Object.freeze(['admin', 'receptionist', 'doctor', 'therapist']);

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Same format as newRecordId() in src/apiclient.jsx: prefix + base36 time + 6 random base36. */
function newRecordId(prefix) {
  let rnd = '';
  while (rnd.length < 6) {
    for (const b of crypto.randomBytes(12)) {
      // 252 = 7 * 36: dropping 252..255 keeps every character equally likely.
      if (b < 252 && rnd.length < 6) rnd += ALPHABET[b % 36];
    }
  }
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}

const planLimit = (what) => new HttpError(422, 'PL422', `plan_limit:${what}`);

/** Same advisory lock as the plan-limit triggers of 0003 (enforce_user_limit / enforce_branch_limit). */
async function lockPlanLimit(client, orgId) {
  await client.query("select pg_advisory_xact_lock(hashtext('clinicsys.plan_limit'), hashtext($1::text))", [orgId]);
}

/**
 * Throws 422 plan_limit:users unless one more user fits the clinic's plan.
 * Users = active memberships + pending unexpired invitations (a pending
 * invitation reserves its seat, as in the invitations trigger). Used where
 * a membership becomes active WITHOUT an invitation (create-user,
 * set-status active, re-sending an expired invitation): the members trigger
 * only counts active members, because an invitation being accepted already
 * holds a seat. Pending invitations of `email` are not counted (they are
 * superseded), nor is `excludeInvitationId`.
 */
async function assertUserSeat(client, orgId, { email = null, excludeInvitationId = null } = {}) {
  const { rows } = await client.query(
    `select p.max_users
       from public.organizations o
       join public.subscription_plans p on p.id = o.plan_id
      where o.id = $1`,
    [orgId],
  );
  const max = rows[0] ? rows[0].max_users : null;
  if (max === null || max === undefined) return;
  await lockPlanLimit(client, orgId);
  const { rows: [c] } = await client.query(
    `select (select count(*) from public.organization_members m
              where m.organization_id = $1 and m.status = 'active')::int as active,
            (select count(*) from public.invitations i
              where i.organization_id = $1 and i.status = 'pending' and i.expires_at > now()
                and ($2::text is null or lower(i.email) <> lower($2::text))
                and ($3::uuid is null or i.id <> $3::uuid))::int as pending`,
    [orgId, email, excludeInvitationId],
  );
  if (c.active + c.pending + 1 > max) throw planLimit('users');
}

/**
 * Validates branch_ids for a role. admin → [] (no member_branches rows =
 * every branch). Other roles need at least one ACTIVE branch of the clinic.
 * The client must see the clinic's branches (admin or system context).
 */
async function validateBranchIds(client, orgId, value, role) {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list) || list.length > 100 || !list.every((v) => typeof v === 'string' && v.trim() && v.length <= 128)) {
    throw badRequest('invalid_branch_ids', 'branch_ids must be an array of branch ids');
  }
  if (role === 'admin') return [];
  const ids = [...new Set(list.map((v) => v.trim()))];
  if (!ids.length) throw badRequest('branch_required', 'Choose at least one branch for this role');
  const { rows } = await client.query(
    `select id from public.branches where organization_id = $1 and id = any($2::text[]) and status = 'active'`,
    [orgId, ids],
  );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    throw badRequest('invalid_branch', `Unknown or inactive branch: ${ids.filter((id) => !found.has(id)).join(', ')}`);
  }
  return ids;
}

/**
 * Makes userId an ACTIVE member of orgId with `role` (insert, or update of
 * an existing invited/disabled/active membership). Plain select + insert or
 * update, not ON CONFLICT: a BEFORE INSERT plan-limit trigger would count
 * an already-active member twice. Returns {id, prevStatus, prevRole}.
 */
async function activateMembership(client, { orgId, userId, role, invitedBy = null }) {
  const { rows } = await client.query(
    `select id, status, role from public.organization_members
      where organization_id = $1 and user_id = $2 for update`,
    [orgId, userId],
  );
  if (rows[0]) {
    await client.query(
      `update public.organization_members
          set role = $2, status = 'active', invited_by = coalesce($3, invited_by),
              joined_at = coalesce(joined_at, now())
        where id = $1`,
      [rows[0].id, role, invitedBy],
    );
    return { id: rows[0].id, prevStatus: rows[0].status, prevRole: rows[0].role };
  }
  const ins = await client.query(
    `insert into public.organization_members (organization_id, user_id, role, status, invited_by, joined_at)
     values ($1, $2, $3, 'active', $4, now())
     returning id`,
    [orgId, userId, role, invitedBy],
  );
  return { id: ins.rows[0].id, prevStatus: null, prevRole: null };
}

/** Replaces the member's member_branches rows. */
async function setMemberBranches(client, { orgId, memberId, branchIds }) {
  await client.query('delete from public.member_branches where member_id = $1', [memberId]);
  if (branchIds.length) {
    await client.query(
      `insert into public.member_branches (member_id, branch_id, organization_id)
       select $1, b, $2 from unnest($3::text[]) as b`,
      [memberId, orgId, branchIds],
    );
  }
}

/**
 * The clinic's staff row for the account ("ملف الموظف", docs/02 "Authentication
 * and roles"): the row linked to userId, else the row with the same e-mail
 * (unique per clinic), is updated and linked; otherwise a row is inserted
 * with a newRecordId('U-') id. staff.role = the membership role; the 'staff'
 * membership role has no staff.role value in 0001's CHECK, so it is NULL.
 * Returns staff_id.
 */
async function upsertStaffRow(client, { orgId, userId, email, name, role, phone, createdBy = null }) {
  const staffRole = STAFF_ROLES.includes(role) ? role : null;
  const displayName = (name && String(name).trim()) || String(email).split('@')[0];
  const { rows } = await client.query(
    `select staff_id from public.staff
      where organization_id = $1 and (auth_uid = $2 or lower(email) = lower($3))
      order by (auth_uid = $2) desc nulls last, created_at nulls last, staff_id
      limit 1`,
    [orgId, userId, email],
  );
  if (rows[0]) {
    await client.query(
      `update public.staff
          set name = $2, role = $3, phone = coalesce($4, phone), email = $5, auth_uid = $6, status = 'active'
        where staff_id = $1`,
      [rows[0].staff_id, displayName, staffRole, phone || null, email, userId],
    );
    return rows[0].staff_id;
  }
  const staffId = newRecordId('U-');
  await client.query(
    `insert into public.staff (staff_id, organization_id, name, email, role, phone, status, auth_uid, created_by)
     values ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
    [staffId, orgId, displayName, email, staffRole, phone || null, userId, createdBy],
  );
  return staffId;
}

/** Other clinics the account belongs to (any membership status) and the Super Admin flag. */
async function accountTies(client, userId, orgId) {
  const { rows: [t] } = await client.query(
    `select exists (select 1 from public.organization_members m
                     where m.user_id = $1 and m.organization_id <> $2) as other_clinics,
            exists (select 1 from public.platform_admins p where p.user_id = $1) as super_admin`,
    [userId, orgId],
  );
  return { otherClinics: t.other_clinics, superAdmin: t.super_admin };
}

module.exports = {
  MEMBER_ROLES,
  STAFF_ROLES,
  newRecordId,
  planLimit,
  lockPlanLimit,
  assertUserSeat,
  validateBranchIds,
  activateMembership,
  setMemberBranches,
  upsertStaffRow,
  accountTies,
};
