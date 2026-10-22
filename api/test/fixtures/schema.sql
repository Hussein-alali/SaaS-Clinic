-- API test fixture (plan task 2.6). NOT a migration.
--
-- A small database that follows the contract of db/migrations 0001-0003
-- (docs/05-Backend-Schema.md "hosting.com PostgreSQL conventions" 1-12) so
-- the API can be tested before/independently of the real migrations:
--   * schema auth: users (status, session_version), uid(), password_reset_tokens
--   * platform/identity tables without RLS
--   * context functions app_org_id(), app_branch_id(), app_is_system(), app_role()
--   * clinic tables with organization_id DEFAULT app_org_id(), FORCE RLS,
--     RESTRICTIVE tenant_isolation, and branch_scope on bookings
--   * a few whitelisted RPC names with fixture bodies
-- PostgreSQL >= 13, no extensions, runs as a non-superuser database owner.
-- Every user's password is Dev@12345.
-- test/helpers.js applies this file to a clean database (it drops and
-- recreates the auth and public schemas first).

set client_min_messages = warning;

-- ── auth (convention 2) ─────────────────────────────────────────────────────
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  status             text not null default 'active' check (status in ('active', 'disabled')),
  session_version    int  not null default 1,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index users_email_lower_key on auth.users (lower(email));

create function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create table auth.password_reset_tokens (
  token_hash text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- ── request context (convention 3) ──────────────────────────────────────────
create function public.app_org_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create function public.app_branch_id() returns text
language sql stable as $$ select nullif(current_setting('app.branch_id', true), '') $$;

create function public.app_is_system() returns boolean
language sql stable as $$ select coalesce(current_setting('app.system', true), '') = 'on' $$;

-- ── platform and identity tables (convention 4: no RLS, never in /api/data) ─
create table specialties (
  id      uuid primary key default gen_random_uuid(),
  code    text not null unique,
  name_ar text,
  name_en text,
  status  text not null default 'active'
);

create table modules (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name_ar    text,
  category   text not null default 'core',
  depends_on text[] not null default '{}',
  status     text not null default 'active'
);

create table subscription_plans (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  max_users        int,
  max_branches     int,
  max_storage_mb   int,
  included_modules text[] not null default '{}',
  status           text not null default 'active'
);

create table organizations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(name) between 2 and 120),
  slug                 text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'),
  primary_specialty_id uuid not null references specialties(id),
  status               text not null default 'draft'
                       check (status in ('draft', 'pending_activation', 'active', 'suspended', 'closed')),
  status_reason        text,
  suspended_at         timestamptz,
  retention_until      timestamptz,
  plan_id              uuid references subscription_plans(id),
  created_by           uuid not null references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index organizations_slug_lower_key on organizations (lower(slug));

create table organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id),
  role            text not null check (role in ('admin', 'receptionist', 'doctor', 'therapist', 'staff')),
  status          text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  invited_by      uuid,
  joined_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on organization_members (user_id, status);

create table platform_admins (
  user_id    uuid primary key references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid
);

create table organization_modules (
  organization_id uuid not null references organizations(id) on delete cascade,
  module_id       uuid not null references modules(id),
  enabled         boolean not null default true,
  configured_by   uuid,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, module_id)
);

create table invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  email           text not null,
  token_hash      text not null unique,
  role            text not null,
  branch_ids      text[] not null default '{}',
  status          text not null default 'pending',
  invited_by      uuid,
  expires_at      timestamptz not null default now() + interval '7 days',
  created_at      timestamptz not null default now()
);

create table schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- ── clinic tables (conventions 5, 8, 9, 11) ─────────────────────────────────
create table branches (
  id              text primary key,
  organization_id uuid not null default public.app_org_id() references organizations(id),
  name            text not null,
  address         text,
  phone           text,
  working_hours   jsonb,
  rooms           int default 0,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz default now(),
  updated_at      timestamptz,
  unique (organization_id, name),
  unique (organization_id, id)
);
create index branches_organization_idx on branches (organization_id);

