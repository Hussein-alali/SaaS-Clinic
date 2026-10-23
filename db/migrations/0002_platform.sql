-- =====================================================================
-- 0002_platform.sql — platform and identity tables + catalog seed
-- (plan task 2.3; docs/05-Backend-Schema.md "Tables", conventions 1 and 4)
--
-- Platform/identity tables have NO row-level security (convention 4): they
-- are never exposed through /api/data, only through dedicated API routes
-- that check the caller. The authorization helpers of 0003_tenancy.sql
-- (app_role(), can_access_branch(), ...) read them directly, which is why
-- they must not have RLS themselves (no recursive policy evaluation).
--
--   subscription_plans, specialties, modules, specialty_modules,
--   reserved_slugs, organizations, platform_admins, organization_members,
--   member_branches, invitations, organization_modules, subscriptions
--
-- Seeds: 3 specialties, 16 modules (8 core + 3 physio active, 5 dental /
-- general planned) with depends_on, the default module set of each
-- specialty, the plan 'default' (no limits) and the reserved slugs.
--
-- PostgreSQL >= 13, no extensions (gen_random_uuid() is core since 13).
-- migrate.js wraps this file in one transaction.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Generic updated_at trigger for the new tables.
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------
-- subscription_plans — plans and their limits. NULL limit = unlimited.
-- included_modules NULL = every module may be enabled.
-- ---------------------------------------------------------------------
create table public.subscription_plans (
  id               uuid primary key default gen_random_uuid(),
  code             text not null,
  name             text not null,
  max_users        int  check (max_users is null or max_users >= 0),
  max_branches     int  check (max_branches is null or max_branches >= 0),
  max_storage_mb   int  check (max_storage_mb is null or max_storage_mb >= 0),
  included_modules text[],
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint subscription_plans_code_key unique (code),
  constraint subscription_plans_code_chk check (code ~ '^[a-z0-9][a-z0-9_-]*$')
);
create trigger subscription_plans_touch before update on public.subscription_plans
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- specialties / modules / specialty_modules — product catalog.
-- ---------------------------------------------------------------------
create table public.specialties (
  id      uuid primary key default gen_random_uuid(),
  code    text not null,
  name_ar text not null,
  name_en text,
  status  text not null default 'active' check (status in ('active', 'planned', 'inactive')),
  constraint specialties_code_key unique (code),
  constraint specialties_code_chk check (code ~ '^[a-z][a-z0-9_]*$')
);

create table public.modules (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name_ar    text not null,
  category   text not null check (category in ('core', 'specialty')),
  depends_on text[] not null default '{}',
  status     text not null default 'active' check (status in ('active', 'planned', 'inactive')),
  constraint modules_code_key unique (code),
  constraint modules_code_chk check (code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint modules_category_prefix_chk check ((category = 'core') = (code like 'core.%')),
  constraint modules_no_self_dependency check (not (code = any (depends_on)))
);

create table public.specialty_modules (
  specialty_id uuid not null references public.specialties (id) on delete cascade,
  module_id    uuid not null references public.modules (id) on delete cascade,
  primary key (specialty_id, module_id)
);
create index specialty_modules_module_idx on public.specialty_modules (module_id);

-- ---------------------------------------------------------------------
-- reserved_slugs — never usable as a clinic slug (sub-domain).
-- ---------------------------------------------------------------------
create table public.reserved_slugs (
  slug       text primary key check (slug = lower(slug)),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- organizations — one clinic (tenant).
-- ---------------------------------------------------------------------
create table public.organizations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null,
  primary_specialty_id uuid not null references public.specialties (id),
  status               text not null default 'draft',
  status_reason        text,
  suspended_at         timestamptz,
  retention_until      timestamptz,
  plan_id              uuid references public.subscription_plans (id),
  created_by           uuid not null references auth.users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint organizations_name_chk check (char_length(btrim(name)) between 2 and 120),
  -- 3-32 chars: lower-case letters, digits, hyphen; no leading/trailing hyphen.
  constraint organizations_slug_chk check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'),
  constraint organizations_status_chk
    check (status in ('draft', 'pending_activation', 'active', 'suspended', 'closed')),
  constraint organizations_status_reason_chk
    check (status not in ('suspended', 'closed') or nullif(btrim(status_reason), '') is not null)
);
create unique index organizations_slug_key on public.organizations (lower(slug));
create index organizations_status_idx on public.organizations (status);
create index organizations_plan_idx on public.organizations (plan_id);
create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

-- A slug must not be reserved (checked on insert and on slug change).
create or replace function public.organizations_check_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.reserved_slugs r where r.slug = lower(new.slug)) then
    raise exception using
      errcode = '23514',
      message = 'slug_reserved',
      detail  = format('"%s" is a reserved slug', new.slug);
  end if;
  return new;
end
$$;
create trigger organizations_check_slug before insert or update of slug on public.organizations
  for each row execute function public.organizations_check_slug();

-- ---------------------------------------------------------------------
-- platform_admins — Super Admins (outside any clinic). Managed only with
-- api/scripts/create-super-admin.js or SQL; no API write route.
-- ---------------------------------------------------------------------
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

