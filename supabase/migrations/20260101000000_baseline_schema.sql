-- ============================================================
-- Migration: baseline_schema
-- Establishes the full Kinetic schema (tables, RLS, storage bucket).
-- Every statement is idempotent (if-not-exists / drop-create / on-conflict),
-- so this is safe to run on a fresh project OR an existing database.
-- Apply with the Supabase CLI:  supabase db push
-- (or paste into the Dashboard SQL editor).
-- ============================================================

-- ── Role helper ──────────────────────────────────────────────
-- Standard Supabase JWTs put 'authenticated' in the top-level role claim;
-- the clinic role (admin/receptionist/doctor/therapist/patient) is stored
-- in user_metadata. All policies below read it through this helper.
create or replace function public.app_role() returns text
language sql stable as $$
  select coalesce(
    auth.jwt() -> 'user_metadata' ->> 'role',
    auth.jwt() ->> 'role'
  )
$$;

-- ── Clinic branding (singleton row) ─────────────────────────
create table if not exists clinic_settings (
  id            int primary key default 1,
  name          text not null default 'كينيتك',
  subtitle      text default 'نظام العيادة',
  logo          text,                       -- data URL or public storage URL
  primary_color text default '#7BBDE8',
  updated_at    timestamptz default now(),
  constraint clinic_settings_singleton check (id = 1)
);
insert into clinic_settings (id) values (1) on conflict do nothing;

