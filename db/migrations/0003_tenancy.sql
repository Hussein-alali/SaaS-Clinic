-- =====================================================================
-- 0003_tenancy.sql — multi-clinic tenancy, branches and row-level security
-- (plan task 2.4; docs/05-Backend-Schema.md conventions 3-12,
-- "Authorization rules", "Migration and seed data" item 3)
--
--  1. Request-context functions (convention 3) and authorization helpers:
--     app_org_id(), app_branch_id(), app_is_system(), is_super_admin(),
--     app_role() (redefined: reads organization_members, convention 7),
--     can_access_branch(text), org_module_enabled(text).
--  2. organization_id on every clinic table, branch_id on the seven
--     branch-scoped tables (conventions 5 and 8); branches.working_hours /
--     status; audit_events.target_type / target_id / result.
--  3. Existing single-clinic data: moved into the first organization
--     ('clinic', physio, active, plan 'default') and its main branch; staff
--     rows linked to an account become organization_members. A fresh
--     database has no such data: the default clinic_settings row is removed
--     instead (settings rows are created per organization).
--  4. NOT NULL + DEFAULT app_org_id() / app_branch_id().
--  5. Organization-scoped unique constraints (convention 9), clinic_settings
--     per organization (convention 11), composite foreign keys that keep
--     every reference inside one organization ("Relationships").
--  6. Plan-limit triggers (SQLSTATE PL422): branches and users.
--  7. Write policies for the tables that only RPCs write (convention 12);
--     audit_events written by members of the clinic.
--  8. RPC fixes: _tpl_snapshot() restored, global rows read-only in three
--     RPCs, and the two upsert RPCs that never inserted.
--  9. ENABLE + FORCE ROW LEVEL SECURITY with the RESTRICTIVE policies
--     tenant_isolation (convention 6) and branch_scope (convention 8), and
--     a permissive system_access policy for app.system = 'on'.
-- 10. Self-check: the migration fails if a clinic table is left without
--     tenancy or a unique index is not organization-scoped.
--
-- Clinic tables (25): every public table except the platform/identity
-- tables of 0002 and schema_migrations. The treatment-template tables
-- (template_categories, treatment_templates, template_usage,
-- treatment_methods; template_versions no longer exists) allow
-- organization_id NULL = a global, read-only row: the template library
-- seeded by 0001 becomes global. audit_events.organization_id is NULL for
-- platform operations.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction. Data is moved before RLS is forced (section 9): after that,
-- the owner running this file is itself subject to the policies.
-- =====================================================================


-- =====================================================================
-- 1. Request context and authorization helpers
-- =====================================================================
-- The API sets these with set_config(..., true) in every transaction
-- (empty string = not set).

create or replace function public.app_org_id()
returns uuid
language sql stable
set search_path = public
as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function public.app_branch_id()
returns text
language sql stable
set search_path = public
as $$
  select nullif(current_setting('app.branch_id', true), '')
$$;

-- app.system = 'on' only for internal API operations (creating clinics,
-- accepting invitations, platform audit...). Never derived from a request.
create or replace function public.app_is_system()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- A row in platform_admins for auth.uid() (and the account is active).
create or replace function public.is_super_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.platform_admins pa
      join auth.users u on u.id = pa.user_id
     where pa.user_id = auth.uid()
       and u.status = 'active')
$$;

-- Convention 7: the role of auth.uid() in the current organization, only
-- when the membership is active, the organization is active (and the
-- account is active); otherwise NULL. Reads platform tables only (they have
-- no RLS), so it can be used by the policies of every clinic table,
-- staff included, without recursion. Replaces the 0001 version that read
-- staff (which recursed once staff has FORCE ROW LEVEL SECURITY).
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select m.role
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    join auth.users u on u.id = m.user_id
   where m.user_id = auth.uid()
     and m.organization_id = public.app_org_id()
     and m.status = 'active'
     and o.status = 'active'
     and u.status = 'active'
$$;

-- Convention 8: admin -> every branch of the current organization;
-- other roles -> their member_branches rows; no role -> nothing.
create or replace function public.can_access_branch(p_branch_id text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_branch_id is not null and coalesce((
    select r.role = 'admin' or exists (
             select 1
               from public.member_branches mb
               join public.organization_members m on m.id = mb.member_id
              where mb.branch_id = p_branch_id
                and mb.organization_id = public.app_org_id()
                and m.organization_id = public.app_org_id()
                and m.user_id = auth.uid()
                and m.status = 'active')
      from (select public.app_role() as role) r
     where r.role is not null), false)
$$;

-- The module is enabled for the current organization and active in the
-- catalog ('planned' modules cannot be used yet).
create or replace function public.org_module_enabled(p_code text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.organization_modules om
      join public.modules m on m.id = om.module_id
     where om.organization_id = public.app_org_id()
       and m.code = p_code
       and om.enabled
       and m.status = 'active')
$$;


-- =====================================================================
-- 2. New columns (nullable for now; filled in section 3)
-- =====================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'audit_events', 'bookings', 'branches', 'campaigns', 'clinic_settings',
    'custom_sections', 'departments', 'doctors', 'invoices', 'packages',
    'patient_files', 'patient_schedules', 'patient_subscriptions', 'patients',
    'payment_receipts', 'payments', 'receptionists', 'sessions', 'staff',
    'template_categories', 'template_usage', 'therapists', 'treatment_methods',
    'treatment_templates', 'treatments'
  ] loop
    execute format(
      'alter table public.%I add column organization_id uuid references public.organizations (id)', t);
  end loop;

  foreach t in array array[
    'bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
    'patient_schedules', 'treatments'
  ] loop
    execute format('alter table public.%I add column branch_id text', t);
  end loop;
