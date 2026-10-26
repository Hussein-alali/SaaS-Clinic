'use strict';
// Clinic modules on the data routes (docs/01-PRD.md AT-07, docs/03 "قاعدة
// عامة"): a table, function or file bucket that belongs to a module the
// clinic has not enabled is refused by /api/data, /api/rpc and /api/files
// with 403 module_disabled. The rows and files are kept; enabling the
// module again gives them back.
//
// The same mapping as the clinic menu (src/roles.jsx ROUTE_MODULES). Tables
// without an entry (rosters, branches, settings, staff, campaigns, …) are
// shared by every module and follow RLS only.

const { forbidden } = require('./errors');

const TABLE_MODULES = Object.freeze({
  patients: 'core.patients',
  bookings: 'core.appointments',
  patient_schedules: 'core.appointments',
  patient_files: 'core.files',
  invoices: 'core.billing',
  payments: 'core.billing',
  payment_receipts: 'core.billing',
  packages: 'core.billing',
  patient_subscriptions: 'core.billing',
  sessions: 'physio.sessions',
  treatments: 'physio.treatment_plans',
  treatment_templates: 'physio.templates',
  template_categories: 'physio.templates',
  template_usage: 'physio.templates',
  // Clinical records (0018): the diagnosis is part of every patient file;
  // the tooth chart and prescriptions are their own modules.
  assessments: 'core.patients',
  dental_findings: 'dental.chart',
  prescriptions: 'general.prescriptions',
});

const RPC_MODULES = Object.freeze({
  record_quick_payment: 'core.billing',
  list_invoices_filtered: 'core.billing',
  delete_payment_receipt: 'core.billing',
  create_treatment: 'physio.treatment_plans',
  update_treatment: 'physio.treatment_plans',
  list_treatments: 'physio.treatment_plans',
  get_treatment: 'physio.treatment_plans',
  delete_treatment: 'physio.treatment_plans',
  list_treatment_templates: 'physio.templates',
  get_treatment_template: 'physio.templates',
  create_treatment_template: 'physio.templates',
  update_treatment_template: 'physio.templates',
  duplicate_treatment_template: 'physio.templates',
  set_treatment_template_status: 'physio.templates',
  delete_treatment_template: 'physio.templates',
  apply_template_to_patient: 'physio.templates',
  list_template_categories: 'physio.templates',
  upsert_template_category: 'physio.templates',
  set_template_category_status: 'physio.templates',
  delete_template_category: 'physio.templates',
});

// Storage buckets of /api/files (api/src/files.js BUCKETS).
const BUCKET_MODULES = Object.freeze({
  'patient-files': 'core.files',
});

/**
 * Is `code` enabled for the organization (and active in the catalog — a
 * 'planned' module cannot be used yet)? Read on every call: a module the
 * Super Admin turns off is refused from the next request on.
 */
async function moduleEnabled(db, orgId, code) {
  const { rows } = await db.query(
    `select 1
       from organization_modules om
       join modules m on m.id = om.module_id
      where om.organization_id = $1 and m.code = $2 and om.enabled
        and coalesce(m.status, 'active') = 'active'`,
    [orgId, code],
  );
  return rows.length > 0;
}

/** Throws 403 module_disabled when `code` (if any) is off for this clinic. */
async function assertModule(db, orgId, code) {
  if (!code) return;
  if (!(await moduleEnabled(db, orgId, code))) {
    throw forbidden('module_disabled', `The module ${code} is not enabled for this clinic`);
  }
}

const tableModule = (table) => TABLE_MODULES[table] || null;
const rpcModule = (fn) => RPC_MODULES[fn] || null;
const bucketModule = (bucket) => BUCKET_MODULES[bucket] || null;

module.exports = {
  TABLE_MODULES,
  RPC_MODULES,
  BUCKET_MODULES,
  moduleEnabled,
  assertModule,
  tableModule,
  rpcModule,
  bucketModule,
};
