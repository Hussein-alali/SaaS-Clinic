'use strict';
// Invitations (docs/02-TRD.md "Authentication and roles", docs/05
// "invitations" and "Authentication flow"): a random token, of which only
// the SHA-256 is stored; valid 7 days; the link
//   https://<slug>.<APP_BASE_DOMAIN>/?invite=<token>
// (development: http://<slug>.<base>:<PORT>/?invite=<token>&org=<slug>,
// because there is no wildcard DNS and the frontend reads ?org=).
// Shared by /api/org/invitations (clinic admin) and /api/platform (Super Admin).
//
// The delivery of the last e-mail is kept on the row (0008): email_status
// 'pending' when the invitation is created or re-sent, then 'sent' or
// 'failed' once the SMTP attempt finishes (also after the request has
// answered); NULL for rows older than 0008. email_status_at = last change.
//
// The e-mail is bilingual (src/mailer.js bilingualMessage): Arabic and
// English, the inviting person's interface language (X-Lang) first.

const crypto = require('crypto');
const { HttpError, badRequest, notFound } = require('./errors');
const { sha256 } = require('./auth');
const { isValidEmail, bilingualMessage } = require('./mailer');
const { MEMBER_ROLES, validateBranchIds, assertUserSeat } = require('./members');
const ratelimit = require('./ratelimit');
const jobs = require('./jobs');

const INVITE_TTL_SQL = "interval '7 days'";
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

const ROLE_LABELS_AR = {
  admin: 'مدير العيادة',
  receptionist: 'موظف استقبال',
  doctor: 'طبيب',
  therapist: 'أخصائي',
  staff: 'موظف',
};
// The same names as the English interface (src/lang/en-*.jsx).
const ROLE_LABELS_EN = {
  admin: 'Clinic admin',
  receptionist: 'Receptionist',
  doctor: 'Doctor',
  therapist: 'Therapist',
  staff: 'Staff',
};

const newToken = () => crypto.randomBytes(32).toString('base64url');
const isTokenShaped = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** <scheme>://<slug>.<APP_BASE_DOMAIN>[:port]/?invite=<token>[&org=<slug> in development] */
function inviteLink(config, slug, token) {
  const scheme = config.production || config.cookieSecure ? 'https' : 'http';
  const port = config.production ? '' : `:${config.port}`;
  const dev = config.production ? '' : `&org=${encodeURIComponent(slug)}`;
  return `${scheme}://${slug}.${config.appBaseDomain}${port}/?invite=${encodeURIComponent(token)}${dev}`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Effective status: a pending invitation past expires_at is 'expired'. */
function effectiveStatus(row) {
  if (row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return row.status;
}

const isoOrNull = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** The invitation as the API shows it (never the token or its hash). */
function describeInvitation(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    email: row.email,
    role: row.role,
    branch_ids: row.branch_ids || [],
    status: effectiveStatus(row),
    invited_by: row.invited_by,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    email_status: row.email_status ?? null,
    email_status_at: isoOrNull(row.email_status_at),
  };
}

/** Validates {email, role} of an invitation request → {email (lower-case), role}. */
function parseInvitationInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) throw badRequest('invalid_email', 'A valid e-mail address is required');
  const role = typeof b.role === 'string' ? b.role.trim() : '';
  if (!MEMBER_ROLES.includes(role)) throw badRequest('invalid_role', `role must be one of ${MEMBER_ROLES.join(', ')}`);
  return { email, role, branchIds: b.branch_ids };
}

/**
 * Creates a pending invitation. The client must see the clinic's branches
 * (clinic admin context or system context). Throws 409 already_member /
 * invitation_exists, 400 for bad branches, 422 plan_limit:users (trigger).
 * Returns {invitation (row), token}.
 */