end
$$;

-- branches (Schema "Tables"): working hours and an active/inactive status
-- (branches are deactivated, not deleted). The therapists column stays for
-- now: src/supabase.jsx still writes it.
alter table public.branches
  add column working_hours jsonb,
  add column status text not null default 'active',
  add constraint branches_status_check check (status in ('active', 'inactive'));

-- audit_events (Schema "Tables"): who/what/result of platform and clinic
-- operations. result defaults to 'success' (the RPCs write their audit row
-- only after the change succeeded).
alter table public.audit_events
  add column target_type text,
  add column target_id   text,
  add column result      text default 'success',
  add constraint audit_events_result_check check (result is null or result in ('success', 'denied', 'error'));


-- =====================================================================
-- 3. Existing data -> the first organization, or a clean start
-- =====================================================================
-- "Existing data" = any row in a clinic table other than what 0001 seeds:
-- the clinic_settings row (id = 1) and the global template library
-- (TM-DFLT-* methods, TPC-SEED-* categories, TPL-SEED-* templates).

do $$
declare
  t          text;
  v_found    boolean := false;
  v_org      uuid;
  v_branch   text;
  v_creator  uuid;
  v_name     text;
  v_specialty uuid;
  v_plan     uuid;
  v_members  int;
begin
  foreach t in array array[
    'audit_events', 'bookings', 'branches', 'campaigns', 'custom_sections',
    'departments', 'doctors', 'invoices', 'packages', 'patient_files',
    'patient_schedules', 'patient_subscriptions', 'patients', 'payment_receipts',
    'payments', 'receptionists', 'sessions', 'staff', 'template_usage',
    'therapists', 'treatments'
  ] loop
    execute format('select exists (select 1 from public.%I)', t) into v_found;
    exit when v_found;
  end loop;
  v_found := v_found
    or exists (select 1 from public.template_categories where category_id not like 'TPC-SEED-%')
    or exists (select 1 from public.treatment_methods   where method_id   not like 'TM-DFLT-%')
    or exists (select 1 from public.treatment_templates where template_id not like 'TPL-SEED-%');

  if not v_found then
    -- Fresh database: settings rows are created per organization.
    delete from public.clinic_settings;
    raise notice '0003_tenancy: no existing clinic data; removed the default clinic_settings row';
    return;
  end if;

  -- ---- the first organization ------------------------------------------
  select id into v_specialty from public.specialties where code = 'physio';
  select id into v_plan from public.subscription_plans where code = 'default';
  select left(btrim(name), 120) into v_name from public.clinic_settings order by id limit 1;
  if v_name is null or char_length(v_name) < 2 then
    v_name := 'العيادة';
  end if;

  -- created_by: the clinic's admin account, else the oldest account, else a
  -- disabled placeholder account (organizations.created_by is NOT NULL).
  select s.auth_uid into v_creator
    from public.staff s
    join auth.users u on u.id = s.auth_uid
   where s.role = 'admin'
   order by (coalesce(s.status, 'active') = 'active') desc, s.created_at nulls last, s.staff_id
   limit 1;
  if v_creator is null then
    select id into v_creator from auth.users order by created_at, id limit 1;
  end if;
  if v_creator is null then
    insert into auth.users (email, status, raw_user_meta_data)
    values ('migration@clinicsys.invalid', 'disabled', '{"name": "0003_tenancy"}')
    returning id into v_creator;
  end if;

  insert into public.organizations (name, slug, primary_specialty_id, status, plan_id, created_by)
  values (v_name, 'clinic', v_specialty, 'active', v_plan, v_creator)
  returning id into v_org;

  -- ---- branches: existing ones + the main branch ------------------------
  update public.branches set organization_id = v_org;
  -- unique (organization_id, name) comes in section 5: make names unique.
  update public.branches b
     set name = left(b.name, 90) || ' (' || b.id || ')'
   where exists (select 1 from public.branches b2 where b2.name = b.name and b2.id < b.id);

  select id into v_branch
    from public.branches
   where name = 'الفرع الرئيسي'
   order by created_at nulls last, id
   limit 1;
  if v_branch is null then
    v_branch := 'br_main_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
    insert into public.branches (id, organization_id, name, status)
    values (v_branch, v_org, 'الفرع الرئيسي', 'active');
  end if;

  -- ---- every clinic row -> the organization (templates: own rows only) --
  foreach t in array array[
    'audit_events', 'bookings', 'campaigns', 'clinic_settings', 'custom_sections',
    'departments', 'doctors', 'invoices', 'packages', 'patient_files',
    'patient_schedules', 'patient_subscriptions', 'patients', 'payment_receipts',
    'payments', 'receptionists', 'sessions', 'staff', 'template_usage',
    'therapists', 'treatments'
  ] loop
    execute format('update public.%I set organization_id = $1', t) using v_org;
  end loop;
  update public.template_categories set organization_id = v_org where category_id not like 'TPC-SEED-%';
  update public.treatment_methods   set organization_id = v_org where method_id   not like 'TM-DFLT-%';
  update public.treatment_templates set organization_id = v_org where template_id not like 'TPL-SEED-%';

  if not exists (select 1 from public.clinic_settings) then
    insert into public.clinic_settings (organization_id, id, name) values (v_org, 1, v_name);
  end if;

  -- ---- branch-scoped rows -> the main branch ----------------------------
  foreach t in array array[
    'bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
    'patient_schedules', 'treatments'
  ] loop
    execute format('update public.%I set branch_id = $1', t) using v_branch;
  end loop;

  -- ---- staff linked to an account -> organization_members ---------------
  -- One membership per account (an account with several staff rows keeps
  -- its active / admin row). Non-admin members get the main branch;
  -- admins need no member_branches rows (every branch).
  insert into public.organization_members (organization_id, user_id, role, status, joined_at, created_at)
  select distinct on (s.auth_uid)
         v_org, s.auth_uid, coalesce(s.role, 'staff'),
         case when coalesce(s.status, 'active') = 'active' then 'active' else 'disabled' end,
         s.created_at, coalesce(s.created_at, now())
    from public.staff s
    join auth.users u on u.id = s.auth_uid
   order by s.auth_uid,
            (coalesce(s.status, 'active') = 'active') desc,
            (s.role = 'admin') desc nulls last,
            s.created_at nulls last, s.staff_id;
  get diagnostics v_members = row_count;

  insert into public.member_branches (member_id, branch_id, organization_id)
  select m.id, v_branch, v_org
    from public.organization_members m
   where m.organization_id = v_org and m.role <> 'admin';

  -- ---- modules (specialty defaults) and the subscription ----------------
  insert into public.organization_modules (organization_id, module_id, enabled)
  select v_org, sm.module_id, m.status = 'active'
    from public.specialty_modules sm
    join public.modules m on m.id = sm.module_id
   where sm.specialty_id = v_specialty;

  insert into public.subscriptions (organization_id, plan_id, status, period_start, notes)
  values (v_org, v_plan, 'active', current_date, 'created by 0003_tenancy from the existing single-clinic data');

  raise notice '0003_tenancy: existing data moved to organization "clinic" (%), main branch %, % member(s)',
    v_org, v_branch, v_members;
