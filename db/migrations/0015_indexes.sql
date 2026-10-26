-- =====================================================================
-- 0015_indexes.sql — indexes for bounded loading (docs/06 S9).
--
-- The clinic screens no longer read every booking, session, invoice and
-- payment at startup: they read the selected branch from a date onwards
-- (src/supabase.jsx DATA_WINDOW_DAYS) and older rows of one patient, or of
-- one period, on demand (KineticData.listRange).
--
-- RLS alone cannot narrow an index scan to one clinic: tenant_isolation
-- reaches the planner as `app_is_system() OR organization_id =
-- app_org_id()`, and an OR is no index condition. /api/data therefore also
-- sends `organization_id = <current clinic>` (api/src/data-query.js), and
-- these indexes lead with it: (organization_id, branch_id, date |
-- created_at), the startup window of a branch. The «كل الفروع» reports read
-- every branch of the clinic from a date: the same indexes serve them
-- through their leading organization_id.
--
-- Patient history needs no new index: patient ids are unique on the whole
-- platform (patients_pkey is patient_id alone), so the existing patient_id
-- indexes of bookings, sessions, invoices, payments, patient_files and
-- treatments already find exactly one clinic's rows.
--
-- Plain CREATE INDEX (migrate.js runs each file in a transaction, so not
-- CONCURRENTLY): writes to each table wait while its index is built, which
-- takes well under a second at clinic sizes; lock_timeout (5 s) stops the
-- file instead of queueing behind a long transaction.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create index if not exists bookings_org_branch_date_idx    on public.bookings (organization_id, branch_id, date);
create index if not exists sessions_org_branch_date_idx    on public.sessions (organization_id, branch_id, date);
create index if not exists invoices_org_branch_created_idx on public.invoices (organization_id, branch_id, created_at);
create index if not exists payments_org_branch_created_idx on public.payments (organization_id, branch_id, created_at);