-- ── Custom sections (admin-defined sidebar entries) ────────
create table if not exists custom_sections (
  id           text primary key,
  slug         text not null unique,
  label        text not null,
  icon         text not null default 'Layers',
  "group"      text default 'مخصص',
  description  text,
  content      text,                       -- freeform content body
  position     int default 0,
  visible      boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ── Core domain tables ──────────────────────────────────────
create table if not exists patients (
  patient_id   text primary key,
  name         text not null,
  phone        text,
  age          int,
  gender       text check (gender in ('M','F')),
  diagnosis    text,
  notes        text,
  therapist_id text,                          -- assigned physiotherapist
  created_at   timestamptz default now()
);
-- Backfill for databases created before therapist assignment (safe to re-run).
alter table patients add column if not exists therapist_id text;

create table if not exists bookings (
  booking_id    text primary key,
  patient_id    text references patients(patient_id) on delete cascade,
  therapist_id  text,
  doctor_id     text,
  department_id text,
  date          date,
  time          text,
  status        text default 'pending',
  notes         text,
  created_at    timestamptz default now()
);
-- Backfill the doctor/department columns on databases created before
-- Quick Booking (safe to re-run).
alter table bookings add column if not exists doctor_id     text;
alter table bookings add column if not exists department_id text;

create table if not exists sessions (
  session_id      text primary key,
  patient_id      text references patients(patient_id) on delete cascade,
  therapist_id    text,
  date            date,
  pain_score      int check (pain_score between 0 and 10),
  session_notes   text,
  session_number  int,
  created_at      timestamptz default now()
);

create table if not exists invoices (
  invoice_id      text primary key,
  patient_id      text references patients(patient_id) on delete cascade,
  amount          numeric,
  paid            numeric default 0,
  payment_method  text,
  status          text default 'pending',
  created_at      timestamptz default now()
);

create table if not exists staff (
  staff_id  text primary key,
  name      text not null,
  role      text check (role in ('admin','receptionist','doctor','therapist')),
  phone     text,
  email     text unique,
  auth_uid  uuid                                -- links to auth.users.id
);

-- ── Therapists (roster + workload) ──────────────────────────
create table if not exists therapists (
  id          text primary key,
  name        text not null,
  spec        text,
  "load"      int default 0,
  max         int default 8,
  color       text default '#7BBDE8',
  auth_uid    uuid,                             -- links to auth.users.id (optional)
  created_at  timestamptz default now()
);

-- ── Departments (booking taxonomy) ──────────────────────────
create table if not exists departments (
  id          text primary key,
  name_ar     text not null,
  name_en     text,
  description text,
  icon        text default 'Layers',       -- icon name resolved in the UI
  color       text default '#7BBDE8',
  sort_order  int default 0,
  active      boolean default true,
  created_at  timestamptz default now()
);

-- ── Doctors (assigned to a department) ──────────────────────
create table if not exists doctors (
  id               text primary key,
  name             text not null,
  department_id    text references departments(id) on delete set null,
  specialization   text,
  experience_years int default 0,
  photo            text,                    -- URL or data URL
  schedule         text,                    -- freeform working hours
  status           text default 'available',-- available | busy | leave
  color            text default '#7BBDE8',
  active           boolean default true,
  created_at       timestamptz default now()
);
create index if not exists doctors_department_id_idx on doctors(department_id);

-- ── Packages (treatment plans / pricing) ────────────────────
create table if not exists packages (
  id          text primary key,
  name        text not null,
  sessions    int default 1,
  price       numeric default 0,
  active      boolean default true,
  popular     boolean default false,
  color       text default '#7BBDE8',
  sold        int default 0,
  created_at  timestamptz default now()
);

-- ── WhatsApp campaigns ──────────────────────────────────────
create table if not exists campaigns (
  id          text primary key,
  name        text not null,
  audience    int default 0,
  sent        int default 0,
  "read"      int default 0,
  replied     int default 0,
  status      text default 'draft',
  template    text,
  schedule    text,
  best        boolean default false,
  created_at  timestamptz default now()
);

-- ── Branches (multi-branch clinics) ─────────────────────────
create table if not exists branches (
  id          text primary key,
  name        text not null,
  therapists  int default 0,
  rooms       int default 0,
  address     text,
  phone       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz
);

-- ── Patient files (normalized document store) ───────────────
-- The `patients` table stays PII-only. Uploaded documents (reports,
-- X-rays, MRI/CT scans, lab results, prescriptions, images, PDFs, …)
-- are stored in Supabase Storage; only their path/public URL is kept
-- here. `file_type` is a free-text MIME/label so new document kinds
-- need no schema change.
create table if not exists patient_files (
  file_id      text primary key,
  patient_id   text references patients(patient_id) on delete cascade,
  file_name    text not null,
  file_type    text,
  file_url     text,
  uploaded_at  timestamptz default now()
);
create index if not exists patient_files_patient_id_idx on patient_files(patient_id);

-- ── Audit log (PRD Section 8) ───────────────────────────────
create table if not exists audit_events (
  id          bigserial primary key,
  actor_uid   uuid,
  actor_role  text,
  action      text not null,                   -- delete / refund / role-change / etc.
  table_name  text not null,
  row_pk      text,
  payload     jsonb,
  created_at  timestamptz default now()
);

-- ── Row Level Security policies ─────────────────────────────
alter table clinic_settings enable row level security;
alter table custom_sections enable row level security;

-- Allow anon read of branding + visible sections (safe: no PII)
drop policy if exists "public read clinic_settings" on clinic_settings;
create policy "public read clinic_settings"
  on clinic_settings for select using (true);

drop policy if exists "public read custom_sections" on custom_sections;
create policy "public read custom_sections"
  on custom_sections for select using (visible = true);

-- Writes require an authenticated admin JWT.
-- Replace the check with your real admin claim once auth is wired.
drop policy if exists "admin write clinic_settings" on clinic_settings;
create policy "admin write clinic_settings"
  on clinic_settings for all
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

drop policy if exists "admin write custom_sections" on custom_sections;
create policy "admin write custom_sections"
  on custom_sections for all
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

-- ── Domain-table RLS (PRD Section 8) ────────────────────────
-- Enable RLS on every domain table.
alter table patients      enable row level security;
alter table bookings      enable row level security;
alter table sessions      enable row level security;
alter table invoices      enable row level security;
alter table staff         enable row level security;
alter table therapists    enable row level security;
alter table departments   enable row level security;
alter table doctors        enable row level security;
alter table packages      enable row level security;
alter table campaigns     enable row level security;
alter table branches      enable row level security;
alter table patient_files enable row level security;
alter table audit_events  enable row level security;

-- ── branches ─────────────────────────────────────────────────
drop policy if exists "staff read branches" on branches;
create policy "staff read branches" on branches for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin write branches" on branches;
create policy "admin write branches" on branches for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);

