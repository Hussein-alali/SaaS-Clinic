'use strict';
// PostgreSQL functions the browser may call through POST /api/rpc/:fn.
// Exactly the names src/*.jsx calls with sb.rpc(...)
// (grep -ohE "\.rpc\(\s*['\"][a-z_0-9]+" src/*.jsx | sort -u).
// Anything else (helpers, triggers, admin-only functions) is refused with 404.
// Add a name here only together with the frontend call that needs it.

const RPC_FUNCTIONS = Object.freeze([
  // billing
  'record_quick_payment',
  'list_invoices_filtered',
  'delete_payment_receipt',
  // treatment methods
  'upsert_treatment_method',
  'delete_treatment_method',
  'set_treatment_method_status',
  // treatment plan templates
  'list_treatment_templates',
  'get_treatment_template',
  'create_treatment_template',
  'update_treatment_template',
  'duplicate_treatment_template',
  'set_treatment_template_status',
  'delete_treatment_template',
  'apply_template_to_patient',
  // template categories
  'list_template_categories',
  'upsert_template_category',
  'set_template_category_status',
  'delete_template_category',
  // patient treatments
  'create_treatment',
  'update_treatment',
  'list_treatments',
  'get_treatment',
  'delete_treatment',
]);

const RPC_WHITELIST = new Set(RPC_FUNCTIONS);

module.exports = { RPC_FUNCTIONS, RPC_WHITELIST };