-- ---------------------------------------------------------------------
-- organization_members — a user's membership (role + status) in a clinic.
-- ---------------------------------------------------------------------
create table public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id),
  role            text not null check (role in ('admin', 'receptionist', 'doctor', 'therapist', 'staff')),
  status          text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  invited_by      uuid references auth.users (id) on delete set null,
  joined_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organization_members_org_user_key unique (organization_id, user_id),
  -- Target of the composite FK from member_branches (same organization).
  constraint organization_members_org_id_key unique (organization_id, id)
);
create index organization_members_user_status_idx on public.organization_members (user_id, status);
create trigger organization_members_touch before update on public.organization_members
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- member_branches — branches a member may work in. No rows for an admin
-- = every branch. 0003_tenancy.sql replaces the branch FK by a composite
-- (organization_id, branch_id) FK once branches has organization_id.
-- ---------------------------------------------------------------------
create table public.member_branches (
  member_id       uuid not null,
  branch_id       text not null references public.branches (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  primary key (member_id, branch_id),
  constraint member_branches_member_fkey foreign key (organization_id, member_id)
    references public.organization_members (organization_id, id) on delete cascade
);
create index member_branches_branch_idx on public.member_branches (branch_id);
create index member_branches_org_idx on public.member_branches (organization_id);

-- ---------------------------------------------------------------------
-- invitations — pending invitation of an e-mail to a clinic. Only the
-- SHA-256 hash of the token is stored.
-- ---------------------------------------------------------------------
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           text not null check (position('@' in email) > 1),
  token_hash      text not null,
  role            text not null check (role in ('admin', 'receptionist', 'doctor', 'therapist', 'staff')),
  branch_ids      text[] not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by      uuid references auth.users (id) on delete set null,
  expires_at      timestamptz not null default (now() + interval '7 days'),
  created_at      timestamptz not null default now(),
  constraint invitations_token_hash_key unique (token_hash)
);
create unique index invitations_org_email_pending_key
  on public.invitations (organization_id, lower(email)) where status = 'pending';
create index invitations_email_idx on public.invitations (lower(email));

-- ---------------------------------------------------------------------
-- organization_modules — modules enabled/disabled per clinic.
-- ---------------------------------------------------------------------
create table public.organization_modules (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  module_id       uuid not null references public.modules (id),
  enabled         boolean not null default true,
  configured_by   uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, module_id)
);
create index organization_modules_module_idx on public.organization_modules (module_id);
create trigger organization_modules_touch before update on public.organization_modules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- subscriptions — current and past (manual) subscriptions of a clinic.
-- ---------------------------------------------------------------------
create table public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id         uuid not null references public.subscription_plans (id),
  status          text not null default 'active' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  period_start    date,
  period_end      date,
  notes           text,
  set_by          uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint subscriptions_period_chk check (period_end is null or period_start is null or period_end >= period_start)
);
create index subscriptions_org_created_idx on public.subscriptions (organization_id, created_at desc);

-- =====================================================================
-- Catalog seed
-- =====================================================================

insert into public.specialties (code, name_ar, name_en, status) values
  ('physio',  'العلاج الطبيعي', 'Physiotherapy',     'active'),
  ('dental',  'طب الأسنان',     'Dentistry',         'active'),
  ('general', 'الطب العام',     'General medicine',  'active');

-- Core modules are shared by every specialty. Specialty modules: physio is
-- what the current product does; dental/general are planned (P2, plan task
-- 4.8) and cannot be used until their status becomes 'active'.
insert into public.modules (code, name_ar, category, depends_on, status) values
  ('core.patients',          'المرضى',                 'core',      '{}',                                        'active'),
  ('core.appointments',      'المواعيد',               'core',      '{core.patients,core.branches}',             'active'),
  ('core.billing',           'الفواتير والمدفوعات',    'core',      '{core.patients}',                           'active'),
  ('core.staff',             'الموظفون',               'core',      '{}',                                        'active'),
  ('core.branches',          'الفروع',                 'core',      '{}',                                        'active'),
  ('core.files',             'ملفات المرضى',           'core',      '{core.patients}',                           'active'),
  ('core.reports',           'التقارير',               'core',      '{core.patients}',                           'active'),
  ('core.settings',          'الإعدادات',              'core',      '{}',                                        'active'),
  ('physio.sessions',        'جلسات العلاج الطبيعي',   'specialty', '{core.patients,core.appointments}',         'active'),
  ('physio.treatment_plans', 'خطط العلاج',             'specialty', '{core.patients,physio.sessions}',           'active'),
  ('physio.templates',       'قوالب خطط العلاج',       'specialty', '{physio.treatment_plans}',                  'active'),
  ('dental.chart',           'مخطط الأسنان',           'specialty', '{core.patients}',                           'planned'),
  ('dental.procedures',      'إجراءات الأسنان',        'specialty', '{core.appointments,core.billing,dental.chart}', 'planned'),
  ('general.visits',         'الزيارات',               'specialty', '{core.patients,core.appointments}',         'planned'),
  ('general.vitals',         'العلامات الحيوية',       'specialty', '{general.visits}',                          'planned'),
  ('general.prescriptions',  'الوصفات الطبية',         'specialty', '{general.visits}',                          'planned');

-- Default module set of each specialty: every core.* module + the modules
-- whose code starts with the specialty code.
insert into public.specialty_modules (specialty_id, module_id)
select s.id, m.id
  from public.specialties s
  join public.modules m on m.category = 'core' or m.code like s.code || '.%';

-- Plan 'default': no limits (NULL = unlimited). Real limits are commercial
-- decisions entered from the Super Admin panel (plan task 4.2).
insert into public.subscription_plans (code, name, max_users, max_branches, max_storage_mb, included_modules, status)
values ('default', 'الخطة الافتراضية', null, null, null, null, 'active');

insert into public.reserved_slugs (slug) values
  ('admin'), ('www'), ('api'), ('app'), ('staging'), ('mail'), ('static');
