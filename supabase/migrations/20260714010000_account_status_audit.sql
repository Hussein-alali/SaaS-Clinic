-- ═══════════════════════════════════════════════════════════════
-- Migration: staff account status enforcement (2026-07-14)
--
-- Adds admin-driven account activation/deactivation semantics and the
-- server-side enforcement behind them. A deactivated staff account:
--   • cannot sign in (client blocks it; the Auth user is banned so
--     token refresh fails);
--   • loses ALL data access even with a still-valid access token,
--     because public.app_role() returns NULL for a non-active row, so
--     every RLS policy gated on app_role() denies the request;
--   • keeps its row + all historical data intact.
--
-- Admin password reset and status changes run through the
-- admin-reset-password / admin-set-status Edge Functions (service role)
-- and are recorded in audit_events. Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table staff add column if not exists status text default 'active';
update staff set status = 'active' where status is null or status not in ('active','inactive');
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_status_chk'
  ) then
    alter table staff
      add constraint staff_status_chk check (status in ('active','inactive'));
  end if;
end $$;
create index if not exists staff_status_idx on staff(status);

-- app_role() resolves the role ONLY for an ACTIVE staff row.
create or replace function public.app_role() returns text
language plpgsql stable security definer
set search_path = public
as $$
begin
  return (
    select s.role from staff s
    where s.auth_uid = auth.uid()
      and coalesce(s.status, 'active') = 'active'
    limit 1
  );
end $$;

notify pgrst, 'reload schema';