async function createInvitation(client, { orgId, email, role, branchIds, invitedBy }) {
  const branches = await validateBranchIds(client, orgId, branchIds, role);
  const { rows: members } = await client.query(
    `select m.status
       from public.organization_members m
       join auth.users u on u.id = m.user_id
      where m.organization_id = $1 and lower(u.email) = lower($2)`,
    [orgId, email],
  );
  if (members[0] && members[0].status === 'active') {
    throw new HttpError(409, 'already_member', 'This person is already a member of the clinic');
  }
  // An expired pending invitation no longer blocks a new one.
  await client.query(
    `update public.invitations set status = 'expired'
      where organization_id = $1 and lower(email) = lower($2) and status = 'pending' and expires_at <= now()`,
    [orgId, email],
  );
  const { rows: pending } = await client.query(
    `select id from public.invitations where organization_id = $1 and lower(email) = lower($2) and status = 'pending'`,
    [orgId, email],
  );
  if (pending[0]) {
    throw new HttpError(409, 'invitation_exists', 'A pending invitation for this e-mail already exists; resend it instead');
  }
  const token = newToken();
  const { rows } = await client.query(
    `insert into public.invitations
       (organization_id, email, token_hash, role, branch_ids, invited_by, expires_at, email_status, email_status_at)
     values ($1, $2, $3, $4, $5::text[], $6, now() + ${INVITE_TTL_SQL}, 'pending', now())
     returning *`,
    [orgId, email, sha256(token), role, branches, invitedBy || null],
  );
  return { invitation: rows[0], token };
}

/** Locks one invitation of the clinic, or 404. */
async function lockInvitation(client, orgId, id) {
  const { rows } = await client.query(
    'select * from public.invitations where id = $1 and organization_id = $2 for update',
    [id, orgId],
  );
  if (!rows[0]) throw notFound('invitation_not_found', 'Invitation not found');
  return rows[0];
}

/**
 * New token and 7 more days for a pending (or expired) invitation. An
 * expired one takes a seat again, so the plan limit is checked.
 * Returns {invitation, token}.
 */
// At most 5 sends (create + resend) to one address a day, and 200 a day
// per clinic (docs/06 S5, task 2.19). Called inside the invitation's
// transaction with the pool (db), so a refused send leaves the invitation
// as it was while the attempt still counts.
async function limitSends(db, res, { orgId, email }) {
  await ratelimit.enforce(db, res, 'invite_org', orgId);
  await ratelimit.enforce(db, res, 'invite_email', String(email).toLowerCase());
}

async function resendInvitation(client, { orgId, id }) {
  const row = await lockInvitation(client, orgId, id);
  const status = effectiveStatus(row);
  if (status !== 'pending' && status !== 'expired') {
    throw new HttpError(409, 'invitation_not_pending', `The invitation is ${status}`);
  }
  if (status === 'expired') await assertUserSeat(client, orgId, { excludeInvitationId: id });
  const token = newToken();
  const { rows } = await client.query(
    `update public.invitations
        set token_hash = $2, status = 'pending', expires_at = now() + ${INVITE_TTL_SQL},
            email_status = 'pending', email_status_at = now()
      where id = $1
      returning *`,
    [id, sha256(token)],
  );
  return { invitation: rows[0], token, previousStatus: status };
}

/** Cancels a pending invitation (status 'revoked'; rows are never deleted). */
async function revokeInvitation(client, { orgId, id }) {
  const row = await lockInvitation(client, orgId, id);
  const status = effectiveStatus(row);
  if (status !== 'pending' && status !== 'expired') {
    throw new HttpError(409, 'invitation_not_pending', `The invitation is ${status}`);
  }
  const { rows } = await client.query("update public.invitations set status = 'revoked' where id = $1 returning *", [id]);
  return rows[0];
}

/** Invitations of a clinic, newest first. */
async function listInvitations(client, orgId) {
  const { rows } = await client.query(
    'select * from public.invitations where organization_id = $1 order by created_at desc, id',
    [orgId],
  );
  return rows.map(describeInvitation);
}

const MAIL_WAIT_MS = 10000;

/**
 * Sends the invitation e-mail after the invitation was committed. Returns
 * true when sent; a failure is logged (without the address) and returns
 * false: the invitation stays valid and can be re-sent. A slow SMTP server
 * does not hold the request: after MAIL_WAIT_MS the answer is null
 * (still sending).
 *
 * With deps.db (the routes pass app.locals) the outcome is stored on the
 * row as email_status 'sent' | 'failed' as soon as the attempt finishes,
 * also after MAIL_WAIT_MS; deps.background (app.locals.background) lets
 * close()/drain() wait for that late write. When it finishes in time,
 * `invitation` is updated in place, so describeInvitation(invitation)
 * shows the stored state.
 *
 * lang ('ar' | 'en', src/mailer.js requestLang): the section that comes
 * first in the bilingual e-mail; Arabic when not given.
 */
