'use strict';
// The kinds of background job (docs/06 S7, src/jobs.js). Loaded by the app
// (src/create-app.js) and the cron runner (scripts/run-jobs.js). Each
// handler runs in the job's transaction (system context) and throws to be
// retried later.
//
//   email.invitation     {invitationId, lang}  the invitation e-mail failed:
//                        send it again with a new link, unless the
//                        invitation was accepted, revoked, expired or
//                        re-sent by hand meanwhile (email_status not 'failed')
//   email.password_reset {userId, lang}        the reset e-mail failed: a new link
//   maintenance.daily    {}                    drop what is no longer needed
//                        (queued once a day by the runners)

const jobs = require('./jobs');
const invites = require('./invites');
const passwordReset = require('./password-reset');

jobs.register('email.invitation', async ({ invitationId, lang }, { client, deps }) => {
  const { rows } = await client.query(
    `select i.*, o.slug as org_slug, o.name as org_name
       from public.invitations i join public.organizations o on o.id = i.organization_id
      where i.id = $1`, [invitationId]);
  const row = rows[0];
  if (!row || row.email_status !== 'failed' || invites.effectiveStatus(row) !== 'pending') return;
  const { invitation, token } = await invites.resendInvitation(client, { orgId: row.organization_id, id: row.id });
  const sent = await invites.deliverInvitation(deps, { org: { slug: row.org_slug, name: row.org_name }, invitation, token, lang });
  if (!sent) throw new Error('invitation e-mail failed again');
  await client.query("update public.invitations set email_status = 'sent', email_status_at = now() where id = $1", [row.id]);
});

jobs.register('email.password_reset', async ({ userId, lang }, { client, deps }) => {
  const { rows } = await client.query("select id, email from auth.users where id = $1 and status = 'active'", [userId]);
  if (!rows[0]) return;
  await passwordReset.sendResetLink(deps, client, rows[0], lang);
});

// What each table needs to keep: rate-limit windows 2 days, idempotent
// answers 1 day, error samples 30 days, finished jobs 30 days (dead ones
// 90), the e-mail log 90 days.
jobs.register('maintenance.daily', async (payload, { client }) => {
  await client.query("delete from public.rate_limits where window_start < now() - interval '2 days'");
  await client.query("delete from public.idempotency_keys where created_at < now() - interval '1 day'");
  await client.query("delete from public.error_events where created_at < now() - interval '30 days'");
  await client.query(`delete from public.jobs where (done_at < now() - interval '30 days')
                         or (dead_at < now() - interval '90 days')`);
  await client.query("delete from public.mail_log where sent_at < now() - interval '90 days'");
});

// The day's maintenance, queued at most once per UTC day, whatever the
// number of runners.
function queueDaily(db) {
  return jobs.enqueueOnce(db, 'maintenance.daily', {}, `maintenance.daily:${new Date().toISOString().slice(0, 10)}`);
}

module.exports = { queueDaily };
