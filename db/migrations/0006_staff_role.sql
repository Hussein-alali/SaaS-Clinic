-- =====================================================================
-- 0006_staff_role.sql — the 'staff' membership role has a staff.role
-- value (plan task 2.14; docs/05-Backend-Schema.md "organization_members",
-- "Data validation" → «الدور»).
--
-- organization_members.role allows admin | receptionist | doctor |
-- therapist | staff (0002), but 0001's staff_role_check on the staff
-- table has no 'staff', so the staff row of a 'staff' member was written
-- with role NULL (api/src/members.js upsertStaffRow). The CHECK now allows
-- 'staff', and the existing rows of 'staff' members get their role.
--
-- 'staff' still has no data access: app_role() returns 'staff', which no
-- table policy and no RPC role guard lists, and the screens refuse the
-- role at sign-in (src/tenant.jsx). Only the roster value changes.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff
  add constraint staff_role_check
  check (role in ('admin', 'receptionist', 'doctor', 'therapist', 'staff'));

-- Backfill: staff rows linked to a 'staff' membership of the same clinic.
-- staff has FORCE ROW LEVEL SECURITY, so the update runs in the system
-- context (transaction-local: set_config(..., true) ends with this file).
select set_config('app.system', 'on', true);

update public.staff s
   set role = 'staff'
  from public.organization_members m
 where m.organization_id = s.organization_id
   and m.user_id = s.auth_uid
   and m.role = 'staff'
   and s.role is null;

select set_config('app.system', 'off', true);