create table member_branches (
  member_id       uuid not null references organization_members(id) on delete cascade,
  branch_id       text not null references branches(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  primary key (member_id, branch_id)
);

create table clinic_settings (
  organization_id uuid not null default public.app_org_id() references organizations(id),
  id              int  not null default 1 check (id = 1),
  name            text not null default 'كينيتك',
  subtitle        text default 'نظام العيادة',
  logo            text,
  primary_color   text default '#7BBDE8',
  updated_at      timestamptz default now(),
  primary key (organization_id, id)
);

create table patients (
  patient_id      text primary key,
  organization_id uuid not null default public.app_org_id() references organizations(id),
  name            text not null,
  phone           text,
  age             int,
  gender          text check (gender in ('M', 'F')),
  diagnosis       text,
  vip             boolean not null default false,
  balance         numeric(12, 2) default 0,
  tags            text[],
  meta            jsonb,
  birth_date      date,
  created_at      timestamptz default now(),
  unique (organization_id, patient_id)
);
create index patients_organization_idx on patients (organization_id);

create table bookings (
  booking_id      text primary key,
  organization_id uuid not null default public.app_org_id() references organizations(id),
  branch_id       text not null default public.app_branch_id() references branches(id),
  patient_id      text,
  therapist_id    text,
  date            date,
  time            text,
  status          text default 'pending',
  notes           text,
  created_at      timestamptz default now(),
  -- references stay inside one clinic (Schema "Relationships")
  foreign key (organization_id, patient_id) references patients (organization_id, patient_id) on delete cascade,
  foreign key (organization_id, branch_id) references branches (organization_id, id)
);
create index bookings_org_branch_idx on bookings (organization_id, branch_id);

create table patient_files (
  file_id         text primary key,
  organization_id uuid not null default public.app_org_id() references organizations(id),
  patient_id      text,
  file_name       text not null,
  file_type       text,
  file_url        text,
  storage_path    text,
  uploaded_by     uuid,
  uploaded_at     timestamptz default now(),
  unique (organization_id, storage_path)
);

-- Negative cases for the /api/data whitelist: RLS without FORCE, and no RLS.
create table rls_not_forced (
  id              int primary key,
  organization_id uuid not null default public.app_org_id(),
  body            text
);
create table no_rls_notes (
  id   int primary key,
  body text
);

-- ── role helpers (conventions 7, 8) ─────────────────────────────────────────
create function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select m.role
    from organization_members m
    join organizations o on o.id = m.organization_id
   where m.user_id = auth.uid()
     and m.organization_id = public.app_org_id()
     and m.status = 'active'
     and o.status = 'active'
$$;

create function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create function public.can_access_branch(p_branch text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_branch is null then false
    when public.app_role() = 'admin' then true
    else exists (
      select 1
        from member_branches mb
        join organization_members m on m.id = mb.member_id
       where mb.branch_id = p_branch
         and m.user_id = auth.uid()
         and m.organization_id = public.app_org_id()
         and m.status = 'active')
  end
$$;

-- ── seed (before RLS is forced on the owner) ────────────────────────────────
insert into auth.users (id, email, encrypted_password, raw_user_meta_data, status) values
  ('00000000-0000-4000-8000-000000000001', 'system@clinicsys.test',         null, '{}', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'super@clinicsys.test',          '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Super Admin"}', 'active'),
  ('00000000-0000-4000-8000-000000000011', 'admin@demo-physio.test',        '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Physio Admin"}', 'active'),
  -- $2a$ = a hash migrated from Supabase Auth
  ('00000000-0000-4000-8000-000000000012', 'receptionist@demo-physio.test', '$2a$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Physio Reception"}', 'active'),
  ('00000000-0000-4000-8000-000000000013', 'doctor@demo-physio.test',       '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Physio Doctor"}', 'active'),
  ('00000000-0000-4000-8000-000000000014', 'staff@demo-physio.test',        '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Physio Staff"}', 'active'),
  ('00000000-0000-4000-8000-000000000015', 'former@demo-physio.test',       '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Former Member"}', 'active'),
  ('00000000-0000-4000-8000-000000000016', 'therapist@demo-physio.test',    '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Physio Therapist"}', 'active'),
  ('00000000-0000-4000-8000-000000000021', 'admin@demo-dental.test',        '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Dental Admin"}', 'active'),
  ('00000000-0000-4000-8000-000000000031', 'admin@demo-suspended.test',     '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{}', 'active'),
  ('00000000-0000-4000-8000-000000000041', 'outsider@clinicsys.test',       '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{}', 'active'),
  ('00000000-0000-4000-8000-000000000042', 'multi@clinicsys.test',          '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{"name":"Two Clinics"}', 'active'),
  ('00000000-0000-4000-8000-000000000043', 'disabled@clinicsys.test',       '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{}', 'disabled'),
  ('00000000-0000-4000-8000-000000000044', 'changer@demo-physio.test',      '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{}', 'active'),
  ('00000000-0000-4000-8000-000000000045', 'reset@demo-physio.test',        '$2b$10$PPS7V5V/C.qJ.0sJjXdSm./ZpKYVm/gbEYWuPgbbmrH36Ub1PX9Wu', '{}', 'active');

insert into platform_admins (user_id) values ('00000000-0000-4000-8000-000000000002');

insert into specialties (id, code, name_ar, name_en) values
  ('a0000000-0000-4000-8000-000000000001', 'physio',  'علاج طبيعي', 'Physiotherapy'),
  ('a0000000-0000-4000-8000-000000000002', 'dental',  'أسنان',      'Dental'),
  ('a0000000-0000-4000-8000-000000000003', 'general', 'طب عام',     'General');

insert into modules (id, code, name_ar, category, status) values
  ('b0000000-0000-4000-8000-000000000001', 'core.patients',     'المرضى',  'core',      'active'),
  ('b0000000-0000-4000-8000-000000000002', 'core.appointments', 'المواعيد', 'core',      'active'),
  ('b0000000-0000-4000-8000-000000000003', 'core.branches',     'الفروع',  'core',      'active'),
  ('b0000000-0000-4000-8000-000000000004', 'physio.sessions',   'الجلسات', 'specialty', 'active'),
  ('b0000000-0000-4000-8000-000000000005', 'legacy.reports',    'قديم',    'core',      'inactive');

insert into subscription_plans (id, code, name, max_users, max_branches, max_storage_mb) values
  ('c0000000-0000-4000-8000-000000000001', 'unlimited', 'Unlimited', null, null, null),
  ('c0000000-0000-4000-8000-000000000002', 'tiny',      'Tiny',      5,    2,    1);

insert into organizations (id, name, slug, primary_specialty_id, status, plan_id, created_by, status_reason) values
  ('10000000-0000-4000-8000-000000000001', 'Demo Physio',    'demo-physio',    'a0000000-0000-4000-8000-000000000001', 'active',             'c0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', null),
  ('10000000-0000-4000-8000-000000000002', 'Demo Dental',    'demo-dental',    'a0000000-0000-4000-8000-000000000002', 'active',             'c0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', null),
  ('10000000-0000-4000-8000-000000000003', 'Demo Suspended', 'demo-suspended', 'a0000000-0000-4000-8000-000000000001', 'suspended',          null,                                   '00000000-0000-4000-8000-000000000001', 'unpaid'),
  ('10000000-0000-4000-8000-000000000004', 'Demo Closed',    'demo-closed',    'a0000000-0000-4000-8000-000000000001', 'closed',             null,                                   '00000000-0000-4000-8000-000000000001', 'closed by owner'),
  ('10000000-0000-4000-8000-000000000005', 'Demo Pending',   'demo-pending',   'a0000000-0000-4000-8000-000000000003', 'pending_activation', null,                                   '00000000-0000-4000-8000-000000000001', null),
  ('10000000-0000-4000-8000-000000000006', 'Demo Draft',     'demo-draft',     'a0000000-0000-4000-8000-000000000003', 'draft',              null,                                   '00000000-0000-4000-8000-000000000001', null);

insert into organization_members (id, organization_id, user_id, role, status) values
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'admin',        'active'),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'receptionist', 'active'),
  ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000013', 'doctor',       'active'),
  ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000014', 'staff',        'active'),
  ('20000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000015', 'receptionist', 'disabled'),
  ('20000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000016', 'therapist',    'active'),
  ('20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000021', 'admin',        'active'),
  ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000031', 'admin',        'active'),
  ('20000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000042', 'therapist',    'active'),
  ('20000000-0000-4000-8000-000000000043', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000042', 'receptionist', 'active'),
  ('20000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000044', 'admin',        'active'),
  ('20000000-0000-4000-8000-000000000045', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000045', 'receptionist', 'active');

insert into organization_modules (organization_id, module_id, enabled) values
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', true),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', true),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', false),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000004', true),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000005', true),
  ('10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', true);

