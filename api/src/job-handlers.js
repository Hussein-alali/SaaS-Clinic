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
//   usage.check          {}                    resource snapshot and alerts (S8)
//                        (both queued by the runners: once a day, once an hour)
//
// E-mail jobs wait for the next hour once the SMTP hourly budget is spent.

const jobs = require('./jobs');
const invites = require('./invites');
const passwordReset = require('./password-reset');
const usage = require('./usage');

async function withinEmailBudget(client, config) {
  if ((await usage.emailBudgetLeft(client, config)) > 0) return;
  const { rows: [r] } = await client.query("select date_trunc('hour', now()) + interval '1 hour' as at");
  throw jobs.defer(r.at, 'the hourly e-mail limit (SMTP_HOURLY_LIMIT) is reached: waiting for the next hour');
}

jobs.register('email.invitation', async ({ invitationId, lang }, { client, deps }) => {
  const { rows } = await client.query(
    `select i.*, o.slug as org_slug, o.name as org_name
       from public.invitations i join public.organizations o on o.id = i.organization_id
      where i.id = $1`, [invitationId]);
  const row = rows[0];
  if (!row || row.email_status !== 'failed' || invites.effectiveStatus(row) !== 'pending') return;
  await withinEmailBudget(client, deps.config);
  const { invitation, token } = await invites.resendInvitation(client, { orgId: row.organization_id, id: row.id });
  const sent = await invites.deliverInvitation(deps, { org: { slug: row.org_slug, name: row.org_name }, invitation, token, lang });
  if (!sent) throw new Error('invitation e-mail failed again');
  await client.query("update public.invitations set email_status = 'sent', email_status_at = now() where id = $1", [row.id]);
});

jobs.register('email.password_reset', async ({ userId, lang }, { client, deps }) => {
  const { rows } = await client.query("select id, email from auth.users where id = $1 and status = 'active'", [userId]);
  if (!rows[0]) return;
  await withinEmailBudget(client, deps.config);
  await passwordReset.sendResetLink(deps, client, rows[0], lang);
});

// What each table needs to keep: rate-limit windows 2 days, idempotent
// answers 1 day (webhook event ids 30: providers retry an event for days,
// docs/06 S10), error samples 30 days, finished jobs 30 days (dead ones
// 90), the e-mail log 90 days.
jobs.register('maintenance.daily', async (payload, { client }) => {
  await client.query("delete from public.rate_limits where window_start < now() - interval '2 days'");
  await client.query(`delete from public.idempotency_keys
                       where created_at < now() - case when scope like 'webhook:%' then interval '30 days' else interval '1 day' end`);
  await client.query("delete from public.error_events where created_at < now() - interval '30 days'");
  await client.query(`delete from public.jobs where (done_at < now() - interval '30 days')
                         or (dead_at < now() - interval '90 days')`);
  await client.query("delete from public.mail_log where sent_at < now() - interval '90 days'");
  await client.query("delete from public.usage_snapshots where taken_at < now() - interval '90 days'");
});

jobs.register('usage.check', async (payload, { deps }) => {
  await usage.checkUsage(deps);
});

// The scheduled jobs, queued by every runner and at most once per period
// (UTC), whatever the number of runners: the day's maintenance and the
// hour's resource check.
async function queueScheduled(db) {
  const now = new Date().toISOString();
  await jobs.enqueueOnce(db, 'maintenance.daily', {}, `maintenance.daily:${now.slice(0, 10)}`);
  await jobs.enqueueOnce(db, 'usage.check', {}, `usage.check:${now.slice(0, 13)}`);
}

module.exports = { queueScheduled };