-- Helper: current role from JWT ('admin' | 'receptionist' | 'doctor' | 'therapist' | 'patient')
-- (public.app_role()) is set by Supabase Auth via user_metadata.role or a trigger.

-- ── patients ─────────────────────────────────────────────────
drop policy if exists "staff read patients" on patients;
create policy "staff read patients" on patients for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write patients" on patients;
create policy "admin/reception write patients" on patients for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── bookings ─────────────────────────────────────────────────
drop policy if exists "staff read bookings" on bookings;
create policy "staff read bookings" on bookings for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write bookings" on bookings;
create policy "admin/reception write bookings" on bookings for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── sessions ─────────────────────────────────────────────────
drop policy if exists "staff read sessions" on sessions;
create policy "staff read sessions" on sessions for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
-- Therapists write their own sessions; admins can write any.
drop policy if exists "therapist writes own sessions" on sessions;
create policy "therapist writes own sessions" on sessions for all using (
  public.app_role() = 'admin'
  or (public.app_role() = 'therapist' and therapist_id = (
    select staff_id from staff where auth_uid = auth.uid()
  ))
) with check (
  public.app_role() = 'admin'
  or (public.app_role() = 'therapist' and therapist_id = (
    select staff_id from staff where auth_uid = auth.uid()
  ))
);

-- ── invoices ─────────────────────────────────────────────────
drop policy if exists "staff read invoices" on invoices;
create policy "staff read invoices" on invoices for select using (
  public.app_role() in ('admin','receptionist','doctor')
);
drop policy if exists "admin/reception write invoices" on invoices;
create policy "admin/reception write invoices" on invoices for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── staff ────────────────────────────────────────────────────
drop policy if exists "staff read own+admin all" on staff;
create policy "staff read own+admin all" on staff for select using (
  public.app_role() = 'admin'
  or auth_uid = auth.uid()
);
drop policy if exists "admin write staff" on staff;
create policy "admin write staff" on staff for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);

-- ── therapists ───────────────────────────────────────────────
drop policy if exists "staff read therapists" on therapists;
create policy "staff read therapists" on therapists for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin write therapists" on therapists;
create policy "admin write therapists" on therapists for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);

-- ── departments ──────────────────────────────────────────────
drop policy if exists "staff read departments" on departments;
create policy "staff read departments" on departments for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin write departments" on departments;
create policy "admin write departments" on departments for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);

-- ── doctors ──────────────────────────────────────────────────
drop policy if exists "staff read doctors" on doctors;
create policy "staff read doctors" on doctors for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin write doctors" on doctors;
create policy "admin write doctors" on doctors for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);

-- ── packages ─────────────────────────────────────────────────
drop policy if exists "staff read packages" on packages;
create policy "staff read packages" on packages for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write packages" on packages;
create policy "admin/reception write packages" on packages for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── campaigns ────────────────────────────────────────────────
drop policy if exists "staff read campaigns" on campaigns;
create policy "staff read campaigns" on campaigns for select using (
  public.app_role() in ('admin','receptionist','doctor')
);
drop policy if exists "admin/reception write campaigns" on campaigns;
create policy "admin/reception write campaigns" on campaigns for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── patient_files ────────────────────────────────────────────
drop policy if exists "staff read patient_files" on patient_files;
create policy "staff read patient_files" on patient_files for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write patient_files" on patient_files;
create policy "admin/reception write patient_files" on patient_files for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── audit_events ─────────────────────────────────────────────
drop policy if exists "admin read audit" on audit_events;
create policy "admin read audit" on audit_events for select using (
  public.app_role() = 'admin'
);
drop policy if exists "system insert audit" on audit_events;
create policy "system insert audit" on audit_events for insert with check (true);

-- ── Storage bucket for patient documents ────────────────────
-- Files live in the 'patient-files' bucket; patient_files.file_url stores
-- the public URL. Run once (safe to re-run).
insert into storage.buckets (id, name, public)
  values ('patient-files', 'patient-files', true)
  on conflict (id) do nothing;

drop policy if exists "staff read patient files bucket" on storage.objects;
create policy "staff read patient files bucket" on storage.objects for select using (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write patient files bucket" on storage.objects;
create policy "admin/reception write patient files bucket" on storage.objects for all using (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
) with check (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
);
