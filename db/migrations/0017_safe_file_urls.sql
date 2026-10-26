-- =====================================================================
-- 0017_safe_file_urls.sql — file links are http(s) or a path of the site
-- (security audit, 25 Oct 2026; CWE-79).
--
-- patient_files.file_url and payment_receipts.file_url are written by
-- clinic members through /api/data (a therapist may add a patient file, a
-- receptionist may edit one) and opened by another member with
-- window.open / <a href>. A `javascript:` or `data:` value would run script
-- in that member's session — an admin's, for example. The client now opens
-- only http(s) and site paths (safeUrl, src/supabase.jsx); the database
-- refuses anything else, whatever the client.
--
-- Allowed: null, '', 'http(s)://…', '/<path>' (not '//host' or '/\host',
-- which browsers read as another host). NOT VALID: rows already stored are
-- not checked by this migration (expand); every new or changed row is.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

alter table public.patient_files
  add constraint patient_files_file_url_safe
  check (file_url is null or file_url = '' or file_url ~* '^(https?://|/([^/\\]|$))') not valid;

alter table public.payment_receipts
  add constraint payment_receipts_file_url_safe
  check (file_url is null or file_url = '' or file_url ~* '^(https?://|/([^/\\]|$))') not valid;
