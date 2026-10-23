-- =====================================================================
-- 0004_audit_integrity.sql — audit rows written by clinic members cannot be
-- forged and cannot block other clinics (security review, 22 Oct 2026)
--
-- 0003 lets any member of a clinic INSERT into audit_events (policy
-- "members insert audit"): the RPCs and the API write their audit rows in
-- the caller's context, and src/screens1.jsx writes "patient.edit" rows
-- through /api/data. The policy only checks the organization, so a member
-- could also choose:
--   - id: audit_events.id comes from ONE sequence shared by every clinic.
--     A member inserting rows with the next ids made every later audit
--     write of EVERY clinic fail with 23505 (record_quick_payment,
--     template RPCs, invitations, staff management...) until the sequence
--     passed them: a cross-clinic denial of service (verified: dental's
--     invitations failed after a physio receptionist inserted two rows).
--   - actor_uid / actor_role: rows attributed to another person, another
--     clinic's user or 'super_admin' (verified).
--   - created_at: back-dated rows (verified).
--
-- Outside the system context (app.system = 'on', used only by the API's own
-- platform operations and by seeds) these columns are now set by the
-- database: id from the sequence, actor_uid = auth.uid(), actor_role =
-- app_role(), created_at = now(). organization_id is left to the
-- tenant_isolation policy (a foreign or NULL organization is refused with
-- 42501, as before). Members still cannot UPDATE or DELETE audit rows (no
-- policy allows it).
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create or replace function public.audit_events_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.app_is_system() then
    return new;
  end if;
  -- The column default already took a value; a caller-supplied id is
  -- replaced, so a member can never occupy ids the sequence will hand out.
  new.id         := nextval(pg_get_serial_sequence('public.audit_events', 'id')::regclass);
  new.actor_uid  := auth.uid();
  new.actor_role := public.app_role();
  new.created_at := now();
  return new;
end
$$;

drop trigger if exists audit_events_stamp on public.audit_events;
create trigger audit_events_stamp
  before insert on public.audit_events
  for each row execute function public.audit_events_stamp();