end
$$;


-- =====================================================================
-- 4. NOT NULL + defaults (conventions 5 and 8)
-- =====================================================================

do $$
declare
  t text;
begin
  -- organization_id NOT NULL on every clinic table except the template
  -- tables (NULL = global row) and audit_events (NULL = platform event).
  foreach t in array array[
    'bookings', 'branches', 'campaigns', 'clinic_settings', 'custom_sections',
    'departments', 'doctors', 'invoices', 'packages', 'patient_files',
    'patient_schedules', 'patient_subscriptions', 'patients', 'payment_receipts',
    'payments', 'receptionists', 'sessions', 'staff', 'therapists', 'treatments'
  ] loop
    execute format(
      'alter table public.%I alter column organization_id set default public.app_org_id(),
                             alter column organization_id set not null', t);
  end loop;

  foreach t in array array[
    'audit_events', 'template_categories', 'template_usage', 'treatment_methods', 'treatment_templates'
  ] loop
    execute format('alter table public.%I alter column organization_id set default public.app_org_id()', t);
  end loop;

  foreach t in array array[
    'bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
    'patient_schedules', 'treatments'
  ] loop
    execute format(
      'alter table public.%I alter column branch_id set default public.app_branch_id(),
                             alter column branch_id set not null', t);
  end loop;
end
$$;


-- =====================================================================
-- 5. Keys, organization-scoped uniques, composite foreign keys, indexes
-- =====================================================================

-- unique (organization_id, <primary key>) on every clinic table with a
-- single-column text key: the organization index (convention 5) and the
-- target of the composite foreign keys below. The primary keys themselves
-- stay single-column and globally unique (convention 10).
do $$
declare
  r record;
begin
  for r in
    select c.relname as tbl, a.attname as pk
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
     where c.relnamespace = 'public'::regnamespace
       and i.indisprimary and i.indnatts = 1
       and c.relname = any (array[
         'bookings', 'branches', 'campaigns', 'custom_sections', 'departments',
         'doctors', 'invoices', 'packages', 'patient_files', 'patient_schedules',
         'patient_subscriptions', 'patients', 'payment_receipts', 'payments',
         'receptionists', 'sessions', 'staff', 'template_categories',
         'template_usage', 'therapists', 'treatment_methods',
         'treatment_templates', 'treatments'])
  loop
    execute format('alter table public.%I add constraint %I unique (organization_id, %I)',
                   r.tbl, r.tbl || '_org_key', r.pk);
  end loop;
end
$$;

-- Convention 11: one settings row per organization, id stays 1.
alter table public.clinic_settings
  drop constraint clinic_settings_pkey,
  add constraint clinic_settings_pkey primary key (organization_id, id);

-- Convention 9: every UNIQUE becomes (organization_id, ...).
alter table public.custom_sections
  drop constraint custom_sections_slug_key,
  add constraint custom_sections_org_slug_key unique (organization_id, slug);

alter table public.payments
  drop constraint payments_receipt_no_key,
  add constraint payments_org_receipt_no_key unique (organization_id, receipt_no);

alter table public.staff drop constraint staff_email_key;
drop index public.staff_email_lower_uniq;
create unique index staff_org_email_lower_uniq on public.staff (organization_id, lower(email))
  where email is not null and email <> '';

drop index public.patients_national_id_uniq;
create unique index patients_org_national_id_uniq on public.patients (organization_id, national_id)
  where national_id is not null and national_id <> '';

drop index public.patients_medical_file_uniq;
create unique index patients_org_medical_file_uniq on public.patients (organization_id, medical_file_no)
  where medical_file_no is not null and medical_file_no <> '';

drop index public.patient_files_storage_path_uniq;
alter table public.patient_files
  add constraint patient_files_org_storage_path_key unique (organization_id, storage_path);

alter table public.branches
  add constraint branches_org_name_key unique (organization_id, name);

-- Template tables: unique per organization, and unique among the global
-- rows (organization_id IS NULL, which a plain unique would not cover).
alter table public.treatment_methods drop constraint treatment_methods_name_key;
drop index public.treatment_methods_name_uidx;
alter table public.treatment_methods
  add constraint treatment_methods_org_name_key unique (organization_id, name);
create unique index treatment_methods_global_name_key on public.treatment_methods (name)
  where organization_id is null;

drop index public.tpl_cat_name_uniq;
create unique index tpl_cat_org_name_uniq on public.template_categories (organization_id, lower(btrim(name)));
create unique index tpl_cat_global_name_uniq on public.template_categories (lower(btrim(name)))
  where organization_id is null;

-- audit_events (Schema "Tables").
create index audit_events_org_created_idx on public.audit_events (organization_id, created_at desc);
create index audit_events_actor_created_idx on public.audit_events (actor_uid, created_at desc);

-- Branch-scoped tables: the branch belongs to the same organization
-- (composite FK; branches are deactivated, not deleted) + index.
do $$
declare
  t text;
begin
  foreach t in array array[
    'bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
    'patient_schedules', 'treatments'
  ] loop
    execute format(
      'alter table public.%I add constraint %I foreign key (organization_id, branch_id)
         references public.branches (organization_id, id)', t, t || '_branch_fkey');
    execute format('create index %I on public.%I (organization_id, branch_id)', t || '_org_branch_idx', t);
  end loop;
end
$$;

-- member_branches: the branch is in the member's organization.
alter table public.member_branches
  drop constraint member_branches_branch_id_fkey,
  add constraint member_branches_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete cascade;

-- "Relationships": a reference between clinic tables stays inside one
-- organization. ON DELETE CASCADE keys become composite keys (same names).
alter table public.bookings
  drop constraint bookings_patient_id_fkey,
  add constraint bookings_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.invoices
  drop constraint invoices_patient_id_fkey,
  add constraint invoices_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.patient_files
  drop constraint patient_files_patient_id_fkey,
  add constraint patient_files_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.patient_schedules
  drop constraint patient_schedules_patient_id_fkey,
  add constraint patient_schedules_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.payment_receipts
  drop constraint payment_receipts_patient_id_fkey,
  add constraint payment_receipts_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.payment_receipts
  drop constraint payment_receipts_payment_id_fkey,
  add constraint payment_receipts_payment_id_fkey foreign key (organization_id, payment_id)
    references public.payments (organization_id, payment_id) on delete cascade;
alter table public.payments
  drop constraint payments_patient_id_fkey,
  add constraint payments_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.sessions
  drop constraint sessions_patient_id_fkey,
  add constraint sessions_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;
alter table public.treatments
  drop constraint treatments_patient_id_fkey,
  add constraint treatments_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade;

-- ON DELETE SET NULL keys: a composite SET NULL would also null
-- organization_id (SET NULL (column) needs PostgreSQL 15), so the original
-- single-column key keeps doing the SET NULL and a second, composite key
-- checks the organization. It is DEFERRABLE INITIALLY DEFERRED so that it
-- runs at commit, after the SET NULL action has cleared the references
-- (an immediate NO ACTION check could run before it and fail the delete).
alter table public.bookings add constraint bookings_department_org_fkey
  foreign key (organization_id, department_id) references public.departments (organization_id, id)
  deferrable initially deferred;
alter table public.bookings add constraint bookings_doctor_org_fkey
  foreign key (organization_id, doctor_id) references public.doctors (organization_id, id)
  deferrable initially deferred;
alter table public.bookings add constraint bookings_therapist_org_fkey
  foreign key (organization_id, therapist_id) references public.therapists (organization_id, id)
  deferrable initially deferred;
alter table public.doctors add constraint doctors_department_org_fkey
  foreign key (organization_id, department_id) references public.departments (organization_id, id)
  deferrable initially deferred;
alter table public.patients add constraint patients_therapist_org_fkey
  foreign key (organization_id, therapist_id) references public.therapists (organization_id, id)
  deferrable initially deferred;
alter table public.payment_receipts add constraint payment_receipts_invoice_org_fkey
  foreign key (organization_id, invoice_id) references public.invoices (organization_id, invoice_id)
  deferrable initially deferred;
alter table public.sessions add constraint sessions_booking_org_fkey
  foreign key (organization_id, booking_id) references public.bookings (organization_id, booking_id)
  deferrable initially deferred;
alter table public.sessions add constraint sessions_therapist_org_fkey
  foreign key (organization_id, therapist_id) references public.therapists (organization_id, id)
  deferrable initially deferred;
alter table public.sessions add constraint sessions_treatment_org_fkey
  foreign key (organization_id, treatment_id) references public.treatments (organization_id, treatment_id)
  deferrable initially deferred;
alter table public.therapists add constraint therapists_department_org_fkey
  foreign key (organization_id, department_id) references public.departments (organization_id, id)
  deferrable initially deferred;

-- treatments.template_id and template_usage.template_id may point at a
-- global template (organization_id NULL), which a composite key cannot
-- express: the single-column keys stay, and this trigger checks that the
-- template is global or belongs to the row's organization. It is an AFTER
-- trigger, so row-level security is checked first.
create or replace function public.check_template_organization()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.template_id is null then
    return null;
  end if;
  if not exists (
    select 1 from public.treatment_templates t
     where t.template_id = new.template_id
       and (t.organization_id is null or t.organization_id = new.organization_id)) then
    raise exception using
      errcode = '23503',
      message = format('template %s is not available to this organization', new.template_id),
      detail  = format('%s.template_id must reference a global template or one of the same organization', tg_table_name);
  end if;
  return null;
end
$$;

create trigger treatments_template_organization
  after insert or update of template_id, organization_id on public.treatments
  for each row execute function public.check_template_organization();
create trigger template_usage_template_organization
  after insert or update of template_id, organization_id on public.template_usage
  for each row execute function public.check_template_organization();


-- =====================================================================
-- 6. Plan limits (Schema "Data validation"): SQLSTATE PL422
-- =====================================================================
-- NULL limit (or no plan) = unlimited. An advisory lock per organization
-- serializes concurrent checks. The counts run under the caller's RLS
-- context; branches are only written by the clinic admin (who sees every
-- branch of the clinic) or by the system context.

create or replace function public.enforce_branch_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_max   int;
  v_count int;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.organization_id = new.organization_id then
    return new;
  end if;

  select p.max_branches into v_max
    from public.organizations o
    join public.subscription_plans p on p.id = o.plan_id
   where o.id = new.organization_id;
  if v_max is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('clinicsys.plan_limit'), hashtext(new.organization_id::text));
  select count(*) into v_count
    from public.branches b
   where b.organization_id = new.organization_id
     and b.status = 'active'
     and b.id <> new.id;
  if v_count + 1 > v_max then
    raise exception using
      errcode = 'PL422',
      message = 'plan_limit:branches',
      detail  = format('the plan allows %s active branch(es); the organization already has %s', v_max, v_count);
  end if;
  return new;
end
$$;

create trigger branches_plan_limit
  before insert or update of status, organization_id on public.branches
  for each row execute function public.enforce_branch_limit();

-- Users = active memberships. A pending (unexpired) invitation reserves a
-- seat: creating one checks active members + pending invitations;
-- activating a membership checks active members only (its own invitation
-- is still pending while it is being accepted).
create or replace function public.enforce_user_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_max     int;
  v_active  int;
  v_pending int := 0;
begin
  if tg_table_name = 'organization_members' then
    if new.status <> 'active' then
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = 'active' and old.organization_id = new.organization_id then
      return new;
    end if;
  else -- invitations
    if new.status <> 'pending' or new.expires_at <= now() then
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = 'pending' and old.organization_id = new.organization_id then
      return new;
    end if;
  end if;

  select p.max_users into v_max
    from public.organizations o
    join public.subscription_plans p on p.id = o.plan_id
   where o.id = new.organization_id;
  if v_max is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('clinicsys.plan_limit'), hashtext(new.organization_id::text));
  select count(*) into v_active
    from public.organization_members m
   where m.organization_id = new.organization_id
     and m.status = 'active'
     and (tg_table_name <> 'organization_members' or m.id <> new.id);
  if tg_table_name = 'invitations' then
    select count(*) into v_pending
      from public.invitations i
     where i.organization_id = new.organization_id
       and i.status = 'pending'
       and i.expires_at > now()
       and i.id <> new.id;
  end if;

  if v_active + v_pending + 1 > v_max then
    raise exception using
      errcode = 'PL422',
      message = 'plan_limit:users',
      detail  = format('the plan allows %s user(s); active members: %s, pending invitations: %s',
                       v_max, v_active, v_pending);
  end if;
  return new;
end
$$;

create trigger organization_members_plan_limit
  before insert or update of status, organization_id on public.organization_members
  for each row execute function public.enforce_user_limit();
create trigger invitations_plan_limit
  before insert or update of status, organization_id, expires_at on public.invitations
  for each row execute function public.enforce_user_limit();


-- =====================================================================
-- 7. Role policies for writes that the RPCs make (convention 12)
-- =====================================================================
-- In Supabase the security-definer RPCs ran as a role that bypassed RLS,
-- so these tables had read policies only ("writes go through RPCs"). Here
-- they run as the table owner under FORCE ROW LEVEL SECURITY, i.e. with
-- the caller's permissions, so each table needs a write policy for the
-- roles that the RPC itself admits.

-- create_treatment / update_treatment (admin, doctor, therapist),
-- delete_treatment (admin, doctor), and the sessions trigger
-- sync_treatment_session_count (admin, therapist write sessions).
create policy "clinical insert treatments" on public.treatments for insert
  with check (public.app_role() in ('admin', 'doctor', 'therapist'));
create policy "clinical update treatments" on public.treatments for update
  using (public.app_role() in ('admin', 'doctor', 'therapist'))
  with check (public.app_role() in ('admin', 'doctor', 'therapist'));
create policy "admin/doctor delete treatments" on public.treatments for delete
  using (public.app_role() in ('admin', 'doctor'));

-- upsert_template_category / set_template_category_status /
-- delete_template_category (admin, doctor).
create policy "admin/doctor write tpl categories" on public.template_categories for all
  using (public.app_role() in ('admin', 'doctor'))
  with check (public.app_role() in ('admin', 'doctor'));

-- apply_template_to_patient / create_treatment (admin, doctor, therapist).
create policy "clinical insert usage" on public.template_usage for insert
  with check (public.app_role() in ('admin', 'doctor', 'therapist'));

-- delete_treatment_method admits admin and doctor; 0001 lets only the
-- admin delete rows.
create policy "doctor delete tx methods" on public.treatment_methods for delete
  using (public.app_role() = 'doctor');

-- audit_events: any member of the current clinic may write (the RPCs and
-- the API do); the system context writes platform events (section 9).
-- Replaces 0001's "system insert audit" (WITH CHECK true).
drop policy "system insert audit" on public.audit_events;
create policy "members insert audit" on public.audit_events for insert
  with check (public.app_role() is not null);


-- =====================================================================
-- 8. RPC fixes under tenant context
-- =====================================================================

-- update_treatment_template() calls _tpl_snapshot(), which 0001 (like
-- Supabase_All_In_One.sql) drops in its section 13, so the RPC failed with
-- "function public._tpl_snapshot(text) does not exist". Restored as it was.
create or replace function public._tpl_snapshot(p_template_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(t.*) from treatment_templates t where t.template_id = p_template_id
$$;

-- Global templates/categories are readable but not writable: the UPDATE
-- or DELETE affects no row. These three RPCs ignored that and reported
-- success; they now raise instead. Otherwise unchanged from 0001.
create or replace function public.update_treatment_template(p_template_id text, p_payload jsonb, p_change_summary text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((p_payload->>'updated_by_name'),'');
  v_old  jsonb;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — التعديل مقتصر على المدير والطبيب';
  end if;
  v_old := public._tpl_snapshot(p_template_id);
  if v_old is null then raise exception 'القالب غير موجود'; end if;

  update treatment_templates set
    name                   = coalesce(nullif(btrim(p_payload->>'name'),''), name),
    category               = coalesce(nullif(p_payload->>'category',''), category),
    diagnosis              = coalesce(nullif(p_payload->>'diagnosis',''), diagnosis),
    body_part              = coalesce(nullif(p_payload->>'body_part',''), body_part),
    goals                  = coalesce(p_payload->'goals', goals),
    exercises              = coalesce(p_payload->'exercises', exercises),
    methods                = coalesce(p_payload->'methods', methods),
    home_instructions      = coalesce(nullif(p_payload->>'home_instructions',''), home_instructions),
    notes                  = coalesce(nullif(p_payload->>'notes',''), notes),
    warnings               = coalesce(nullif(p_payload->>'warnings',''), warnings),
    followup_instructions  = coalesce(nullif(p_payload->>'followup_instructions',''), followup_instructions),
    estimated_sessions     = coalesce(nullif(p_payload->>'estimated_sessions','')::int, estimated_sessions),
    weekly_frequency       = coalesce(nullif(p_payload->>'weekly_frequency','')::int, weekly_frequency),
    expected_recovery_days = coalesce(nullif(p_payload->>'expected_recovery_days','')::int, expected_recovery_days),
    updated_by             = v_uid,
    updated_by_name        = v_name,
    updated_at             = now()
    where template_id = p_template_id;
  -- [0003] a global template (or one hidden by RLS) is not updated.
  if not found then raise exception 'لا يمكن تعديل هذا القالب (قالب عام للقراءة فقط)'; end if;

  perform public._tpl_write_version(p_template_id, v_uid, v_name, coalesce(p_change_summary,'تعديل'));

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_update', 'treatment_templates', p_template_id,
    jsonb_build_object('old', v_old, 'new', p_payload, 'summary', p_change_summary));

  return jsonb_build_object('template_id', p_template_id);
end;
$function$;

create or replace function public.delete_treatment_template(p_template_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_uses int;
  v_row  treatment_templates%rowtype;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_templates where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  select count(*)::int into v_uses from template_usage where template_id = p_template_id;
  if v_uses > 0 or coalesce(v_row.usage_count,0) > 0 then
    raise exception 'لا يمكن حذف قالب مستخدم — استخدم الأرشفة بدلاً منه';
  end if;

  delete from treatment_templates where template_id = p_template_id;
  -- [0003] a global template (or one hidden by RLS) is not deleted.
  if not found then raise exception 'لا يمكن حذف هذا القالب (قالب عام للقراءة فقط)'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_delete', 'treatment_templates', p_template_id,
    to_jsonb(v_row));

  return jsonb_build_object('template_id', p_template_id, 'deleted', true);
end;
$function$;

create or replace function public.delete_template_category(p_category_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_cat  template_categories%rowtype;
  v_used int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية حذف الفئات';
  end if;
  select * into v_cat from template_categories where category_id = p_category_id;
  if not found then raise exception 'الفئة غير موجودة'; end if;
  select count(*) into v_used from treatment_templates where category = v_cat.name;
  if v_used > 0 then
    raise exception 'لا يمكن حذف الفئة — يستخدمها % قالب. أعد تصنيف القوالب أو أرشِف الفئة بدلًا من حذفها.', v_used;
  end if;
  delete from template_categories where category_id = p_category_id;
  -- [0003] a global category (or one hidden by RLS) is not deleted.
  if not found then raise exception 'لا يمكن حذف هذه الفئة (فئة عامة للقراءة فقط)'; end if;
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tpl_cat_delete', 'template_categories', p_category_id, to_jsonb(v_cat));
  return jsonb_build_object('category_id', p_category_id, 'deleted', true);
end;
$function$;


-- upsert_template_category() and upsert_treatment_method() decided between
-- UPDATE and INSERT with `if found` after `select count(*) into v_dup`,
-- which always sets FOUND: a new category / method was never inserted (the
-- RPC reported success). Pre-existing in Supabase_All_In_One.sql. The
-- result of the row lookup is now kept in v_exists. Otherwise unchanged.
create or replace function public.upsert_template_category(p_category_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_id   text := p_category_id;
  v_old  template_categories%rowtype;
  v_dup  int;
  v_action text;
  v_exists boolean;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة الفئات';
  end if;
  if v_name = '' then raise exception 'اسم الفئة مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TPC-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from template_categories where category_id = v_id for update;
  v_exists := found; -- [0003]
  v_action := case when v_exists then 'tpl_cat_update' else 'tpl_cat_create' end;

  select count(*) into v_dup from template_categories
    where lower(trim(name)) = lower(v_name) and category_id <> v_id;
  if v_dup > 0 then raise exception 'اسم الفئة موجود مسبقًا'; end if;

  if v_exists then
    -- Renaming? Propagate to any templates using the old name so their
    -- category field stays consistent with the authoritative label.
    if v_old.name is distinct from v_name then
      update treatment_templates set category = v_name
        where category = v_old.name;
    end if;
    update template_categories set
      name        = v_name,
      description = nullif(btrim(coalesce(p_payload->>'description','')),''),
      sort_order  = nullif(p_payload->>'sort_order','')::int,
      updated_at  = now()
      where category_id = v_id;
  else
    insert into template_categories (
      category_id, name, description, sort_order,
      status, created_by, created_by_name
    ) values (
      v_id, v_name,
      nullif(btrim(coalesce(p_payload->>'description','')),''),
      nullif(p_payload->>'sort_order','')::int,
      'active', v_uid,
      (select name from staff where auth_uid = v_uid limit 1)
    );
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, v_action, 'template_categories', v_id,
    jsonb_build_object('old', to_jsonb(v_old), 'new', p_payload));

  return jsonb_build_object('category_id', v_id, 'name', v_name);
end;
$function$;

create or replace function public.upsert_treatment_method(p_method_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_payload->>'name',''));
  v_id     text := p_method_id;
  v_old    treatment_methods%rowtype;
  v_dup    int;
  v_action text;
  v_exists boolean;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة طرق العلاج';
  end if;
  if v_name = '' then raise exception 'اسم طريقة العلاج مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TM-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from treatment_methods where method_id = v_id for update;
  v_exists := found; -- [0003]
  v_action := case when v_exists then 'tx_method_update' else 'tx_method_create' end;

  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_name) and method_id <> v_id;
  if v_dup > 0 then raise exception 'اسم طريقة العلاج موجود مسبقًا'; end if;

  if v_exists then
    update treatment_methods set
      name             = v_name,
      category         = nullif(btrim(coalesce(p_payload->>'category','')),''),
      description      = nullif(btrim(coalesce(p_payload->>'description','')),''),
      duration_minutes = nullif(p_payload->>'duration_minutes','')::int,
      notes            = nullif(btrim(coalesce(p_payload->>'notes','')),''),
      icon             = nullif(btrim(coalesce(p_payload->>'icon','')),''),
      color            = nullif(btrim(coalesce(p_payload->>'color','')),''),
      display_order    = nullif(p_payload->>'display_order','')::int,
      status           = case when coalesce(p_payload->>'is_active','true')='false'
                                then 'archived' else coalesce(status,'active') end,
      updated_at       = now()
      where method_id  = v_id;
  else
    insert into treatment_methods (
      method_id, name, category, description, duration_minutes, notes,
      icon, color, display_order, status, created_by, created_by_name
    ) values (
      v_id, v_name,
      nullif(btrim(coalesce(p_payload->>'category','')),''),
      nullif(btrim(coalesce(p_payload->>'description','')),''),
      nullif(p_payload->>'duration_minutes','')::int,
      nullif(btrim(coalesce(p_payload->>'notes','')),''),
      nullif(btrim(coalesce(p_payload->>'icon','')),''),
      nullif(btrim(coalesce(p_payload->>'color','')),''),
      nullif(p_payload->>'display_order','')::int,
      case when coalesce(p_payload->>'is_active','true')='false' then 'archived' else 'active' end,
      v_uid,
      (select name from staff where auth_uid = v_uid limit 1)
    );
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, v_action, 'treatment_methods', v_id,
    jsonb_build_object('old', to_jsonb(v_old), 'new', p_payload));

  return jsonb_build_object('method_id', v_id, 'name', v_name);
