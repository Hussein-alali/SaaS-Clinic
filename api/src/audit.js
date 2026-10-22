'use strict';
// audit_events rows for every privileged API operation (docs/02-TRD.md
// "Security and privacy" NFR-007; docs/05-Backend-Schema.md "audit_events").
//
// The row is written with the same client (same transaction) as the change
// it describes, so the change and its audit row commit or roll back
// together. audit_events has FORCE ROW LEVEL SECURITY: the client must be
// either in the system context (platform operations, invitation
// acceptance) or in a member context whose app.org_id equals orgId
// ("members insert audit" + tenant_isolation).

/**
 * writeAudit(client, {orgId, actorUid, actorRole, action, tableName, rowPk,
 *                     targetType, targetId, result, payload})
 *   orgId     the clinic (null = platform event)
 *   action    dotted name: organization.create, invitation.accept, staff.deactivate...
 *   tableName the table that changed (audit_events.table_name is NOT NULL)
 *   result    'success' (default) | 'denied' | 'error'
 */
async function writeAudit(client, a) {
  await client.query(
    `insert into public.audit_events
       (organization_id, actor_uid, actor_role, action, table_name, row_pk, target_type, target_id, result, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      a.orgId || null,
      a.actorUid || null,
      a.actorRole || null,
      a.action,
      a.tableName,
      a.rowPk === undefined || a.rowPk === null ? null : String(a.rowPk),
      a.targetType || null,
      a.targetId === undefined || a.targetId === null ? null : String(a.targetId),
      a.result || 'success',
      a.payload === undefined ? null : JSON.stringify(a.payload),
    ],
  );
}

// Tables whose audit payloads the API itself writes (no patient data).
// GET /api/platform/audit shows the payload only for these: rows written by
// the clinic RPCs (payments, templates...) may carry patient data, which a
// Super Admin must not see (BR-008).
const PLATFORM_AUDIT_TABLES = Object.freeze([
  'organizations',
  'organization_members',
  'organization_modules',
  'invitations',
  'staff',
  'subscriptions',
  'subscription_plans',
  'platform_admins',
  'users',
]);

module.exports = { writeAudit, PLATFORM_AUDIT_TABLES };