insert into branches (id, organization_id, name, created_at) values
  ('br-physio-main', '10000000-0000-4000-8000-000000000001', 'الفرع الرئيسي', '2026-01-01T00:00:00Z'),
  ('br-physio-east', '10000000-0000-4000-8000-000000000001', 'فرع الشرق',     '2026-02-01T00:00:00Z'),
  ('br-dental-main', '10000000-0000-4000-8000-000000000002', 'الفرع الرئيسي', '2026-01-01T00:00:00Z'),
  ('br-dental-west', '10000000-0000-4000-8000-000000000002', 'فرع الغرب',     '2026-03-01T00:00:00Z'),
  ('br-susp-main',   '10000000-0000-4000-8000-000000000003', 'الفرع الرئيسي', '2026-01-01T00:00:00Z');

insert into member_branches (member_id, branch_id, organization_id) values
  ('20000000-0000-4000-8000-000000000012', 'br-physio-east', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000013', 'br-physio-main', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000016', 'br-physio-main', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000042', 'br-physio-main', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000042', 'br-physio-east', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000043', 'br-dental-west', '10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000045', 'br-physio-main', '10000000-0000-4000-8000-000000000001');

insert into clinic_settings (organization_id, id, name, subtitle, primary_color) values
  ('10000000-0000-4000-8000-000000000001', 1, 'عيادة العلاج الطبيعي', 'نظام العيادة', '#123456'),
  ('10000000-0000-4000-8000-000000000002', 1, 'عيادة الأسنان',        'نظام العيادة', '#654321'),
  ('10000000-0000-4000-8000-000000000003', 1, 'عيادة موقوفة',          null,           null);

insert into patients (patient_id, organization_id, name, phone, age, gender, diagnosis, vip, balance, tags, meta, birth_date, created_at) values
  ('P-PHY-1', '10000000-0000-4000-8000-000000000001', 'Ahmed Ali',   '0100', 30, 'M', 'Back pain', true,  150.50, '{back,new}', '{"source":"walk-in"}', '1996-05-04', '2026-01-01T10:00:00Z'),
  ('P-PHY-2', '10000000-0000-4000-8000-000000000001', 'Mona Hassan', '0101', 45, 'F', null,        false, 0,      null,         null,                   null,         '2026-01-02T10:00:00Z'),
  ('P-PHY-3', '10000000-0000-4000-8000-000000000001', 'Omar Said',   '0102', 60, 'M', 'Knee',      false, 20,     '{knee}',     '{"source":"referral"}', '1966-01-31', '2026-01-03T10:00:00Z'),
  ('P-DEN-1', '10000000-0000-4000-8000-000000000002', 'Dental Only', '0200', 25, 'F', 'Caries',    false, 0,      null,         null,                   null,         '2026-01-01T10:00:00Z');

insert into bookings (booking_id, organization_id, branch_id, patient_id, date, time, status) values
  ('B-PHY-MAIN-1', '10000000-0000-4000-8000-000000000001', 'br-physio-main', 'P-PHY-1', '2026-10-21', '10:00', 'pending'),
  ('B-PHY-EAST-1', '10000000-0000-4000-8000-000000000001', 'br-physio-east', 'P-PHY-2', '2026-10-22', '11:00', 'pending'),
  ('B-DEN-1',      '10000000-0000-4000-8000-000000000002', 'br-dental-main', 'P-DEN-1', '2026-10-21', '09:00', 'pending');

insert into rls_not_forced (id, organization_id, body) values (1, '10000000-0000-4000-8000-000000000001', 'x');
insert into no_rls_notes (id, body) values (1, 'x');

-- ── RLS (conventions 6 and 8) ───────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['branches', 'clinic_settings', 'patients', 'bookings', 'patient_files'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I as restrictive for all to public
         using ((select public.app_is_system()) or organization_id = (select public.app_org_id()))
         with check ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
  end loop;
end $$;

alter table rls_not_forced enable row level security; -- enabled but not FORCEd: not whitelisted

create policy branch_scope on bookings as restrictive for all to public
  using ((select public.app_is_system()) or public.can_access_branch(branch_id))
  with check ((select public.app_is_system()) or public.can_access_branch(branch_id));

-- Role policies as in Supabase_All_In_One.sql (permissive, ANDed with the above).
create policy "public read clinic_settings" on clinic_settings for select using (true);
create policy "admin write clinic_settings" on clinic_settings for all
  using ((select public.app_role()) = 'admin') with check ((select public.app_role()) = 'admin');

create policy "staff read branches" on branches for select
  using ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "admin write branches" on branches for all
  using ((select public.app_role()) = 'admin') with check ((select public.app_role()) = 'admin');

create policy "staff read patients" on patients for select
  using ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "staff insert patients" on patients for insert
  with check ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "staff update patients" on patients for update
  using ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'))
  with check ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "admin/reception delete patients" on patients for delete
  using ((select public.app_role()) in ('admin', 'receptionist'));

create policy "staff read bookings" on bookings for select
  using ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "admin/reception write bookings" on bookings for all
  using ((select public.app_role()) in ('admin', 'receptionist'))
  with check ((select public.app_role()) in ('admin', 'receptionist'));

create policy "staff read patient_files" on patient_files for select
  using ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "staff insert patient_files" on patient_files for insert
  with check ((select public.app_role()) in ('admin', 'receptionist', 'doctor', 'therapist'));
create policy "staff delete patient_files" on patient_files for delete
  using ((select public.app_role()) in ('admin', 'receptionist') or uploaded_by = auth.uid());

-- ── RPC fixtures (whitelisted names, fixture bodies) ────────────────────────
-- scalar jsonb: echoes the request context
create function public.get_treatment(p_treatment_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'treatment_id', p_treatment_id,
    'user_id', auth.uid(),
    'org_id', public.app_org_id(),
    'branch_id', public.app_branch_id(),
    'role', public.app_role());
end $$;

-- set of rows (RLS still applies: security definer runs as the owner, who is
-- subject to FORCE RLS — convention 12)
create function public.list_treatments(p_patient_id text default null, p_limit int default 200)
returns table (patient_id text, name text)
language sql stable security definer set search_path = public as $$
  select p.patient_id, p.name
    from patients p
   where p_patient_id is null or p.patient_id = p_patient_id
   order by p.patient_id
   limit p_limit
$$;

-- set of scalars
create function public.list_template_categories(p_include_archived boolean default false)
returns setof text
language sql stable security definer set search_path = public as $$
  select p.name from patients p where p_include_archived or not p.vip order by p.name
$$;

-- jsonb argument + error codes
create function public.record_quick_payment(
  p_patient_id text, p_allocations jsonb, p_method text, p_reference text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_method = 'over-limit' then raise exception 'Plan limit reached' using errcode = 'PL422'; end if;
  if p_method = 'duplicate' then raise exception 'duplicate receipt' using errcode = '23505'; end if;
  if p_method = 'forbidden' then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_method = 'business' then raise exception 'Amount exceeds the balance'; end if;
  return jsonb_build_object(
    'patient_id', p_patient_id,
    'allocations', p_allocations,
    'allocations_type', jsonb_typeof(p_allocations),
    'method', p_method,
    'reference', p_reference);
end $$;

-- overloads, chosen by argument names
create function public.update_treatment(p_treatment_id text, p_patch jsonb) returns text
language sql immutable as $$ select 'patch:' || p_treatment_id || ':' || (p_patch ->> 'status') $$;
create function public.update_treatment(p_treatment_id text, p_status text, p_note text default null) returns text
language sql immutable as $$ select 'status:' || p_treatment_id || ':' || p_status || ':' || coalesce(p_note, '-') $$;

-- void
create function public.delete_treatment(p_treatment_id text) returns void
language plpgsql as $$ begin perform 1; end $$;

-- one composite row
create function public.get_treatment_template(p_template_id text) returns patients
language sql stable security definer set search_path = public as $$
  select * from patients where patient_id = p_template_id
$$;

-- int8 and numeric results come back as JSON numbers
create function public.list_invoices_filtered(p_limit int default 50) returns bigint
language sql immutable as $$ select 9007199254740000::bigint + p_limit $$;

-- exists in the database but is NOT whitelisted (the frontend never calls it)
create function public.create_treatment_method() returns int
language sql immutable as $$ select 1 $$;