end;
$function$;


-- =====================================================================
-- 9. Row-level security: ENABLE + FORCE, tenant_isolation, branch_scope
-- =====================================================================
-- The API connects as the table owner; without FORCE the owner bypasses
-- every policy (convention 4). The 0001 role policies stay as they are and
-- are ANDed with the RESTRICTIVE policies below; they work per clinic
-- because app_role() now returns the role in the current organization.
--
-- system_access (permissive) lets the system context (app.system = 'on')
-- through the role policies as well: tenant_isolation admits it, but under
-- FORCE a row also needs one permissive policy, and the role policies need
-- a role the system context does not have.

do $$
declare
  t text;
begin
  -- Clinic tables whose rows always belong to one organization.
  foreach t in array array[
    'bookings', 'branches', 'campaigns', 'clinic_settings', 'custom_sections',
    'departments', 'doctors', 'invoices', 'packages', 'patient_files',
    'patient_schedules', 'patient_subscriptions', 'patients', 'payment_receipts',
    'payments', 'receptionists', 'sessions', 'staff', 'therapists', 'treatments',
    'audit_events'
  ] loop
    execute format('create policy tenant_isolation on public.%I as restrictive for all to public
      using ((select public.app_is_system()) or organization_id = (select public.app_org_id()))
      with check ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
  end loop;

  -- Template tables: organization_id NULL = global row, readable by every
  -- clinic, never written outside the system context (new rows always get
  -- the current organization; global rows cannot be updated or deleted).
  foreach t in array array[
    'template_categories', 'template_usage', 'treatment_methods', 'treatment_templates'
  ] loop
    execute format('create policy tenant_isolation on public.%I as restrictive for all to public
      using ((select public.app_is_system()) or organization_id is null
             or organization_id = (select public.app_org_id()))
      with check ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
    execute format('create policy global_rows_read_only_update on public.%I as restrictive for update to public
      using ((select public.app_is_system()) or organization_id = (select public.app_org_id()))
      with check ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
    execute format('create policy global_rows_read_only_delete on public.%I as restrictive for delete to public
      using ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
  end loop;

  -- Branch-scoped tables (convention 8).
  foreach t in array array[
    'bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
    'patient_schedules', 'treatments'
  ] loop
    execute format('create policy branch_scope on public.%I as restrictive for all to public
      using ((select public.app_is_system()) or public.can_access_branch(branch_id))
      with check ((select public.app_is_system()) or public.can_access_branch(branch_id))', t);
  end loop;

  -- Every clinic table: system context, ENABLE + FORCE.
  foreach t in array array[
    'audit_events', 'bookings', 'branches', 'campaigns', 'clinic_settings',
    'custom_sections', 'departments', 'doctors', 'invoices', 'packages',
    'patient_files', 'patient_schedules', 'patient_subscriptions', 'patients',
    'payment_receipts', 'payments', 'receptionists', 'sessions', 'staff',
    'template_categories', 'template_usage', 'therapists', 'treatment_methods',
    'treatment_templates', 'treatments'
  ] loop
    execute format('create policy system_access on public.%I as permissive for all to public
      using ((select public.app_is_system())) with check ((select public.app_is_system()))', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;


-- =====================================================================
-- 10. Self-check
-- =====================================================================
do $$
declare
  v_platform text[] := array[
    'organizations', 'platform_admins', 'organization_members', 'member_branches',
    'invitations', 'specialties', 'modules', 'specialty_modules',
    'organization_modules', 'subscription_plans', 'subscriptions',
    'reserved_slugs', 'schema_migrations'];
  v_bad text[];
begin
  -- Every clinic table: organization_id, RLS enabled + forced, a
  -- restrictive tenant_isolation policy and an index led by organization_id.
  select array_agg(c.relname order by c.relname) into v_bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and c.relname <> all (v_platform)
     and not (
       c.relrowsecurity and c.relforcerowsecurity
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
       and exists (select 1 from pg_policy p
                    where p.polrelid = c.oid and p.polname = 'tenant_isolation' and not p.polpermissive)
       and exists (select 1 from pg_index i
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                    where i.indrelid = c.oid and a.attname = 'organization_id'));
  if v_bad is not null then
    raise exception '0003_tenancy self-check: clinic tables without full tenancy: %', v_bad;
  end if;

  -- Platform tables never have RLS (convention 4).
  select array_agg(c.relname order by c.relname) into v_bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname = any (v_platform) and c.relrowsecurity;
  if v_bad is not null then
    raise exception '0003_tenancy self-check: platform tables with RLS: %', v_bad;
  end if;

  -- Branch-scoped tables: branch_id NOT NULL + restrictive branch_scope.
  select array_agg(t order by t) into v_bad
    from unnest(array['bookings', 'sessions', 'invoices', 'payments', 'payment_receipts',
                      'patient_schedules', 'treatments']) t
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = ('public.' || t)::regclass and a.attname = 'branch_id' and a.attnotnull)
      or not exists (select 1 from pg_policy p
                      where p.polrelid = ('public.' || t)::regclass and p.polname = 'branch_scope' and not p.polpermissive);
  if v_bad is not null then
    raise exception '0003_tenancy self-check: branch tables without branch_id/branch_scope: %', v_bad;
  end if;

  -- Convention 9: a unique index on a clinic table includes organization_id,
  -- unless it is the single-column (globally unique) primary key or a
  -- partial index over the global rows (organization_id IS NULL).
  select array_agg(ic.relname order by ic.relname) into v_bad
    from pg_index i
    join pg_class c  on c.oid = i.indrelid
    join pg_class ic on ic.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace
     and c.relname <> all (v_platform)
     and i.indisunique
     and not (i.indisprimary and i.indnatts = 1)
     and not exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'organization_id'
                        and a.attnum = any (i.indkey::int2[]))
     and coalesce(pg_get_expr(i.indpred, i.indrelid), '') !~ 'organization_id IS NULL';
  if v_bad is not null then
    raise exception '0003_tenancy self-check: unique indexes not scoped to the organization: %', v_bad;
  end if;
end
$$;