async function sendInvitationEmail(deps, { org, invitation, token, lang }, waitMs = MAIL_WAIT_MS) {
  const { mailer, config, db, background } = deps;
  let sending = deliverInvitation({ mailer, config }, { org, invitation, token, lang });
  if (db && invitation.id) {
    sending = sending.then(async (sent) => {
      await recordEmailStatus(db, invitation, token, sent);
      // Failed: a job sends it again later, with a new link (docs/06 S7).
      if (!sent) await queueRetry(db, invitation, lang);
      return sent;
    });
    if (background) background(() => sending);
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([sending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stores the outcome of one e-mail. Only while the row still holds that
 * e-mail's token: a later re-send (new token, 'pending') is never
 * overwritten by the result of an older e-mail. Never throws, and logs no
 * address.
 */
// The job's payload is the invitation id and the language: never the
// address or a token (the job issues a new one). Never throws.
async function queueRetry(db, invitation, lang) {
  try {
    await jobs.enqueue(db, 'email.invitation', { invitationId: invitation.id, lang: lang === 'en' ? 'en' : 'ar' },
      { runAt: new Date(Date.now() + 60e3), dedupeKey: `email.invitation:${invitation.id}` });
  } catch (err) {
    console.error('[api] invitation e-mail retry not queued:', err && err.message);
  }
}

async function recordEmailStatus(db, invitation, token, sent) {
  try {
    const { rows } = await db.query(
      `update public.invitations set email_status = $3, email_status_at = now()
        where id = $1 and token_hash = $2
        returning email_status, email_status_at`,
      [invitation.id, sha256(token), sent ? 'sent' : 'failed'],
    );
    if (rows[0]) Object.assign(invitation, rows[0]);
  } catch (err) {
    console.error('[api] invitation e-mail status not saved:', err && err.message);
  }
}

/** The invitation e-mail: {subject, text, html}, both languages, `lang` first. */
function invitationMessage({ name, role, link, lang }) {
  const roleAr = ROLE_LABELS_AR[role] || role;
  const roleEn = ROLE_LABELS_EN[role] || role;
  const n = escapeHtml(name);
  const a = escapeHtml(link);
  return bilingualMessage(lang, {
    ar: {
      subject: `دعوة للانضمام إلى ${name}`,
      text: [
        `تمت دعوتك للانضمام إلى «${name}» على ClinicSystem EG بدور: ${roleAr}.`,
        `لتفعيل حسابك افتح الرابط التالي خلال 7 أيام: ${link}`,
        'إن لم تكن تتوقع هذه الدعوة فتجاهل هذه الرسالة.',
      ],
      html:
        `<p>تمت دعوتك للانضمام إلى «${n}» على ClinicSystem EG بدور: ${escapeHtml(roleAr)}.</p>` +
        `<p><a href="${a}">قبول الدعوة وتفعيل الحساب</a> (صالح لمدة 7 أيام)</p>` +
        '<p>إن لم تكن تتوقع هذه الدعوة فتجاهل هذه الرسالة.</p>',
    },
    en: {
      subject: `Invitation to join ${name}`,
      text: [
        `You have been invited to join "${name}" on ClinicSystem EG as ${roleEn}.`,
        `Open this link within 7 days to activate your account: ${link}`,
        'If you did not expect this invitation, ignore this e-mail.',
      ],
      html:
        `<p>You have been invited to join “${n}” on ClinicSystem EG as ${escapeHtml(roleEn)}.</p>` +
        `<p><a href="${a}">Accept the invitation and activate your account</a> (valid for 7 days)</p>` +
        '<p>If you did not expect this invitation, ignore this e-mail.</p>',
    },
  });
}

async function deliverInvitation({ mailer, config }, { org, invitation, token, lang }) {
  const link = inviteLink(config, org.slug, token);
  const name = String(org.name || org.slug);
  try {
    await mailer.send({ to: invitation.email, kind: 'invitation', ...invitationMessage({ name, role: invitation.role, link, lang }) });
    return true;
  } catch (err) {
    console.error('[api] invitation e-mail failed:', err && err.message);
    return false;
  }
}

module.exports = {
  limitSends,
  deliverInvitation,
  INVITE_TTL_SQL,
  ROLE_LABELS_AR,
  ROLE_LABELS_EN,
  invitationMessage,
  isTokenShaped,
  inviteLink,
  effectiveStatus,
  describeInvitation,
  parseInvitationInput,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  listInvitations,
  sendInvitationEmail,
};
