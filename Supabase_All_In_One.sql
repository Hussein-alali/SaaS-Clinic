-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Kinetic (clinksys) — ALL-IN-ONE Supabase setup                    ║
-- ║                                                                    ║
-- ║  Everything the database needs in ONE file, in dependency order:   ║
-- ║  full schema → every migration → admin seed.                       ║
-- ║                                                                    ║
-- ║  HOW TO USE: Supabase Dashboard → SQL Editor → New query →         ║
-- ║  paste this entire file → Run.                                     ║
-- ║                                                                    ║
-- ║  Idempotent: safe to run on a FRESH project or an EXISTING one,    ║
-- ║  and safe to re-run any time. RLS stays enabled on every table.    ║
-- ║                                                                    ║
-- ║  Consolidated master file, regenerated 2026-07-13; if you edit    ║
-- ║  those, regenerate or re-apply this file.                          ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 1. FULL SCHEMA — tables, RLS policies, RPCs, storage bucket
-- │ (source: supabase-schema.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Kinetic Clinic Management System — Supabase Schema
-- Run this in Supabase SQL editor to create the required tables.
-- After running, set the client keys in index.html:
--   <script>
--     window.SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
--     window.SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
--   </script>
-- ============================================================

-- ── Role helper ──────────────────────────────────────────────
-- The clinic role (admin/receptionist/doctor/therapist) is read from the
-- `staff` table by auth.uid() — NOT from the JWT's user_metadata, which
-- any signed-in user can rewrite for themselves via auth.updateUser().
-- SECURITY DEFINER so the lookup bypasses staff's own RLS (no recursion).
-- Anonymous requests: auth.uid() is null → role is null → every staff
-- policy below evaluates to false.
-- NOTE: the staff table is created further down this file; plpgsql only
-- resolves the table reference at call time, so defining the function
-- first is safe on a fresh database.
create or replace function public.app_role() returns text
language plpgsql stable security definer
set search_path = public
as $$
begin
  return (select s.role from staff s where s.auth_uid = auth.uid() limit 1);
end $$;

-- ── Clinic branding (singleton row) ─────────────────────────
-- ══════════════════════════════════════════════════════════════
-- Schema reconciliation — idempotency for pre-existing databases
-- ══════════════════════════════════════════════════════════════
-- `create table if not exists` is a no-op when a table already
-- exists, so any column later added to a table's definition would
-- be MISSING on an older deployment — and the first index or policy
-- that references it fails (e.g. ERROR 42703: column "auth_uid"
-- does not exist). These ALTERs add every base-schema column when
-- absent. `alter table if exists` makes them a clean no-op on a
-- fresh project (the tables are created just below) and a column
-- backfill on an existing one. Safe to run any number of times.

-- clinic_settings
alter table if exists clinic_settings add column if not exists "id" int default 1;
alter table if exists clinic_settings add column if not exists "name" text default 'كينيتك';
alter table if exists clinic_settings add column if not exists "subtitle" text default 'نظام العيادة';
alter table if exists clinic_settings add column if not exists "logo" text;
alter table if exists clinic_settings add column if not exists "primary_color" text default '#7BBDE8';
alter table if exists clinic_settings add column if not exists "updated_at" timestamptz default now();

-- custom_sections
alter table if exists custom_sections add column if not exists "id" text;
alter table if exists custom_sections add column if not exists "slug" text;
alter table if exists custom_sections add column if not exists "label" text;
alter table if exists custom_sections add column if not exists "icon" text default 'Layers';
alter table if exists custom_sections add column if not exists "group" text default 'مخصص';
alter table if exists custom_sections add column if not exists "description" text;
alter table if exists custom_sections add column if not exists "content" text;
alter table if exists custom_sections add column if not exists "position" int default 0;
alter table if exists custom_sections add column if not exists "visible" boolean default true;
alter table if exists custom_sections add column if not exists "created_at" timestamptz default now();
alter table if exists custom_sections add column if not exists "updated_at" timestamptz default now();

-- patients
alter table if exists patients add column if not exists "patient_id" text;
alter table if exists patients add column if not exists "name" text;
alter table if exists patients add column if not exists "phone" text;
alter table if exists patients add column if not exists "age" int;
alter table if exists patients add column if not exists "gender" text;
alter table if exists patients add column if not exists "diagnosis" text;
alter table if exists patients add column if not exists "notes" text;
alter table if exists patients add column if not exists "therapist_id" text;
alter table if exists patients add column if not exists "created_at" timestamptz default now();

-- bookings
alter table if exists bookings add column if not exists "booking_id" text;
alter table if exists bookings add column if not exists "patient_id" text;
alter table if exists bookings add column if not exists "therapist_id" text;
alter table if exists bookings add column if not exists "doctor_id" text;
alter table if exists bookings add column if not exists "department_id" text;
alter table if exists bookings add column if not exists "date" date;
alter table if exists bookings add column if not exists "time" text;
alter table if exists bookings add column if not exists "status" text default 'pending';
alter table if exists bookings add column if not exists "notes" text;
alter table if exists bookings add column if not exists "created_at" timestamptz default now();

-- sessions
alter table if exists sessions add column if not exists "session_id" text;
alter table if exists sessions add column if not exists "patient_id" text;
alter table if exists sessions add column if not exists "therapist_id" text;
alter table if exists sessions add column if not exists "date" date;
alter table if exists sessions add column if not exists "pain_score" int;
alter table if exists sessions add column if not exists "session_notes" text;
alter table if exists sessions add column if not exists "session_number" int;
alter table if exists sessions add column if not exists "created_at" timestamptz default now();

-- invoices
alter table if exists invoices add column if not exists "invoice_id" text;
alter table if exists invoices add column if not exists "patient_id" text;
alter table if exists invoices add column if not exists "amount" numeric;
alter table if exists invoices add column if not exists "paid" numeric default 0;
alter table if exists invoices add column if not exists "payment_method" text;
alter table if exists invoices add column if not exists "status" text default 'pending';
alter table if exists invoices add column if not exists "created_at" timestamptz default now();

-- packages
alter table if exists packages add column if not exists "id" text;
alter table if exists packages add column if not exists "name" text;

-- patient_subscriptions
alter table if exists patient_subscriptions add column if not exists "subscription_id" text;
alter table if exists patient_subscriptions add column if not exists "patient_id" text;
alter table if exists patient_subscriptions add column if not exists "package_id" text;
alter table if exists patient_subscriptions add column if not exists "package_name" text;
alter table if exists patient_subscriptions add column if not exists "total_sessions" int default 0;
alter table if exists patient_subscriptions add column if not exists "used_sessions" int default 0;
alter table if exists patient_subscriptions add column if not exists "price" numeric default 0;
alter table if exists patient_subscriptions add column if not exists "paid" numeric default 0;
alter table if exists patient_subscriptions add column if not exists "status" text default 'active';
alter table if exists patient_subscriptions add column if not exists "expires_at" date;
alter table if exists patient_subscriptions add column if not exists "created_at" timestamptz default now();
alter table if exists patient_subscriptions add column if not exists "updated_at" timestamptz default now();

-- payments
alter table if exists payments add column if not exists "payment_id" text;
alter table if exists payments add column if not exists "patient_id" text;
alter table if exists payments add column if not exists "cashier_id" text;
alter table if exists payments add column if not exists "cashier_name" text;
alter table if exists payments add column if not exists "amount" numeric;
alter table if exists payments add column if not exists "method" text;
alter table if exists payments add column if not exists "reference" text;
alter table if exists payments add column if not exists "transaction_id" text;
alter table if exists payments add column if not exists "notes" text;
alter table if exists payments add column if not exists "receipt_no" text;
alter table if exists payments add column if not exists "allocations" jsonb default '[]'::jsonb;
alter table if exists payments add column if not exists "ip_address" text;
alter table if exists payments add column if not exists "status" text default 'completed';
alter table if exists payments add column if not exists "created_at" timestamptz default now();

-- staff
alter table if exists staff add column if not exists "staff_id" text;
alter table if exists staff add column if not exists "name" text;
alter table if exists staff add column if not exists "role" text;
alter table if exists staff add column if not exists "phone" text;
alter table if exists staff add column if not exists "email" text;
alter table if exists staff add column if not exists "auth_uid" uuid;

-- therapists
alter table if exists therapists add column if not exists "id" text;
alter table if exists therapists add column if not exists "name" text;
alter table if exists therapists add column if not exists "spec" text;
alter table if exists therapists add column if not exists "load" int default 0;
alter table if exists therapists add column if not exists "max" int default 8;
alter table if exists therapists add column if not exists "color" text default '#7BBDE8';
alter table if exists therapists add column if not exists "auth_uid" uuid;
alter table if exists therapists add column if not exists "created_at" timestamptz default now();

-- departments
alter table if exists departments add column if not exists "id" text;
alter table if exists departments add column if not exists "name_ar" text;
alter table if exists departments add column if not exists "name_en" text;
alter table if exists departments add column if not exists "description" text;
alter table if exists departments add column if not exists "icon" text default 'Layers';
alter table if exists departments add column if not exists "color" text default '#7BBDE8';
alter table if exists departments add column if not exists "sort_order" int default 0;
alter table if exists departments add column if not exists "active" boolean default true;
alter table if exists departments add column if not exists "created_at" timestamptz default now();

-- doctors
alter table if exists doctors add column if not exists "id" text;
alter table if exists doctors add column if not exists "name" text;
alter table if exists doctors add column if not exists "department_id" text;
alter table if exists doctors add column if not exists "specialization" text;
alter table if exists doctors add column if not exists "experience_years" int default 0;
alter table if exists doctors add column if not exists "photo" text;
alter table if exists doctors add column if not exists "schedule" text;
alter table if exists doctors add column if not exists "status" text default 'available';
alter table if exists doctors add column if not exists "color" text default '#7BBDE8';
alter table if exists doctors add column if not exists "active" boolean default true;
alter table if exists doctors add column if not exists "created_at" timestamptz default now();

-- packages
alter table if exists packages add column if not exists "sessions" int default 1;
alter table if exists packages add column if not exists "price" numeric default 0;
alter table if exists packages add column if not exists "active" boolean default true;
alter table if exists packages add column if not exists "popular" boolean default false;
alter table if exists packages add column if not exists "color" text default '#7BBDE8';
alter table if exists packages add column if not exists "sold" int default 0;
alter table if exists packages add column if not exists "created_at" timestamptz default now();

-- campaigns
alter table if exists campaigns add column if not exists "id" text;
alter table if exists campaigns add column if not exists "name" text;
alter table if exists campaigns add column if not exists "audience" int default 0;
alter table if exists campaigns add column if not exists "sent" int default 0;
alter table if exists campaigns add column if not exists "read" int default 0;
alter table if exists campaigns add column if not exists "replied" int default 0;
alter table if exists campaigns add column if not exists "status" text default 'draft';
alter table if exists campaigns add column if not exists "template" text;
alter table if exists campaigns add column if not exists "schedule" text;
alter table if exists campaigns add column if not exists "best" boolean default false;
alter table if exists campaigns add column if not exists "created_at" timestamptz default now();

-- branches
alter table if exists branches add column if not exists "id" text;
alter table if exists branches add column if not exists "name" text;
alter table if exists branches add column if not exists "therapists" int default 0;
alter table if exists branches add column if not exists "rooms" int default 0;
alter table if exists branches add column if not exists "address" text;
alter table if exists branches add column if not exists "phone" text;
alter table if exists branches add column if not exists "created_at" timestamptz default now();
alter table if exists branches add column if not exists "updated_at" timestamptz;

-- patient_files
alter table if exists patient_files add column if not exists "file_id" text;
alter table if exists patient_files add column if not exists "patient_id" text;
alter table if exists patient_files add column if not exists "file_name" text;
alter table if exists patient_files add column if not exists "file_type" text;
alter table if exists patient_files add column if not exists "file_url" text;
alter table if exists patient_files add column if not exists "uploaded_by" uuid;
alter table if exists patient_files add column if not exists "uploaded_at" timestamptz default now();

-- audit_events
alter table if exists audit_events add column if not exists "actor_uid" uuid;
alter table if exists audit_events add column if not exists "actor_role" text;
alter table if exists audit_events add column if not exists "action" text;
alter table if exists audit_events add column if not exists "table_name" text;
alter table if exists audit_events add column if not exists "row_pk" text;
alter table if exists audit_events add column if not exists "payload" jsonb;
alter table if exists audit_events add column if not exists "created_at" timestamptz default now();

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

-- ── Per-appointment pricing (Quick Payment) ─────────────────
-- Bookings gained a session price + running paid + payment_status so a
-- receptionist can settle individual appointments without an invoice row.
-- Safe to re-run.
alter table bookings add column if not exists price          numeric default 0;
alter table bookings add column if not exists paid           numeric default 0;
alter table bookings add column if not exists payment_status text default 'pending'
  check (payment_status in ('pending','partial','paid'));

-- ── Packages (declared early so patient_subscriptions FK resolves) ──
-- Full column set is (re-)declared further down; this stub only exists
-- so the `patient_subscriptions.package_id -> packages(id)` foreign key
-- can be created in a single-pass migration. `create table if not
-- exists` is a no-op if the full definition below already ran.
create table if not exists packages (
  id    text primary key,
  name  text
);

-- ── Patient subscriptions / active packages ────────────────
-- A patient may buy one or more packages (12 sessions, post-op 24 …).
-- Session counters and remaining balance live here so Quick Payment can
-- update package status atomically without touching the packages catalog.
create table if not exists patient_subscriptions (
  subscription_id  text primary key,
  patient_id       text references patients(patient_id) on delete cascade,
  package_id       text references packages(id) on delete set null,
  package_name     text not null,
  total_sessions   int  default 0,
  used_sessions    int  default 0,
  price            numeric default 0,
  paid             numeric default 0,
  status           text default 'active'
    check (status in ('active','paid','expired','cancelled')),
  expires_at       date,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists patient_subscriptions_patient_id_idx
  on patient_subscriptions(patient_id);

-- ── Payment history (immutable ledger) ─────────────────────
-- Every Quick Payment writes exactly one row here. `allocations` is a
-- jsonb array of { type: 'appointment'|'invoice'|'subscription',
-- id: '...', amount: n } — this is the authoritative ledger for the
-- Payment History page and receipts.
create table if not exists payments (
  payment_id      text primary key,
  patient_id      text references patients(patient_id) on delete cascade,
  cashier_id      text,
  cashier_name    text,
  amount          numeric not null check (amount > 0),
  method          text not null,
  reference       text,
  transaction_id  text,
  notes           text,
  receipt_no      text unique,
  allocations     jsonb default '[]'::jsonb,
  ip_address      text,
  status          text default 'completed',
  created_at      timestamptz default now()
);
create index if not exists payments_patient_id_idx on payments(patient_id);
create index if not exists payments_created_at_idx on payments(created_at desc);

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
  uploaded_by  uuid,                        -- auth.uid() of the uploader
  uploaded_at  timestamptz default now()
);
-- Databases created before uploaded_by existed (the RLS delete policy
-- below references it).
alter table patient_files add column if not exists uploaded_by uuid;
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

-- Helper: public.app_role() (defined at the top of this file) returns the
-- current user's role read from the staff table in PostgreSQL
-- ('admin' | 'receptionist' | 'doctor' | 'therapist'), or null for anon.

-- ── patients ─────────────────────────────────────────────────
drop policy if exists "staff read patients" on patients;
create policy "staff read patients" on patients for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
-- Every staff role can register + update patients; only admin/reception
-- can delete.
drop policy if exists "admin/reception write patients" on patients;
drop policy if exists "staff insert patients" on patients;
create policy "staff insert patients" on patients for insert with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "staff update patients" on patients;
create policy "staff update patients" on patients for update using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
) with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception delete patients" on patients;
create policy "admin/reception delete patients" on patients for delete using (
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
-- Every staff role can attach documents to a patient; uploaders can
-- delete their own rows (compensating rollback when a storage upload
-- succeeds but the metadata insert fails); admin/reception can manage all.
drop policy if exists "admin/reception write patient_files" on patient_files;
drop policy if exists "staff insert patient_files" on patient_files;
create policy "staff insert patient_files" on patient_files for insert with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception update patient_files" on patient_files;
create policy "admin/reception update patient_files" on patient_files for update using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);
drop policy if exists "staff delete patient_files" on patient_files;
create policy "staff delete patient_files" on patient_files for delete using (
  public.app_role() in ('admin','receptionist')
  or uploaded_by = auth.uid()
);

-- ── audit_events ─────────────────────────────────────────────
drop policy if exists "admin read audit" on audit_events;
create policy "admin read audit" on audit_events for select using (
  public.app_role() = 'admin'
);
drop policy if exists "system insert audit" on audit_events;
create policy "system insert audit" on audit_events for insert with check (true);

-- ── patient_subscriptions ────────────────────────────────────
alter table patient_subscriptions enable row level security;
drop policy if exists "staff read patient_subscriptions" on patient_subscriptions;
create policy "staff read patient_subscriptions" on patient_subscriptions for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write patient_subscriptions" on patient_subscriptions;
create policy "admin/reception write patient_subscriptions" on patient_subscriptions for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── payments (ledger) ────────────────────────────────────────
alter table payments enable row level security;
drop policy if exists "staff read payments" on payments;
create policy "staff read payments" on payments for select using (
  public.app_role() in ('admin','receptionist','doctor')
);
-- Direct client insert is allowed for admin/receptionist so the demo path
-- (RPC unavailable) still works. The RPC below runs SECURITY DEFINER and
-- bypasses this check when called normally.
drop policy if exists "admin/reception write payments" on payments;
create policy "admin/reception write payments" on payments for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ══════════════════════════════════════════════════════════════
-- Quick Payment RPC — atomic (single PG transaction)
-- ══════════════════════════════════════════════════════════════
-- Accepts a patient + a list of allocations and updates every parent row,
-- writes an immutable payment ledger row, and appends an audit event.
-- Anything that raises inside the function rolls the whole batch back.
--
-- allocations: jsonb array of objects:
--   { "type": "appointment"|"invoice"|"subscription", "id": "...", "amount": 350 }
--
-- Returns: { payment_id, receipt_no }.
create or replace function public.record_quick_payment(
  p_patient_id     text,
  p_allocations    jsonb,
  p_method         text,
  p_reference      text default null,
  p_transaction_id text default null,
  p_notes          text default null,
  p_cashier_id     text default null,
  p_cashier_name   text default null,
  p_ip_address     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id  text;
  v_receipt_no  text;
  v_total       numeric := 0;
  v_alloc       jsonb;
  v_type        text;
  v_ref_id      text;
  v_amount      numeric;
  v_remaining   numeric;
  v_new_paid    numeric;
  v_row         record;
begin
  if p_patient_id is null then
    raise exception 'patient_id is required';
  end if;
  if not exists (select 1 from patients where patient_id = p_patient_id) then
    raise exception 'patient % not found', p_patient_id;
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'allocations must be a non-empty array';
  end if;
  if p_method is null or length(trim(p_method)) = 0 then
    raise exception 'payment method is required';
  end if;

  -- Total = sum of allocation amounts. Reject negative / zero.
  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    if v_amount <= 0 then
      raise exception 'allocation amount must be > 0 (got %)', v_amount;
    end if;
    v_total := v_total + v_amount;
  end loop;

  v_payment_id := 'PMT-' || to_char(now(), 'YYYYMMDDHH24MISSMS')
                        || '-' || substr(md5(random()::text), 1, 4);
  v_receipt_no := 'RCT-' || to_char(now(), 'YYYYMMDD') || '-'
                        || lpad((floor(random()*100000))::int::text, 5, '0');

  -- Apply each allocation. RAISE inside any branch aborts the whole tx.
  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    v_type   := v_alloc->>'type';
    v_ref_id := v_alloc->>'id';
    v_amount := (v_alloc->>'amount')::numeric;

    if v_type = 'appointment' then
      select * into v_row from bookings where booking_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'appointment % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.price, 0) - coalesce(v_row.paid, 0);
      if v_amount > v_remaining + 0.001 then
        raise exception 'appointment % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update bookings
         set paid = v_new_paid,
             payment_status = case
               when v_new_paid >= coalesce(v_row.price, 0) then 'paid'
               when v_new_paid > 0 then 'partial'
               else 'pending'
             end
       where booking_id = v_ref_id;

    elsif v_type = 'invoice' then
      select * into v_row from invoices where invoice_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'invoice % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.amount, 0) - coalesce(v_row.paid, 0);
      if v_remaining <= 0 then
        raise exception 'invoice % is already fully paid', v_ref_id;
      end if;
      if v_amount > v_remaining + 0.001 then
        raise exception 'invoice % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update invoices
         set paid = v_new_paid,
             payment_method = p_method,
             status = case
               when v_new_paid >= coalesce(v_row.amount, 0) then 'paid'
               when v_new_paid > 0 then 'partial'
               else 'pending'
             end
       where invoice_id = v_ref_id;

    elsif v_type = 'subscription' then
      select * into v_row from patient_subscriptions where subscription_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'subscription % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.price, 0) - coalesce(v_row.paid, 0);
      if v_remaining <= 0 then
        raise exception 'subscription % is already fully paid', v_ref_id;
      end if;
      if v_amount > v_remaining + 0.001 then
        raise exception 'subscription % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update patient_subscriptions
         set paid = v_new_paid,
             status = case
               when v_new_paid >= coalesce(v_row.price, 0) then 'paid'
               else 'active'
             end,
             updated_at = now()
       where subscription_id = v_ref_id;

    else
      raise exception 'unknown allocation type: %', v_type;
    end if;
  end loop;

  insert into payments (
    payment_id, patient_id, cashier_id, cashier_name,
    amount, method, reference, transaction_id, notes,
    receipt_no, allocations, ip_address
  ) values (
    v_payment_id, p_patient_id, p_cashier_id, p_cashier_name,
    v_total, p_method, p_reference, p_transaction_id, p_notes,
    v_receipt_no, p_allocations, p_ip_address
  );

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(),
    public.app_role(),
    'quick_payment',
    'payments',
    v_payment_id,
    jsonb_build_object(
      'patient_id',   p_patient_id,
      'amount',       v_total,
      'method',       p_method,
      'receipt_no',   v_receipt_no,
      'allocations',  p_allocations,
      'cashier_name', p_cashier_name,
      'ip_address',   p_ip_address
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_no', v_receipt_no,
    'amount',     v_total
  );
end;
$$;

grant execute on function public.record_quick_payment(
  text, jsonb, text, text, text, text, text, text, text
) to authenticated;

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
-- Every staff role can upload patient documents; uploaders can remove
-- their own objects (upload rollback) — storage sets owner/owner_id to
-- auth.uid() on upload; admin/reception can manage all.
drop policy if exists "admin/reception write patient files bucket" on storage.objects;
drop policy if exists "staff upload patient files bucket" on storage.objects;
create policy "staff upload patient files bucket" on storage.objects for insert with check (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception update patient files bucket" on storage.objects;
create policy "admin/reception update patient files bucket" on storage.objects for update using (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
) with check (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
);
drop policy if exists "staff delete patient files bucket" on storage.objects;
create policy "staff delete patient files bucket" on storage.objects for delete using (
  bucket_id = 'patient-files'
  and (
    public.app_role() in ('admin','receptionist')
    or owner = auth.uid()
    or owner_id = auth.uid()::text
  )
);


-- ═══════════════════════════════════════════════════════════════
-- Treatment Methods ("طرق علاج أخرى")
-- Shared library of treatment methods that doctors can extend
-- at run-time. Feeds the method chips on TreatmentPlanCreate.
-- ═══════════════════════════════════════════════════════════════
create table if not exists treatment_methods (
  method_id        text primary key,
  name             text not null unique,
  category         text,
  description      text,
  duration_minutes int,
  notes            text,
  status           text not null default 'active'
                     check (status in ('active','archived')),
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) treatment_methods so later indexes/constraints/policies resolve
alter table treatment_methods add column if not exists method_id text;
alter table treatment_methods add column if not exists name text;
alter table treatment_methods add column if not exists category text;
alter table treatment_methods add column if not exists description text;
alter table treatment_methods add column if not exists duration_minutes int;
alter table treatment_methods add column if not exists notes text;
alter table treatment_methods add column if not exists status text default 'active';
alter table treatment_methods add column if not exists created_by uuid;
alter table treatment_methods add column if not exists created_by_name text;
alter table treatment_methods add column if not exists created_at timestamptz default now();
alter table treatment_methods add column if not exists updated_at timestamptz default now();
create unique index if not exists treatment_methods_name_uidx on treatment_methods(name);

create index if not exists tx_methods_status_idx   on treatment_methods(status);
create index if not exists tx_methods_category_idx on treatment_methods(category);

alter table treatment_methods enable row level security;

-- Any signed-in staff can read the library.
drop policy if exists "staff read tx methods" on treatment_methods;
create policy "staff read tx methods" on treatment_methods for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);

-- Only admins and doctors can create / edit / archive.
drop policy if exists "doctor write tx methods" on treatment_methods;
create policy "doctor write tx methods" on treatment_methods for insert with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor update tx methods" on treatment_methods;
create policy "doctor update tx methods" on treatment_methods for update using (
  public.app_role() in ('admin','doctor')
) with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "admin delete tx methods" on treatment_methods;
create policy "admin delete tx methods" on treatment_methods for delete using (
  public.app_role() = 'admin'
);

-- Seed the nine built-in methods that used to be hardcoded in
-- TreatmentPlanCreate. Safe to re-run.
insert into treatment_methods (method_id, name, category, status) values
  ('TM-DFLT-001', 'علاج يدوي',          'علاج يدوي',     'active'),
  ('TM-DFLT-002', 'تدريبات قوة',        'تمارين علاجية', 'active'),
  ('TM-DFLT-003', 'تمارين إطالة',       'تمارين علاجية', 'active'),
  ('TM-DFLT-004', 'علاج حراري',         'أجهزة علاجية', 'active'),
  ('TM-DFLT-005', 'تحفيز كهربي',        'أجهزة علاجية', 'active'),
  ('TM-DFLT-006', 'موجات فوق صوتية',    'أجهزة علاجية', 'active'),
  ('TM-DFLT-007', 'علاج مائي',          'علاج مائي',     'active'),
  ('TM-DFLT-008', 'حجامة',              'أخرى',          'active'),
  ('TM-DFLT-009', 'وخز جاف',            'علاج يدوي',     'active')
on conflict (name) do nothing;

-- ── RPC: transactional create with duplicate-name guard + audit
create or replace function public.create_treatment_method(
  p_method_id   text,
  p_name        text,
  p_category    text,
  p_description text,
  p_duration    int,
  p_notes       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role         text := public.app_role();
  v_normalized   text := trim(p_name);
  v_creator_name text;
  v_dup          int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح: لا تملك صلاحية إضافة طرق علاج';
  end if;
  if v_normalized is null or v_normalized = '' then
    raise exception 'اسم طريقة العلاج مطلوب';
  end if;

  -- Case-insensitive duplicate guard (both active and archived rows).
  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_normalized);
  if v_dup > 0 then
    raise exception 'اسم طريقة العلاج موجود مسبقًا';
  end if;

  select coalesce(name, '') into v_creator_name from staff
    where user_id = auth.uid() limit 1;

  insert into treatment_methods (
    method_id, name, category, description, duration_minutes, notes,
    status, created_by, created_by_name
  ) values (
    p_method_id, v_normalized, nullif(trim(coalesce(p_category,'')),''),
    nullif(trim(coalesce(p_description,'')),''), p_duration,
    nullif(trim(coalesce(p_notes,'')),''),
    'active', auth.uid(), v_creator_name
  );

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role, 'tx_method_create', 'treatment_methods', p_method_id,
    jsonb_build_object(
      'name', v_normalized, 'category', p_category,
      'description', p_description, 'duration_minutes', p_duration,
      'notes', p_notes, 'created_by_name', v_creator_name
    )
  );

  return jsonb_build_object(
    'method_id', p_method_id, 'name', v_normalized, 'status', 'active'
  );
end;
$$;
grant execute on function public.create_treatment_method(text,text,text,text,int,text)
  to authenticated;

-- ── RPC: rename / description / category / duration / notes update + audit
create or replace function public.update_treatment_method(
  p_method_id   text,
  p_name        text,
  p_category    text,
  p_description text,
  p_duration    int,
  p_notes       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role       text := public.app_role();
  v_old        treatment_methods%rowtype;
  v_normalized text := trim(coalesce(p_name,''));
  v_dup        int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_old from treatment_methods where method_id = p_method_id for update;
  if not found then
    raise exception 'طريقة العلاج غير موجودة';
  end if;
  if v_normalized = '' then
    raise exception 'الاسم مطلوب';
  end if;
  if lower(v_normalized) <> lower(v_old.name) then
    select count(*) into v_dup from treatment_methods
      where lower(trim(name)) = lower(v_normalized)
        and method_id <> p_method_id;
    if v_dup > 0 then
      raise exception 'اسم طريقة العلاج موجود مسبقًا';
    end if;
  end if;

  update treatment_methods set
    name             = v_normalized,
    category         = nullif(trim(coalesce(p_category,'')),''),
    description      = nullif(trim(coalesce(p_description,'')),''),
    duration_minutes = p_duration,
    notes            = nullif(trim(coalesce(p_notes,'')),''),
    updated_at       = now()
    where method_id  = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role, 'tx_method_update', 'treatment_methods', p_method_id,
    jsonb_build_object(
      'old', to_jsonb(v_old),
      'new', jsonb_build_object(
        'name', v_normalized, 'category', p_category,
        'description', p_description, 'duration_minutes', p_duration,
        'notes', p_notes
      )
    )
  );
  return jsonb_build_object('method_id', p_method_id, 'name', v_normalized);
end;
$$;
grant execute on function public.update_treatment_method(text,text,text,text,int,text)
  to authenticated;

-- ── RPC: archive / restore toggle + audit
create or replace function public.set_treatment_method_status(
  p_method_id text,
  p_status    text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.app_role();
  v_old  text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  select status into v_old from treatment_methods
    where method_id = p_method_id for update;
  if not found then raise exception 'غير موجود'; end if;

  update treatment_methods
    set status = p_status, updated_at = now()
    where method_id = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role,
    case when p_status='archived' then 'tx_method_archive' else 'tx_method_restore' end,
    'treatment_methods', p_method_id,
    jsonb_build_object('old_status', v_old, 'new_status', p_status)
  );
  return jsonb_build_object('method_id', p_method_id, 'status', p_status);
end;
$$;
grant execute on function public.set_treatment_method_status(text,text)
  to authenticated;

-- ── Invoice Date Filter ───────────────────────────────────────
-- Returns a single JSONB payload with (a) filtered invoice rows joined to
-- patient name, (b) aggregate stats, and (c) pagination counts. The window
-- is filtered on invoices.created_at between p_from and p_to (inclusive of
-- the whole p_to day). Null endpoints mean "no bound on that side".
--
-- Optional filters:
--   p_search  — substring match on patient name or invoice_id (case-insens.)
--   p_status  — Arabic status string (مدفوع / جزئي / معلّق / متأخر) or null
--   p_limit   — page size (default 50, max 500)
--   p_offset  — pagination offset
--
-- Stats returned mirror the summary cards on the Payments page:
--   total_invoices, paid_amount, outstanding, overdue_amount,
--   avg_amount, revenue, count, due_total.
create or replace function public.list_invoices_filtered(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_search  text        default null,
  p_status  text        default null,
  p_limit   int         default 50,
  p_offset  int         default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_lim   int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_from  timestamptz := p_from;
  v_to    timestamptz := case
    when p_to is null then null
    -- inclusive of the whole day: add 1 day minus 1 microsecond
    else (date_trunc('day', p_to) + interval '1 day' - interval '1 microsecond')
  end;
  v_srch  text := nullif(btrim(coalesce(p_search, '')), '');
  v_st    text := nullif(btrim(coalesce(p_status, '')), '');
  v_rows  jsonb;
  v_stats jsonb;
  v_count int;
begin
  with base as (
    select i.invoice_id, i.patient_id, i.amount, i.paid, i.payment_method,
           i.status, i.created_at,
           coalesce(p.name, '') as patient_name
      from invoices i
      left join patients p on p.patient_id = i.patient_id
     where (v_from is null or i.created_at >= v_from)
       and (v_to   is null or i.created_at <= v_to)
       and (v_st   is null or i.status = v_st)
       and (
         v_srch is null
         or i.invoice_id ilike '%'||v_srch||'%'
         or coalesce(p.name,'') ilike '%'||v_srch||'%'
       )
  ),
  page as (
    select * from base
    order by created_at desc, invoice_id desc
    limit v_lim offset v_off
  )
  select
    coalesce(jsonb_agg(to_jsonb(page.*) order by created_at desc, invoice_id desc), '[]'::jsonb),
    (select count(*)::int from base)
  into v_rows, v_count
  from page;

  select jsonb_build_object(
    'count',         v_count,
    'total_invoices',(select coalesce(sum(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'paid_amount',   (select coalesce(sum(paid),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'outstanding',   (select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'overdue_amount',(select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and i.status = 'متأخر'
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'avg_amount',    (select coalesce(avg(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%'))
  ) into v_stats;

  return jsonb_build_object(
    'rows',  v_rows,
    'stats', v_stats,
    'count', v_count,
    'limit', v_lim,
    'offset',v_off
  );
end;
$$;
grant execute on function public.list_invoices_filtered(timestamptz,timestamptz,text,text,int,int)
  to authenticated;

-- ── Payment receipts ─────────────────────────────────────────
-- Every uploaded receipt file (image/PDF) tied to a payment row from
-- the `payments` ledger. Files themselves live in Supabase Storage —
-- this table only stores metadata + path. Soft-delete via deleted_at
-- so the payment transaction is never lost when a receipt is removed.
create table if not exists payment_receipts (
  receipt_id       text primary key,
  payment_id       text references payments(payment_id) on delete cascade,
  invoice_id       text references invoices(invoice_id) on delete set null,
  patient_id       text references patients(patient_id) on delete cascade,
  file_name        text,
  stored_name      text,
  storage_path     text,
  file_url         text,
  file_type        text,
  file_size        int,
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz default now(),
  deleted_at       timestamptz,
  deleted_by       uuid
);
-- self-heal: backfill columns on pre-existing (older-schema) payment_receipts so later indexes/constraints/policies resolve
alter table payment_receipts add column if not exists receipt_id text;
alter table payment_receipts add column if not exists payment_id text;
alter table payment_receipts add column if not exists invoice_id text;
alter table payment_receipts add column if not exists patient_id text;
alter table payment_receipts add column if not exists file_name text;
alter table payment_receipts add column if not exists stored_name text;
alter table payment_receipts add column if not exists storage_path text;
alter table payment_receipts add column if not exists file_url text;
alter table payment_receipts add column if not exists file_type text;
alter table payment_receipts add column if not exists file_size int;
alter table payment_receipts add column if not exists uploaded_by uuid;
alter table payment_receipts add column if not exists uploaded_by_name text;
alter table payment_receipts add column if not exists uploaded_at timestamptz default now();
alter table payment_receipts add column if not exists deleted_at timestamptz;
alter table payment_receipts add column if not exists deleted_by uuid;

create index if not exists payment_receipts_payment_idx  on payment_receipts(payment_id);
create index if not exists payment_receipts_invoice_idx  on payment_receipts(invoice_id);
create index if not exists payment_receipts_patient_idx  on payment_receipts(patient_id);

alter table payment_receipts enable row level security;

drop policy if exists "staff read receipts" on payment_receipts;
create policy "staff read receipts" on payment_receipts for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "reception write receipts" on payment_receipts;
create policy "reception write receipts" on payment_receipts for insert
  with check (public.app_role() in ('admin','receptionist'));
drop policy if exists "reception update receipts" on payment_receipts;
create policy "reception update receipts" on payment_receipts for update using (
  public.app_role() in ('admin','receptionist')
);

-- Soft-delete + audit. Admin-only per PRD.
create or replace function public.delete_payment_receipt(
  p_receipt_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.app_role();
  v_row  payment_receipts%rowtype;
begin
  if v_role <> 'admin' then
    raise exception 'غير مصرح — الحذف مقتصر على المدير';
  end if;
  select * into v_row from payment_receipts where receipt_id = p_receipt_id for update;
  if not found then raise exception 'الإيصال غير موجود'; end if;
  if v_row.deleted_at is not null then
    return jsonb_build_object('receipt_id', p_receipt_id, 'already_deleted', true);
  end if;
  update payment_receipts
    set deleted_at = now(), deleted_by = auth.uid()
    where receipt_id = p_receipt_id;
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (auth.uid(), v_role, 'receipt_delete', 'payment_receipts', p_receipt_id,
    jsonb_build_object('payment_id', v_row.payment_id, 'invoice_id', v_row.invoice_id));
  return jsonb_build_object('receipt_id', p_receipt_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_payment_receipt(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Treatment Plan Templates ("قوالب خطط العلاج")
-- Full library of reusable treatment plans doctors can apply to
-- patients. Exercises/methods/goals live inline as
-- JSONB arrays so a template is one atomic row + one round-trip.
-- Versions and usage are tracked in side tables for restore &
-- statistics. Receptionists have no access. Doctors + admins can
-- create/edit; therapists can view + apply.
-- ═══════════════════════════════════════════════════════════════
create table if not exists treatment_templates (
  template_id            text primary key,
  name                   text not null,
  category               text,
  diagnosis              text,
  body_part              text,
  goals                  jsonb not null default '[]'::jsonb,
  exercises              jsonb not null default '[]'::jsonb,
  methods                jsonb not null default '[]'::jsonb,
  home_instructions      text,
  notes                  text,
  warnings               text,
  followup_instructions  text,
  estimated_sessions     int,
  weekly_frequency       int,
  expected_recovery_days int,
  status                 text not null default 'active'
                           check (status in ('active','archived')),
  version                int  not null default 1,
  usage_count            int  not null default 0,
  last_used_at           timestamptz,
  avg_recovery_days      numeric,
  completion_rate        numeric,
  created_by             uuid,
  created_by_name        text,
  updated_by             uuid,
  updated_by_name        text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) treatment_templates so later indexes/constraints/policies resolve
alter table treatment_templates add column if not exists template_id text;
alter table treatment_templates add column if not exists name text;
alter table treatment_templates add column if not exists category text;
alter table treatment_templates add column if not exists diagnosis text;
alter table treatment_templates add column if not exists body_part text;
alter table treatment_templates add column if not exists goals jsonb default '[]'::jsonb;
alter table treatment_templates add column if not exists exercises jsonb default '[]'::jsonb;
alter table treatment_templates add column if not exists methods jsonb default '[]'::jsonb;
alter table treatment_templates add column if not exists home_instructions text;
alter table treatment_templates add column if not exists notes text;
alter table treatment_templates add column if not exists warnings text;
alter table treatment_templates add column if not exists followup_instructions text;
alter table treatment_templates add column if not exists estimated_sessions int;
alter table treatment_templates add column if not exists weekly_frequency int;
alter table treatment_templates add column if not exists expected_recovery_days int;
alter table treatment_templates add column if not exists status text default 'active';
alter table treatment_templates add column if not exists version int default 1;
alter table treatment_templates add column if not exists usage_count int default 0;
alter table treatment_templates add column if not exists last_used_at timestamptz;
alter table treatment_templates add column if not exists avg_recovery_days numeric;
alter table treatment_templates add column if not exists completion_rate numeric;
alter table treatment_templates add column if not exists created_by uuid;
alter table treatment_templates add column if not exists created_by_name text;
alter table treatment_templates add column if not exists updated_by uuid;
alter table treatment_templates add column if not exists updated_by_name text;
alter table treatment_templates add column if not exists created_at timestamptz default now();
alter table treatment_templates add column if not exists updated_at timestamptz default now();

create index if not exists tx_templates_status_idx    on treatment_templates(status);
create index if not exists tx_templates_category_idx  on treatment_templates(category);
create index if not exists tx_templates_creator_idx   on treatment_templates(created_by);
create index if not exists tx_templates_usage_idx     on treatment_templates(usage_count desc);
create index if not exists tx_templates_created_idx   on treatment_templates(created_at desc);

alter table treatment_templates enable row level security;

-- Read: everyone except receptionist.
drop policy if exists "clinical read templates" on treatment_templates;
create policy "clinical read templates" on treatment_templates for select using (
  public.app_role() in ('admin','doctor','therapist')
);
drop policy if exists "doctor write templates" on treatment_templates;
create policy "doctor write templates" on treatment_templates for insert with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor update templates" on treatment_templates;
create policy "doctor update templates" on treatment_templates for update using (
  public.app_role() in ('admin','doctor')
) with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor delete templates" on treatment_templates;
create policy "doctor delete templates" on treatment_templates for delete using (
  public.app_role() in ('admin','doctor')
);

-- ── Version history (snapshot per edit) ──────────────────────
create table if not exists template_versions (
  version_id     text primary key,
  template_id    text not null references treatment_templates(template_id) on delete cascade,
  version_num    int  not null,
  editor_uid     uuid,
  editor_name    text,
  change_summary text,
  snapshot       jsonb not null,
  created_at     timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) template_versions so later indexes/constraints/policies resolve
alter table template_versions add column if not exists version_id text;
alter table template_versions add column if not exists template_id text;
alter table template_versions add column if not exists version_num int;
alter table template_versions add column if not exists editor_uid uuid;
alter table template_versions add column if not exists editor_name text;
alter table template_versions add column if not exists change_summary text;
alter table template_versions add column if not exists snapshot jsonb;
alter table template_versions add column if not exists created_at timestamptz default now();

create index if not exists tx_ver_template_idx on template_versions(template_id, version_num desc);

alter table template_versions enable row level security;
drop policy if exists "clinical read versions" on template_versions;
create policy "clinical read versions" on template_versions for select using (
  public.app_role() in ('admin','doctor','therapist')
);
-- Only RPCs (security definer) write to versions — no direct policy.

-- ── Usage log (which patients used which template) ───────────
create table if not exists template_usage (
  use_id          text primary key,
  template_id     text not null references treatment_templates(template_id) on delete cascade,
  patient_id      text,
  plan_id         text,
  applied_by      uuid,
  applied_by_name text,
  applied_at      timestamptz default now(),
  completed_at    timestamptz,
  recovery_days   int
);
-- self-heal: backfill columns on pre-existing (older-schema) template_usage so later indexes/constraints/policies resolve
alter table template_usage add column if not exists use_id text;
alter table template_usage add column if not exists template_id text;
alter table template_usage add column if not exists patient_id text;
alter table template_usage add column if not exists plan_id text;
alter table template_usage add column if not exists applied_by uuid;
alter table template_usage add column if not exists applied_by_name text;
alter table template_usage add column if not exists applied_at timestamptz default now();
alter table template_usage add column if not exists completed_at timestamptz;
alter table template_usage add column if not exists recovery_days int;

create index if not exists tx_use_template_idx on template_usage(template_id);
create index if not exists tx_use_patient_idx  on template_usage(patient_id);

alter table template_usage enable row level security;
drop policy if exists "clinical read usage" on template_usage;
create policy "clinical read usage" on template_usage for select using (
  public.app_role() in ('admin','doctor','therapist')
);
-- Writes go through RPCs.

-- ── Helper: audit + version ──────────────────────────────────
create or replace function public._tpl_snapshot(p_template_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(t.*) from treatment_templates t where t.template_id = p_template_id
$$;

create or replace function public._tpl_write_version(
  p_template_id text, p_editor_uid uuid, p_editor_name text, p_summary text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_num int;
  v_id  text;
  v_snap jsonb;
begin
  select coalesce(max(version_num),0) + 1 into v_num
    from template_versions where template_id = p_template_id;
  v_id := 'TV-' || p_template_id || '-' || v_num;
  v_snap := public._tpl_snapshot(p_template_id);
  insert into template_versions(version_id, template_id, version_num, editor_uid, editor_name, change_summary, snapshot)
  values (v_id, p_template_id, v_num, p_editor_uid, p_editor_name, p_summary, v_snap);
  update treatment_templates set version = v_num where template_id = p_template_id;
end;
$$;

-- ── RPC: create template ─────────────────────────────────────
create or replace function public.create_treatment_template(
  p_template_id text,
  p_payload     jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_name  text := coalesce((p_payload->>'created_by_name'),'');
  v_new_id text := p_template_id;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — الإنشاء مقتصر على المدير والطبيب';
  end if;
  if coalesce(btrim(p_payload->>'name'),'') = '' then
    raise exception 'اسم القالب مطلوب';
  end if;
  if v_new_id is null or v_new_id = '' then
    v_new_id := 'TPL-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
             || upper(substr(md5(random()::text),1,4));
  end if;

  insert into treatment_templates (
    template_id, name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    status, version, created_by, created_by_name, updated_by, updated_by_name
  ) values (
    v_new_id,
    btrim(p_payload->>'name'),
    nullif(p_payload->>'category',''),
    nullif(p_payload->>'diagnosis',''),
    nullif(p_payload->>'body_part',''),
    coalesce(p_payload->'goals','[]'::jsonb),
    coalesce(p_payload->'exercises','[]'::jsonb),
    coalesce(p_payload->'methods','[]'::jsonb),
    nullif(p_payload->>'home_instructions',''),
    nullif(p_payload->>'notes',''),
    nullif(p_payload->>'warnings',''),
    nullif(p_payload->>'followup_instructions',''),
    nullif(p_payload->>'estimated_sessions','')::int,
    nullif(p_payload->>'weekly_frequency','')::int,
    nullif(p_payload->>'expected_recovery_days','')::int,
    'active', 1, v_uid, v_name, v_uid, v_name
  );

  perform public._tpl_write_version(v_new_id, v_uid, v_name, 'إنشاء');

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_create', 'treatment_templates', v_new_id, p_payload);

  return jsonb_build_object('template_id', v_new_id);
end;
$$;
grant execute on function public.create_treatment_template(text, jsonb) to authenticated;

-- ── RPC: update template ─────────────────────────────────────
create or replace function public.update_treatment_template(
  p_template_id   text,
  p_payload       jsonb,
  p_change_summary text
) returns jsonb
language plpgsql security definer set search_path = public as $$
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

  perform public._tpl_write_version(p_template_id, v_uid, v_name, coalesce(p_change_summary,'تعديل'));

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_update', 'treatment_templates', p_template_id,
    jsonb_build_object('old', v_old, 'new', p_payload, 'summary', p_change_summary));

  return jsonb_build_object('template_id', p_template_id);
end;
$$;
grant execute on function public.update_treatment_template(text, jsonb, text) to authenticated;

-- ── RPC: duplicate template ──────────────────────────────────
create or replace function public.duplicate_treatment_template(
  p_template_id text,
  p_new_name    text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_src   treatment_templates%rowtype;
  v_new_id text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — النسخ مقتصر على المدير والطبيب';
  end if;
  select * into v_src from treatment_templates where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  v_new_id := 'TPL-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
           || upper(substr(md5(random()::text),1,4));

  insert into treatment_templates (
    template_id, name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    status, version, created_by, created_by_name, updated_by, updated_by_name
  ) values (
    v_new_id,
    coalesce(nullif(btrim(p_new_name),''), v_src.name || ' — نسخة'),
    v_src.category, v_src.diagnosis, v_src.body_part,
    v_src.goals, v_src.exercises, v_src.methods,
    v_src.home_instructions, v_src.notes, v_src.warnings, v_src.followup_instructions,
    v_src.estimated_sessions, v_src.weekly_frequency, v_src.expected_recovery_days,
    'active', 1, v_uid,
    coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—'),
    v_uid,
    coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—')
  );

  perform public._tpl_write_version(v_new_id, v_uid, null, 'نسخة من ' || p_template_id);

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_duplicate', 'treatment_templates', v_new_id,
    jsonb_build_object('source_id', p_template_id));

  return jsonb_build_object('template_id', v_new_id, 'source_id', p_template_id);
end;
$$;
grant execute on function public.duplicate_treatment_template(text, text) to authenticated;

-- ── RPC: archive / restore ───────────────────────────────────
create or replace function public.set_treatment_template_status(
  p_template_id text,
  p_status      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  update treatment_templates set status = p_status, updated_at = now(), updated_by = v_uid
    where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role,
    case when p_status='archived' then 'template_archive' else 'template_restore' end,
    'treatment_templates', p_template_id, jsonb_build_object('status', p_status));

  return jsonb_build_object('template_id', p_template_id, 'status', p_status);
end;
$$;
grant execute on function public.set_treatment_template_status(text, text) to authenticated;

-- ── RPC: delete template (hard-delete only if never used) ────
create or replace function public.delete_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
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

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_delete', 'treatment_templates', p_template_id,
    to_jsonb(v_row));

  return jsonb_build_object('template_id', p_template_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_treatment_template(text) to authenticated;

-- ── RPC: apply template to a patient ─────────────────────────
create or replace function public.apply_template_to_patient(
  p_template_id text,
  p_patient_id  text,
  p_plan_id     text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_use_id text;
  v_status text;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select status into v_status from treatment_templates where template_id = p_template_id;
  if v_status is null then raise exception 'القالب غير موجود'; end if;
  if v_status = 'archived' then
    raise exception 'لا يمكن تطبيق قالب مؤرشف';
  end if;

  v_use_id := 'TU-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
           || upper(substr(md5(random()::text),1,4));
  insert into template_usage (use_id, template_id, patient_id, plan_id, applied_by, applied_by_name)
  values (v_use_id, p_template_id, p_patient_id, p_plan_id, v_uid, v_name);

  update treatment_templates
     set usage_count  = coalesce(usage_count,0) + 1,
         last_used_at = now()
   where template_id = p_template_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_apply', 'treatment_templates', p_template_id,
    jsonb_build_object('patient_id', p_patient_id, 'plan_id', p_plan_id, 'use_id', v_use_id));

  return jsonb_build_object('use_id', v_use_id, 'template_id', p_template_id);
end;
$$;
grant execute on function public.apply_template_to_patient(text, text, text) to authenticated;

-- ── RPC: list templates with search + filters + pagination ───
create or replace function public.list_treatment_templates(
  p_status     text  default null,
  p_category   text  default null,
  p_creator    uuid  default null,
  p_search     text  default null,
  p_sort       text  default 'recent',
  p_limit      int   default 100,
  p_offset     int   default 0
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_lim int := least(greatest(coalesce(p_limit,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_cat  text := nullif(btrim(coalesce(p_category,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;

  with base as (
    select t.*
      from treatment_templates t
     where (v_st  is null or t.status   = v_st)
       and (v_cat is null or t.category = v_cat)
       and (p_creator is null or t.created_by = p_creator)
       and (
         v_srch is null
         or t.name      ilike '%'||v_srch||'%'
         or t.diagnosis ilike '%'||v_srch||'%'
         or t.category  ilike '%'||v_srch||'%'
         or t.body_part ilike '%'||v_srch||'%'
         or (t.exercises::text ilike '%'||v_srch||'%')
         or (t.methods  ::text ilike '%'||v_srch||'%')
       )
  ),
  ordered as (
    select * from base
    order by
      case when p_sort = 'usage'   then usage_count end desc nulls last,
      case when p_sort = 'name'    then name       end asc  nulls last,
      case when p_sort = 'oldest'  then created_at end asc  nulls last,
      created_at desc
    limit v_lim offset v_off
  )
  select coalesce(jsonb_agg(to_jsonb(ordered.*)),'[]'::jsonb),
         (select count(*)::int from base)
    into v_rows, v_cnt
    from ordered;

  return jsonb_build_object('rows', v_rows, 'count', v_cnt,
                             'limit', v_lim, 'offset', v_off);
end;
$$;
grant execute on function public.list_treatment_templates(text,text,uuid,text,text,int,int) to authenticated;

-- ── RPC: fetch a single template + versions + usage stats ────
create or replace function public.get_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_tpl jsonb;
  v_versions jsonb;
  v_stats jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) into v_tpl from treatment_templates t where t.template_id = p_template_id;
  if v_tpl is null then return null; end if;

  select coalesce(jsonb_agg(to_jsonb(v.*) order by v.version_num desc),'[]'::jsonb)
    into v_versions
    from template_versions v where v.template_id = p_template_id;

  select jsonb_build_object(
    'usage_count',    coalesce(count(*),0),
    'completion_rate',coalesce(round(avg( (completed_at is not null)::int )::numeric * 100, 1), 0),
    'avg_recovery',   coalesce(round(avg(recovery_days),1), 0),
    'last_used_at',   max(applied_at)
  ) into v_stats
    from template_usage where template_id = p_template_id;

  return jsonb_build_object('template', v_tpl, 'versions', v_versions, 'stats', v_stats);
end;
$$;
grant execute on function public.get_treatment_template(text) to authenticated;

-- ── RPC: restore a previous version ──────────────────────────
create or replace function public.restore_template_version(
  p_version_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_v    template_versions%rowtype;
  v_snap jsonb;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_v from template_versions where version_id = p_version_id;
  if not found then raise exception 'الإصدار غير موجود'; end if;
  v_snap := v_v.snapshot;

  update treatment_templates set
    name                   = v_snap->>'name',
    category               = v_snap->>'category',
    diagnosis              = v_snap->>'diagnosis',
    body_part              = v_snap->>'body_part',
    goals                  = coalesce(v_snap->'goals','[]'::jsonb),
    exercises              = coalesce(v_snap->'exercises','[]'::jsonb),
    methods                = coalesce(v_snap->'methods','[]'::jsonb),
    home_instructions      = v_snap->>'home_instructions',
    notes                  = v_snap->>'notes',
    warnings               = v_snap->>'warnings',
    followup_instructions  = v_snap->>'followup_instructions',
    estimated_sessions     = nullif(v_snap->>'estimated_sessions','')::int,
    weekly_frequency       = nullif(v_snap->>'weekly_frequency','')::int,
    expected_recovery_days = nullif(v_snap->>'expected_recovery_days','')::int,
    updated_by             = v_uid,
    updated_at             = now()
    where template_id = v_v.template_id;

  perform public._tpl_write_version(v_v.template_id, v_uid, null,
    'استعادة الإصدار ' || v_v.version_num);

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_restore_version', 'treatment_templates', v_v.template_id,
    jsonb_build_object('version_id', p_version_id, 'version_num', v_v.version_num));

  return jsonb_build_object('template_id', v_v.template_id);
end;
$$;
grant execute on function public.restore_template_version(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Treatment Methods — v2 extensions (icon / color / display_order
-- + hard delete). Adds visual attributes and a delete RPC that
-- refuses to remove methods used by any template. Existing v1
-- create/update RPCs stay intact so old callers still work.
-- ═══════════════════════════════════════════════════════════════
alter table treatment_methods
  add column if not exists icon           text,
  add column if not exists color          text,
  add column if not exists display_order  int;

create index if not exists tx_methods_order_idx on treatment_methods(display_order nulls last, name);

-- ── RPC: upsert (create or update) with full field set ───────
create or replace function public.upsert_treatment_method(
  p_method_id text,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_payload->>'name',''));
  v_id     text := p_method_id;
  v_old    treatment_methods%rowtype;
  v_dup    int;
  v_action text;
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
  v_action := case when found then 'tx_method_update' else 'tx_method_create' end;

  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_name) and method_id <> v_id;
  if v_dup > 0 then raise exception 'اسم طريقة العلاج موجود مسبقًا'; end if;

  if found then
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
$$;
grant execute on function public.upsert_treatment_method(text, jsonb) to authenticated;

-- ── RPC: hard delete (blocks if referenced by any template) ──
-- Templates store methods as JSONB [{method_id, name}]. We block
-- delete if either the id OR the name appears in any template.
create or replace function public.delete_treatment_method(
  p_method_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_row  treatment_methods%rowtype;
  v_hits int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_methods where method_id = p_method_id for update;
  if not found then raise exception 'طريقة العلاج غير موجودة'; end if;

  -- Referenced by any template? Check both method_id and name in JSONB.
  select count(*) into v_hits
    from treatment_templates t
   where exists (
     select 1 from jsonb_array_elements(coalesce(t.methods,'[]'::jsonb)) elem
      where elem->>'method_id' = p_method_id
         or lower(coalesce(elem->>'name','')) = lower(v_row.name)
   );
  if v_hits > 0 then
    raise exception 'لا يمكن حذف طريقة مستخدمة في % قالب — استخدم الأرشفة بدلاً منها', v_hits;
  end if;

  delete from treatment_methods where method_id = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tx_method_delete', 'treatment_methods', p_method_id, to_jsonb(v_row));

  return jsonb_build_object('method_id', p_method_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_treatment_method(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Template Categories — DB-authoritative list of category labels
-- for treatment templates. Managed from Settings → قوالب خطط
-- العلاج. Renaming a category updates all templates using the
-- old name so the picker stays consistent.
-- ═══════════════════════════════════════════════════════════════
create table if not exists template_categories (
  category_id     text primary key,
  name            text not null,
  description     text,
  status          text not null default 'active'
                    check (status in ('active','archived')),
  sort_order      int,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) template_categories so later indexes/constraints/policies resolve
alter table template_categories add column if not exists category_id text;
alter table template_categories add column if not exists name text;
alter table template_categories add column if not exists description text;
alter table template_categories add column if not exists status text default 'active';
alter table template_categories add column if not exists sort_order int;
alter table template_categories add column if not exists created_by uuid;
alter table template_categories add column if not exists created_by_name text;
alter table template_categories add column if not exists created_at timestamptz default now();
alter table template_categories add column if not exists updated_at timestamptz default now();

create unique index if not exists tpl_cat_name_uniq
  on template_categories(lower(trim(name)));
create index if not exists tpl_cat_status_idx  on template_categories(status);
create index if not exists tpl_cat_sort_idx    on template_categories(sort_order nulls last, name);

alter table template_categories enable row level security;

drop policy if exists "clinical read tpl categories" on template_categories;
create policy "clinical read tpl categories" on template_categories for select using (
  public.app_role() in ('admin','doctor','therapist')
);

create or replace function public.list_template_categories(
  p_include_archived boolean default false
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v_rows jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select coalesce(jsonb_agg(to_jsonb(c.*) order by
    coalesce(c.sort_order, 999999), c.name),'[]'::jsonb)
    into v_rows
    from template_categories c
   where p_include_archived or c.status = 'active';
  return jsonb_build_object('rows', v_rows);
end;
$$;
grant execute on function public.list_template_categories(boolean) to authenticated;

create or replace function public.upsert_template_category(
  p_category_id text,
  p_payload     jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_id   text := p_category_id;
  v_old  template_categories%rowtype;
  v_dup  int;
  v_action text;
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
  v_action := case when found then 'tpl_cat_update' else 'tpl_cat_create' end;
  select count(*) into v_dup from template_categories
    where lower(trim(name)) = lower(v_name) and category_id <> v_id;
  if v_dup > 0 then raise exception 'اسم الفئة موجود مسبقًا'; end if;

  if found then
    if v_old.name is distinct from v_name then
      update treatment_templates set category = v_name where category = v_old.name;
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
$$;
grant execute on function public.upsert_template_category(text, jsonb) to authenticated;

create or replace function public.set_template_category_status(
  p_category_id text,
  p_status      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  update template_categories set status = p_status, updated_at = now()
    where category_id = p_category_id;
  if not found then raise exception 'الفئة غير موجودة'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role,
    case when p_status='archived' then 'tpl_cat_archive' else 'tpl_cat_restore' end,
    'template_categories', p_category_id, jsonb_build_object('status', p_status));

  return jsonb_build_object('category_id', p_category_id, 'status', p_status);
end;
$$;
grant execute on function public.set_template_category_status(text, text) to authenticated;

-- ── RPC: delete a category (blocked if any template still uses it) ──
-- Safe hard-delete: refuses when a treatment_templates row still carries
-- this category's name, so no template is ever orphaned. Callers should
-- reassign or archive instead. Admin/doctor only; audited.
create or replace function public.delete_template_category(
  p_category_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tpl_cat_delete', 'template_categories', p_category_id, to_jsonb(v_cat));
  return jsonb_build_object('category_id', p_category_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_template_category(text) to authenticated;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 2. MIGRATION 2026-07-11 — payments/receipts, treatment templates & methods
-- │ (source: supabase-migration-2026-07-11.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═════════════════════════════════════════════════════════════
-- Kinetic — combined migration (2026-07-11)
-- Apply in Supabase → SQL Editor → New query → paste → Run.
-- Idempotent: safe to re-run.
--
-- Bundles three migrations in dependency order:
--   1. Payments & Invoices  — list_invoices_filtered RPC,
--                              payment_receipts table + RLS,
--                              delete_payment_receipt RPC
--   2. Treatment Templates  — treatment_templates + versions
--                              + usage tables, 9 RPCs
--   3. Treatment Methods v2 — icon/color/display_order columns,
--                              upsert + delete RPCs (delete blocks
--                              when a template references the
--                              method by id OR by name)
-- ═════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════
-- 1. PAYMENTS & INVOICES
-- ═════════════════════════════════════════════════════════════

-- ── 1a. list_invoices_filtered RPC ───────────────────────────
-- Returns rows + stats + count in one round-trip. Used by the
-- Payments & Invoices page date-filter.
create or replace function public.list_invoices_filtered(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_search  text        default null,
  p_status  text        default null,
  p_limit   int         default 50,
  p_offset  int         default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_lim   int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_from  timestamptz := p_from;
  v_to    timestamptz := case
    when p_to is null then null
    else (date_trunc('day', p_to) + interval '1 day' - interval '1 microsecond')
  end;
  v_srch  text := nullif(btrim(coalesce(p_search, '')), '');
  v_st    text := nullif(btrim(coalesce(p_status, '')), '');
  v_rows  jsonb;
  v_stats jsonb;
  v_count int;
begin
  with base as (
    select i.invoice_id, i.patient_id, i.amount, i.paid, i.payment_method,
           i.status, i.created_at,
           coalesce(p.name, '') as patient_name
      from invoices i
      left join patients p on p.patient_id = i.patient_id
     where (v_from is null or i.created_at >= v_from)
       and (v_to   is null or i.created_at <= v_to)
       and (v_st   is null or i.status = v_st)
       and (
         v_srch is null
         or i.invoice_id ilike '%'||v_srch||'%'
         or coalesce(p.name,'') ilike '%'||v_srch||'%'
       )
  ),
  page as (
    select * from base
    order by created_at desc, invoice_id desc
    limit v_lim offset v_off
  )
  select
    coalesce(jsonb_agg(to_jsonb(page.*) order by created_at desc, invoice_id desc), '[]'::jsonb),
    (select count(*)::int from base)
  into v_rows, v_count
  from page;

  select jsonb_build_object(
    'count',         v_count,
    'total_invoices',(select coalesce(sum(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'paid_amount',   (select coalesce(sum(paid),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'outstanding',   (select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'overdue_amount',(select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and i.status = 'متأخر'
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'avg_amount',    (select coalesce(avg(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%'))
  ) into v_stats;

  return jsonb_build_object(
    'rows',  v_rows,
    'stats', v_stats,
    'count', v_count,
    'limit', v_lim,
    'offset',v_off
  );
end;
$$;


-- ═════════════════════════════════════════════════════════════
-- 2. TREATMENT PLAN TEMPLATES ("قوالب خطط العلاج")
-- Full library of reusable treatment plans doctors can apply to
-- patients. Exercises/methods/goals live inline as
-- JSONB arrays so a template is one atomic row + one round-trip.
-- Versions and usage are tracked in side tables for restore &
-- statistics. Receptionists have no access. Doctors + admins can
-- create/edit; therapists can view + apply.
-- ═════════════════════════════════════════════════════════════



-- ═════════════════════════════════════════════════════════════
-- 3. TREATMENT METHODS v2 (icon / color / display_order + hard delete)
-- Adds visual attributes and a delete RPC that refuses to remove
-- methods used by any template. Existing v1 create/update RPCs
-- stay intact so old callers still work.
-- ═════════════════════════════════════════════════════════════


-- ── RPC: hard delete (blocks if referenced by any template) ──
-- Templates store methods as JSONB [{method_id, name}]. Block the
-- delete if either the id OR the name appears in any template.
create or replace function public.delete_treatment_method(
  p_method_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_row  treatment_methods%rowtype;
  v_hits int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_methods where method_id = p_method_id for update;
  if not found then raise exception 'طريقة العلاج غير موجودة'; end if;

  select count(*) into v_hits
    from treatment_templates t
   where exists (
     select 1 from jsonb_array_elements(coalesce(t.methods,'[]'::jsonb)) elem
      where elem->>'method_id' = p_method_id
         or lower(coalesce(elem->>'name','')) = lower(v_row.name)
   );
  if v_hits > 0 then
    raise exception 'لا يمكن حذف طريقة مستخدمة في % قالب — استخدم الأرشفة بدلاً منها', v_hits;
  end if;

  delete from treatment_methods where method_id = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tx_method_delete', 'treatment_methods', p_method_id, to_jsonb(v_row));

  return jsonb_build_object('method_id', p_method_id, 'deleted', true);
end;
$$;


-- ═════════════════════════════════════════════════════════════
-- 4. TEMPLATE CATEGORIES ("فئات القوالب")
-- Managed from Settings → قوالب خطط العلاج. Templates.category
-- remains free-text on the row so historical templates keep their
-- category even after a category is archived or renamed; the
-- categories table is the *authoritative source* for the picker.
-- ═════════════════════════════════════════════════════════════


-- ── RPC: upsert (create or rename/reorder) category ──────────
create or replace function public.upsert_template_category(
  p_category_id text,
  p_payload     jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_id   text := p_category_id;
  v_old  template_categories%rowtype;
  v_dup  int;
  v_action text;
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
  v_action := case when found then 'tpl_cat_update' else 'tpl_cat_create' end;

  select count(*) into v_dup from template_categories
    where lower(trim(name)) = lower(v_name) and category_id <> v_id;
  if v_dup > 0 then raise exception 'اسم الفئة موجود مسبقًا'; end if;

  if found then
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
$$;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 3. MIGRATION — extended patient fields + unique indexes
-- │ (source: supabase-migration-patients-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════
-- Migration 2026-07-12: extend `patients` for the full edit workflow.
--   Safe to re-run — every statement is idempotent.
--
-- Adds the demographic/medical fields required by the Patient edit PRD
-- and unique indexes on national_id + medical_file_no so duplicates are
-- caught at the DB layer (not just client validation).
-- ══════════════════════════════════════════════════════════════════════

alter table patients add column if not exists medical_file_no  text;
alter table patients add column if not exists national_id      text;
alter table patients add column if not exists whatsapp         text;
alter table patients add column if not exists email            text;
alter table patients add column if not exists date_of_birth    date;
alter table patients add column if not exists address          text;
alter table patients add column if not exists occupation       text;
alter table patients add column if not exists emergency_name   text;
alter table patients add column if not exists emergency_phone  text;
alter table patients add column if not exists doctor_id        text;
alter table patients add column if not exists medical_history  text;
alter table patients add column if not exists allergies        text;
alter table patients add column if not exists medications      text;
alter table patients add column if not exists insurance_info   text;
alter table patients add column if not exists status           text default 'نشط';
alter table patients add column if not exists updated_at       timestamptz default now();

-- Uniqueness: national ID and medical file number must not collide across
-- patients, but empty strings are allowed since the fields are optional.
create unique index if not exists patients_national_id_uniq
  on patients(national_id)
  where national_id is not null and national_id <> '';

create unique index if not exists patients_medical_file_uniq
  on patients(medical_file_no)
  where medical_file_no is not null and medical_file_no <> '';

-- Bump updated_at on every UPDATE so the client can detect staleness
-- if it wants to; harmless if the trigger already exists from an earlier
-- migration under a different name.
create or replace function patients_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists patients_updated_at on patients;
create trigger patients_updated_at before update on patients
  for each row execute function patients_touch_updated_at();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 4. MIGRATION — patient_files metadata, FKs, indexes
-- │ (source: supabase-migration-files-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Clinksys — patient_files hardening + FKs + indexes
-- Idempotent. Run in Supabase SQL editor.
-- Goals:
--   • Expand patient_files metadata (storage_path, original_name,
--     mime_type, file_size, uploaded_by, uploaded_by_name).
--   • Add FKs on bookings/patients/sessions therapist/doctor/department.
--   • Add missing indexes for patient_id lookups.
-- ============================================================

-- ── patient_files metadata expansion ────────────────────────
alter table patient_files add column if not exists storage_path      text;
alter table patient_files add column if not exists original_name     text;
alter table patient_files add column if not exists mime_type         text;
alter table patient_files add column if not exists file_size         bigint;
alter table patient_files add column if not exists uploaded_by_name  text;

-- Backfill mime_type from legacy file_type column where empty.
update patient_files set mime_type = file_type where mime_type is null and file_type is not null;
-- Backfill original_name from file_name where empty.
update patient_files set original_name = file_name where original_name is null;

-- One storage object per file_id — cheap dup guard.
create unique index if not exists patient_files_storage_path_uniq
  on patient_files(storage_path) where storage_path is not null;

create index if not exists patient_files_uploaded_at_idx
  on patient_files(uploaded_at desc);

-- ── Referential integrity: bookings ─────────────────────────
-- Null out orphans so FK creation succeeds; production data should
-- already reference live rows, but this makes the migration re-runnable
-- against dirty environments.
update bookings b set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = b.therapist_id);
update bookings b set doctor_id = null
  where doctor_id is not null
    and not exists (select 1 from doctors d where d.id = b.doctor_id);
update bookings b set department_id = null
  where department_id is not null
    and not exists (select 1 from departments d where d.id = b.department_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_therapist_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_doctor_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_doctor_id_fkey
      foreign key (doctor_id) references doctors(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_department_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_department_id_fkey
      foreign key (department_id) references departments(id) on delete set null;
  end if;
end $$;

-- ── Referential integrity: patients & sessions ──────────────
update patients p set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = p.therapist_id);
update sessions s set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = s.therapist_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'patients_therapist_id_fkey'
  ) then
    alter table patients
      add constraint patients_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_therapist_id_fkey'
  ) then
    alter table sessions
      add constraint sessions_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
end $$;

-- ── Hot-path indexes ────────────────────────────────────────
create index if not exists bookings_patient_id_idx   on bookings(patient_id);
create index if not exists bookings_date_idx         on bookings(date);
create index if not exists sessions_patient_id_idx   on sessions(patient_id);
create index if not exists invoices_patient_id_idx   on invoices(patient_id);
create index if not exists bookings_therapist_id_idx on bookings(therapist_id);
create index if not exists bookings_doctor_id_idx    on bookings(doctor_id);

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 5. MIGRATION — clinic settings columns + staff provenance
-- │ (source: supabase-migration-settings-users-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════
-- Migration 2026-07-12: fix clinic settings persistence + user management
--
-- ROOT CAUSE (clinic settings): the `clinic_settings` table only had the
-- columns { id, name, subtitle, logo, primary_color, updated_at }, but
-- the Settings form was upserting { branch, phone, email, address,
-- tax_id, hours, ... }. PostgREST rejected every save with 400 because
-- those columns did not exist. The client ignored the response, showed
-- "saved" from a local optimistic update, then the next page load
-- fetched the untouched singleton row and everything "reverted".
--
-- ROOT CAUSE (users): the `staff` table lacked `status`, `created_by`,
-- and `created_at`, so the admin-create flow could not record the
-- provenance the PRD requires.
--
-- Fix: add every column that the client actually writes, and refresh
-- the RLS policies so admins can INSERT + UPDATE the singleton row.
-- Safe to re-run — every statement is idempotent.
-- ══════════════════════════════════════════════════════════════════════

-- ── clinic_settings: add every field the Settings form exposes ──
alter table clinic_settings add column if not exists branch                text;
alter table clinic_settings add column if not exists phone                 text;
alter table clinic_settings add column if not exists email                 text;
alter table clinic_settings add column if not exists address               text;
alter table clinic_settings add column if not exists tax_id                text;
alter table clinic_settings add column if not exists hours                 text;
alter table clinic_settings add column if not exists website               text;
alter table clinic_settings add column if not exists currency              text default 'EGP';
alter table clinic_settings add column if not exists timezone              text default 'Africa/Cairo';
alter table clinic_settings add column if not exists appointment_duration  int  default 30;

-- ── staff: provenance columns the PRD requires ──
alter table staff add column if not exists status      text default 'active';
alter table staff add column if not exists created_by  uuid;
alter table staff add column if not exists created_at  timestamptz default now();

-- Backfill created_at for pre-existing rows so downstream sorts don't NaN.
update staff set created_at = now() where created_at is null;

-- Case-insensitive uniqueness on email — the current text-unique index is
-- case-sensitive and would let "user@x" and "User@x" coexist.
create unique index if not exists staff_email_lower_uniq
  on staff (lower(email))
  where email is not null and email <> '';

-- ══════════════════════════════════════════════════════════════════════
-- Notes for the operator:
--   • Deploy the `admin-create-user` Edge Function alongside this
--     migration so the client can create users without triggering the
--     GoTrue signup email rate limit.
--   • If you must keep the anon signUp fallback, go to Supabase
--     Dashboard → Authentication → Providers → Email and either
--     (a) disable "Confirm email", or (b) increase the SMTP quota.
-- ══════════════════════════════════════════════════════════════════════

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 6. MIGRATION — staff-table roles + staff-wide patient INSERT (RLS)
-- │ (source: supabase-migration-import-auth-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Migration 2026-07-12: Import-page auth + staff-wide patient INSERT
-- Idempotent — safe to re-run in the Supabase SQL editor.
--
-- Root causes fixed:
--   1. public.app_role() trusted the JWT's user_metadata.role — a value
--      any signed-in user can rewrite for themselves via
--      auth.updateUser({ data: { role: 'admin' } }). Role checks now read
--      the `staff` table in PostgreSQL by auth.uid(); only an admin can
--      write staff rows, so roles are server-controlled.
--   2. RLS allowed INSERT on patients / patient_files / the patient-files
--      storage bucket only for admin + receptionist. Every staff role
--      (admin, receptionist, doctor, therapist) can now register patients
--      and upload their documents. Deleting patients stays restricted to
--      admin + receptionist.
--
-- RLS stays ENABLED on every table — policies are replaced, not dropped.
-- ============================================================

-- ── 1. Backfill staff rows ───────────────────────────────────
-- app_role() now resolves from staff.auth_uid, so every auth user that
-- was provisioned with a staff role in user_metadata needs a staff row.
-- (Accounts created through the app already have one; this catches any
-- created directly in the dashboard.)
insert into staff (staff_id, name, role, email, auth_uid)
select
  'ST-' || left(u.id::text, 8),
  coalesce(u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
  u.raw_user_meta_data->>'role',
  u.email,
  u.id
from auth.users u
where u.raw_user_meta_data->>'role' in ('admin','receptionist','doctor','therapist')
  and not exists (select 1 from staff s where s.auth_uid = u.id)
on conflict (staff_id) do nothing;

-- ── 6. Belt-and-braces table grants ──────────────────────────
-- Supabase grants these by default; restated so a hardened project that
-- revoked defaults still lets RLS be the single gate.
grant select, insert, update, delete on patients      to authenticated;
grant select, insert, update, delete on patient_files to authenticated;
grant select on staff to authenticated;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 7. MIGRATION — treatments (records created from templates)
-- │ (source: supabase-migration-treatments-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Migration 2026-07-12 — Treatments (سجلات العلاج)
--
-- Turns the template workflow into a real record flow:
-- clicking «استخدام» on a قالب opens the treatment form with every
-- template field pre-filled; saving inserts an independent row here.
-- The row keeps a full copy of every clinical field PLUS the id,
-- version and snapshot of the template that generated it, so later
-- template edits never change existing treatments and vice-versa.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- Templates can carry file attachments (copied into treatments on use).
alter table treatment_templates add column if not exists attachments jsonb not null default '[]'::jsonb;

-- ── Treatments table ──────────────────────────────────────────
create table if not exists treatments (
  treatment_id           text primary key,
  patient_id             text not null references patients(patient_id) on delete cascade,
  therapist_id           text not null,
  therapist_name         text,
  -- Template linkage (audit only — values below are independent copies).
  template_id            text references treatment_templates(template_id),
  template_version       int,
  template_name          text,
  template_snapshot      jsonb,          -- full template row at apply time
  -- Clinical fields (copied from the template, editable before save).
  name                   text,
  category               text,
  diagnosis              text,
  body_part              text,
  goals                  jsonb not null default '[]'::jsonb,
  exercises              jsonb not null default '[]'::jsonb,
  methods                jsonb not null default '[]'::jsonb,
  home_instructions      text,
  notes                  text,
  warnings               text,
  followup_instructions  text,
  estimated_sessions     int,
  weekly_frequency       int,
  expected_recovery_days int,
  attachments            jsonb not null default '[]'::jsonb,
  extra_fields           jsonb not null default '{}'::jsonb,  -- future custom fields, no schema change needed
  treatment_date         date default current_date,
  start_date             date,
  status                 text not null default 'active'
                           check (status in ('draft','active','completed','cancelled')),
  created_by             uuid,
  created_by_name        text,
  updated_by             uuid,
  updated_by_name        text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) treatments so later indexes/constraints/policies resolve
alter table treatments add column if not exists treatment_id text;
alter table treatments add column if not exists patient_id text;
alter table treatments add column if not exists therapist_id text;
alter table treatments add column if not exists therapist_name text;
alter table treatments add column if not exists template_id text;
alter table treatments add column if not exists template_version int;
alter table treatments add column if not exists template_name text;
alter table treatments add column if not exists template_snapshot jsonb;
alter table treatments add column if not exists name text;
alter table treatments add column if not exists category text;
alter table treatments add column if not exists diagnosis text;
alter table treatments add column if not exists body_part text;
alter table treatments add column if not exists goals jsonb default '[]'::jsonb;
alter table treatments add column if not exists exercises jsonb default '[]'::jsonb;
alter table treatments add column if not exists methods jsonb default '[]'::jsonb;
alter table treatments add column if not exists home_instructions text;
alter table treatments add column if not exists notes text;
alter table treatments add column if not exists warnings text;
alter table treatments add column if not exists followup_instructions text;
alter table treatments add column if not exists estimated_sessions int;
alter table treatments add column if not exists weekly_frequency int;
alter table treatments add column if not exists expected_recovery_days int;
alter table treatments add column if not exists attachments jsonb default '[]'::jsonb;
alter table treatments add column if not exists extra_fields jsonb default '{}'::jsonb;
alter table treatments add column if not exists treatment_date date default current_date;
alter table treatments add column if not exists start_date date;
alter table treatments add column if not exists status text default 'active';
alter table treatments add column if not exists created_by uuid;
alter table treatments add column if not exists created_by_name text;
alter table treatments add column if not exists updated_by uuid;
alter table treatments add column if not exists updated_by_name text;
alter table treatments add column if not exists created_at timestamptz default now();
alter table treatments add column if not exists updated_at timestamptz default now();

create index if not exists treatments_patient_idx   on treatments(patient_id);
create index if not exists treatments_therapist_idx on treatments(therapist_id);
create index if not exists treatments_template_idx  on treatments(template_id);
create index if not exists treatments_created_idx   on treatments(created_at desc);

alter table treatments enable row level security;

-- Read: clinical roles. Writes go through the security-definer RPCs only.
drop policy if exists "clinical read treatments" on treatments;
create policy "clinical read treatments" on treatments for select using (
  public.app_role() in ('admin','doctor','therapist')
);

-- ── RPC: create a treatment (optionally from a template) ─────
-- When p_payload->>'template_id' is set, EVERY clinical field of the
-- template is copied first, then the payload (the doctor's edits) is
-- merged on top — so fields the client never rendered still arrive in
-- the treatment row. Validates patient, therapist and template before
-- inserting, logs template_usage and bumps usage_count in the same
-- transaction as the insert.
create or replace function public.create_treatment(
  p_treatment_id text,
  p_payload      jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_tpl    treatment_templates%rowtype;
  v_tpl_id text := nullif(btrim(coalesce(p_payload->>'template_id','')),'');
  v_pat_id text := nullif(btrim(coalesce(p_payload->>'patient_id','')),'');
  v_th_id  text := nullif(btrim(coalesce(p_payload->>'therapist_id','')),'');
  v_th_nm  text;
  v_base   jsonb := '{}'::jsonb;
  v_data   jsonb;
  v_use_id text;
  v_status text := coalesce(nullif(btrim(coalesce(p_payload->>'status','')),''),'active');
  v_row    treatments%rowtype;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  if p_treatment_id is null or btrim(p_treatment_id) = '' then
    raise exception 'معرّف العلاج مفقود';
  end if;

  -- 1. المريض موجود؟
  if v_pat_id is null then raise exception 'اختر المريض'; end if;
  if not exists (select 1 from patients where patient_id = v_pat_id) then
    raise exception 'المريض غير موجود';
  end if;

  -- 2. الأخصائي موجود؟ (roster أو جدول الموظفين)
  if v_th_id is null then raise exception 'اختر الأخصائي المسؤول'; end if;
  select name into v_th_nm from therapists where id = v_th_id;
  if v_th_nm is null then
    select name into v_th_nm from staff
     where staff_id = v_th_id and role in ('therapist','doctor','admin');
  end if;
  if v_th_nm is null then raise exception 'الأخصائي غير موجود'; end if;

  -- 3. القالب موجود؟ انسخ كل حقوله كقاعدة ثم طبّق تعديلات الطبيب فوقها.
  if v_tpl_id is not null then
    select * into v_tpl from treatment_templates where template_id = v_tpl_id;
    if v_tpl.template_id is null then raise exception 'القالب غير موجود'; end if;
    if v_tpl.status = 'archived' then raise exception 'لا يمكن استخدام قالب مؤرشف'; end if;
    v_base := jsonb_build_object(
      'name',                   v_tpl.name,
      'category',               v_tpl.category,
      'diagnosis',              v_tpl.diagnosis,
      'body_part',              v_tpl.body_part,
      'goals',                  v_tpl.goals,
      'exercises',              v_tpl.exercises,
      'methods',                v_tpl.methods,
      'home_instructions',      v_tpl.home_instructions,
      'notes',                  v_tpl.notes,
      'warnings',               v_tpl.warnings,
      'followup_instructions',  v_tpl.followup_instructions,
      'estimated_sessions',     v_tpl.estimated_sessions,
      'weekly_frequency',       v_tpl.weekly_frequency,
      'expected_recovery_days', v_tpl.expected_recovery_days,
      'attachments',            v_tpl.attachments
    );
  end if;
  v_data := jsonb_strip_nulls(v_base) || jsonb_strip_nulls(coalesce(p_payload,'{}'::jsonb));

  insert into treatments (
    treatment_id, patient_id, therapist_id, therapist_name,
    template_id, template_version, template_name, template_snapshot,
    name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    attachments, extra_fields, treatment_date, start_date, status,
    created_by, created_by_name, updated_by, updated_by_name
  ) values (
    p_treatment_id, v_pat_id, v_th_id, v_th_nm,
    v_tpl.template_id, v_tpl.version, v_tpl.name,
    case when v_tpl.template_id is null then null else to_jsonb(v_tpl) end,
    v_data->>'name', v_data->>'category', v_data->>'diagnosis', v_data->>'body_part',
    coalesce(v_data->'goals','[]'::jsonb),
    coalesce(v_data->'exercises','[]'::jsonb),
    coalesce(v_data->'methods','[]'::jsonb),
    v_data->>'home_instructions', v_data->>'notes', v_data->>'warnings', v_data->>'followup_instructions',
    nullif(v_data->>'estimated_sessions','')::int,
    nullif(v_data->>'weekly_frequency','')::int,
    nullif(v_data->>'expected_recovery_days','')::int,
    coalesce(v_data->'attachments','[]'::jsonb),
    coalesce(v_data->'extra_fields','{}'::jsonb),
    coalesce(nullif(v_data->>'treatment_date','')::date, current_date),
    nullif(v_data->>'start_date','')::date,
    case when v_status in ('draft','active','completed','cancelled') then v_status else 'active' end,
    v_uid, v_name, v_uid, v_name
  );

  -- Usage log + counter — only now that the treatment really exists.
  if v_tpl.template_id is not null then
    v_use_id := 'TU-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
             || upper(substr(md5(random()::text),1,4));
    insert into template_usage (use_id, template_id, patient_id, plan_id, applied_by, applied_by_name)
    values (v_use_id, v_tpl.template_id, v_pat_id, p_treatment_id, v_uid, v_name);
    update treatment_templates
       set usage_count  = coalesce(usage_count,0) + 1,
           last_used_at = now()
     where template_id = v_tpl.template_id;
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_create', 'treatments', p_treatment_id,
    jsonb_build_object('patient_id', v_pat_id, 'therapist_id', v_th_id,
                       'template_id', v_tpl.template_id, 'template_version', v_tpl.version,
                       'use_id', v_use_id));

  select * into v_row from treatments where treatment_id = p_treatment_id;
  return to_jsonb(v_row);
end;
$$;
grant execute on function public.create_treatment(text, jsonb) to authenticated;

-- ── RPC: update a treatment ───────────────────────────────────
-- Touches ONLY the treatment row. The originating template — and the
-- snapshot/version stored here — are never modified.
create or replace function public.update_treatment(
  p_treatment_id text,
  p_payload      jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_th_id text := nullif(btrim(coalesce(p_payload->>'therapist_id','')),'');
  v_th_nm text;
  v_row  treatments%rowtype;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatments where treatment_id = p_treatment_id;
  if v_row.treatment_id is null then raise exception 'سجل العلاج غير موجود'; end if;

  if p_payload ? 'patient_id'
     and nullif(btrim(coalesce(p_payload->>'patient_id','')),'') is distinct from v_row.patient_id then
    if not exists (select 1 from patients where patient_id = p_payload->>'patient_id') then
      raise exception 'المريض غير موجود';
    end if;
  end if;
  if v_th_id is not null and v_th_id is distinct from v_row.therapist_id then
    select name into v_th_nm from therapists where id = v_th_id;
    if v_th_nm is null then
      select name into v_th_nm from staff
       where staff_id = v_th_id and role in ('therapist','doctor','admin');
    end if;
    if v_th_nm is null then raise exception 'الأخصائي غير موجود'; end if;
  end if;

  update treatments set
    patient_id             = coalesce(nullif(btrim(coalesce(p_payload->>'patient_id','')),''), patient_id),
    therapist_id           = coalesce(v_th_id, therapist_id),
    therapist_name         = coalesce(v_th_nm, therapist_name),
    name                   = coalesce(p_payload->>'name', name),
    category               = case when p_payload ? 'category'  then p_payload->>'category'  else category  end,
    diagnosis              = case when p_payload ? 'diagnosis' then p_payload->>'diagnosis' else diagnosis end,
    body_part              = case when p_payload ? 'body_part' then p_payload->>'body_part' else body_part end,
    goals                  = coalesce(p_payload->'goals', goals),
    exercises              = coalesce(p_payload->'exercises', exercises),
    methods                = coalesce(p_payload->'methods', methods),
    home_instructions      = case when p_payload ? 'home_instructions'     then p_payload->>'home_instructions'     else home_instructions end,
    notes                  = case when p_payload ? 'notes'                 then p_payload->>'notes'                 else notes end,
    warnings               = case when p_payload ? 'warnings'              then p_payload->>'warnings'              else warnings end,
    followup_instructions  = case when p_payload ? 'followup_instructions' then p_payload->>'followup_instructions' else followup_instructions end,
    estimated_sessions     = case when p_payload ? 'estimated_sessions'     then nullif(p_payload->>'estimated_sessions','')::int     else estimated_sessions end,
    weekly_frequency       = case when p_payload ? 'weekly_frequency'       then nullif(p_payload->>'weekly_frequency','')::int       else weekly_frequency end,
    expected_recovery_days = case when p_payload ? 'expected_recovery_days' then nullif(p_payload->>'expected_recovery_days','')::int else expected_recovery_days end,
    attachments            = coalesce(p_payload->'attachments', attachments),
    extra_fields           = coalesce(p_payload->'extra_fields', extra_fields),
    treatment_date         = coalesce(nullif(p_payload->>'treatment_date','')::date, treatment_date),
    start_date             = case when p_payload ? 'start_date' then nullif(p_payload->>'start_date','')::date else start_date end,
    status                 = case when coalesce(p_payload->>'status','') in ('draft','active','completed','cancelled')
                                  then p_payload->>'status' else status end,
    updated_by             = v_uid,
    updated_by_name        = v_name,
    updated_at             = now()
  where treatment_id = p_treatment_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_update', 'treatments', p_treatment_id, p_payload);

  select * into v_row from treatments where treatment_id = p_treatment_id;
  return to_jsonb(v_row);
end;
$$;
grant execute on function public.update_treatment(text, jsonb) to authenticated;

-- ── RPC: delete a treatment plan (سجل العلاج) ────────────────
-- Permanently removes one treatment record. Linked sessions are NOT
-- deleted: the sessions.treatment_id FK is `on delete set null`, so they
-- are automatically unlinked (and the completed-count trigger recounts).
-- Returns how many sessions were detached so the client can inform the
-- user. Admins and doctors only. Safe to re-run the definition.
create or replace function public.delete_treatment(
  p_treatment_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role     text := public.app_role();
  v_uid      uuid := auth.uid();
  v_unlinked int;
  v_row      treatments%rowtype;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatments where treatment_id = p_treatment_id;
  if not found then raise exception 'سجل العلاج غير موجود'; end if;

  -- Count the sessions that will be unlinked by the FK (on delete set null).
  select count(*)::int into v_unlinked from sessions where treatment_id = p_treatment_id;

  delete from treatments where treatment_id = p_treatment_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_delete', 'treatments', p_treatment_id, to_jsonb(v_row));

  return jsonb_build_object(
    'treatment_id', p_treatment_id,
    'deleted', true,
    'sessions_unlinked', v_unlinked
  );
end;
$$;
grant execute on function public.delete_treatment(text) to authenticated;

-- ── RPC: list treatments (joined with patient name) ──────────
create or replace function public.list_treatments(
  p_patient_id text default null,
  p_status     text default null,
  p_search     text default null,
  p_limit      int  default 200,
  p_offset     int  default 0
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_lim  int  := least(greatest(coalesce(p_limit,200),1),500);
  v_off  int  := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_pid  text := nullif(btrim(coalesce(p_patient_id,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;

  with base as (
    select t.*, p.name as patient_name
      from treatments t
      left join patients p on p.patient_id = t.patient_id
     where (v_pid  is null or t.patient_id = v_pid)
       and (v_st   is null or t.status = v_st)
       and (
         v_srch is null
         or t.treatment_id   ilike '%'||v_srch||'%'
         or coalesce(p.name,'')          ilike '%'||v_srch||'%'
         or coalesce(t.diagnosis,'')     ilike '%'||v_srch||'%'
         or coalesce(t.therapist_name,'') ilike '%'||v_srch||'%'
       )
  ),
  ordered as (
    select * from base order by created_at desc limit v_lim offset v_off
  )
  select coalesce(jsonb_agg(to_jsonb(ordered.*)),'[]'::jsonb),
         (select count(*)::int from base)
    into v_rows, v_cnt
    from ordered;

  return jsonb_build_object('rows', v_rows, 'count', v_cnt,
                            'limit', v_lim, 'offset', v_off);
end;
$$;
grant execute on function public.list_treatments(text,text,text,int,int) to authenticated;

-- ── RPC: fetch one treatment ──────────────────────────────────
create or replace function public.get_treatment(
  p_treatment_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_out jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) || jsonb_build_object('patient_name', p.name)
    into v_out
    from treatments t
    left join patients p on p.patient_id = t.patient_id
   where t.treatment_id = p_treatment_id;
  return v_out;
end;
$$;
grant execute on function public.get_treatment(text) to authenticated;

-- ── Guard: a template that generated treatments can't be deleted ──
-- delete_treatment_template already refuses when template_usage rows
-- exist (every treatment created from a template writes one). The FK
-- from treatments.template_id (no cascade) is the hard backstop.

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 8. MIGRATION — appointment scheduling: recurring patient schedules,
-- │    optional doctor / required therapist, calendar status indexes
-- │ (source: supabase-migration-scheduling-2026-07-13.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: appointment scheduling workflow (2026-07-13)
-- Run in the Supabase SQL editor (or via the CLI migration copy in
-- supabase/migrations/). Idempotent — safe to re-run.
--
-- 1. Bookings: the therapist session is the default/required
--    appointment and the doctor is optional. Structurally both
--    columns were already nullable; this migration documents the
--    contract and adds the indexes that power calendar status
--    filtering (cancelled rows are kept for history/reporting but
--    hidden from every calendar view by the app).
-- 2. patient_schedules: one active recurring pattern per patient —
--    fixed weekdays + fixed preferred time + therapist — used to
--    auto-suggest and generate future appointments. Editing it only
--    affects appointments created afterwards; past rows are never
--    touched.
-- ═══════════════════════════════════════════════════════════════

-- ── Bookings: calendar/status filtering indexes ───────────────
-- bookings.therapist_id  → required assignment (enforced by the app)
-- bookings.doctor_id     → optional, set only on explicit selection
create index if not exists bookings_status_idx    on bookings(status);
create index if not exists bookings_therapist_idx on bookings(therapist_id);
create index if not exists bookings_doctor_idx    on bookings(doctor_id);

-- ── Recurring preferred schedule (per patient-therapist) ──────
create table if not exists patient_schedules (
  schedule_id       text primary key,
  patient_id        text references patients(patient_id) on delete cascade,
  therapist_id      text,                        -- the patient's fixed therapist
  days              jsonb default '[]'::jsonb,   -- weekday numbers, 0=Sunday … 6=Saturday
  time              text,                        -- fixed preferred time, "HH:MM"
  sessions_per_week int default 0,
  allow_consecutive boolean default false,       -- intentional override of the
                                                 -- one-free-day-between-sessions rule
  active            boolean default true,
  notes             text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) patient_schedules so later indexes/constraints/policies resolve
alter table patient_schedules add column if not exists schedule_id text;
alter table patient_schedules add column if not exists patient_id text;
alter table patient_schedules add column if not exists therapist_id text;
alter table patient_schedules add column if not exists days jsonb default '[]'::jsonb;
alter table patient_schedules add column if not exists time text;
alter table patient_schedules add column if not exists sessions_per_week int default 0;
alter table patient_schedules add column if not exists allow_consecutive boolean default false;
alter table patient_schedules add column if not exists active boolean default true;
alter table patient_schedules add column if not exists notes text;
alter table patient_schedules add column if not exists created_at timestamptz default now();
alter table patient_schedules add column if not exists updated_at timestamptz default now();

create index if not exists patient_schedules_patient_idx   on patient_schedules(patient_id);
create index if not exists patient_schedules_therapist_idx on patient_schedules(therapist_id);

-- ── RLS ───────────────────────────────────────────────────────
alter table patient_schedules enable row level security;

drop policy if exists "staff read schedules" on patient_schedules;
create policy "staff read schedules" on patient_schedules for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
-- The therapist decides the recurring pattern; reception applies it.
drop policy if exists "staff write schedules" on patient_schedules;
create policy "staff write schedules" on patient_schedules for all using (
  public.app_role() in ('admin','receptionist','therapist')
) with check (
  public.app_role() in ('admin','receptionist','therapist')
);

-- Therapists may also manage bookings that belong to them (needed to
-- cancel/reschedule own sessions and to generate appointments from the
-- recurring schedule). Matches the sessions-table precedent; the
-- therapist can be linked either through staff.staff_id or therapists.id.
-- Older deployments predate the therapists.auth_uid link, so add it here.
alter table if exists therapists add column if not exists auth_uid uuid;
create index if not exists therapists_auth_uid_idx on therapists(auth_uid);

drop policy if exists "therapist writes own bookings" on bookings;
create policy "therapist writes own bookings" on bookings for all using (
  public.app_role() = 'therapist' and (
    therapist_id in (select staff_id from staff where auth_uid = auth.uid())
    or therapist_id in (select id from therapists where auth_uid = auth.uid())
  )
) with check (
  public.app_role() = 'therapist' and (
    therapist_id in (select staff_id from staff where auth_uid = auth.uid())
    or therapist_id in (select id from therapists where auth_uid = auth.uid())
  )
);

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 9. MIGRATION — staff roster columns: auth_uid/contact fields on
-- │    doctors + therapists, receptionists table (fixes PGRST204)
-- │ (source: supabase-migration-staff-roster-2026-07-13.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: staff roster columns (2026-07-13)
-- Fixes PGRST204 ("Could not find the 'auth_uid' column of 'doctors'
-- in the schema cache") when saving doctors / therapists /
-- receptionists from the staff-management screen.
--
-- The roster UI writes contact + account-link fields (auth_uid, phone,
-- email, license_number, notes, updated_at) that the original tables
-- never gained, and the receptionists table was never created at all.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── therapists: roster/profile fields ─────────────────────────
alter table therapists add column if not exists department_id  text references departments(id) on delete set null;
alter table therapists add column if not exists phone          text;
alter table therapists add column if not exists email          text;
alter table therapists add column if not exists license_number text;
alter table therapists add column if not exists notes          text;
alter table therapists add column if not exists active         boolean default true;
alter table therapists add column if not exists auth_uid       uuid;   -- links to auth.users.id
alter table therapists add column if not exists updated_at     timestamptz default now();

-- ── doctors: roster/profile fields ─────────────────────────────
alter table doctors add column if not exists phone          text;
alter table doctors add column if not exists email          text;
alter table doctors add column if not exists license_number text;
alter table doctors add column if not exists notes          text;
alter table doctors add column if not exists auth_uid       uuid;      -- links to auth.users.id
alter table doctors add column if not exists updated_at     timestamptz default now();
create index if not exists doctors_auth_uid_idx on doctors(auth_uid);

-- ── receptionists (roster) ─────────────────────────────────────
create table if not exists receptionists (
  id          text primary key,
  name        text not null,
  phone       text,
  email       text,
  notes       text,
  active      boolean default true,
  auth_uid    uuid,                                -- links to auth.users.id
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
-- self-heal: backfill columns on pre-existing (older-schema) receptionists so later indexes/constraints/policies resolve
alter table receptionists add column if not exists id text;
alter table receptionists add column if not exists name text;
alter table receptionists add column if not exists phone text;
alter table receptionists add column if not exists email text;
alter table receptionists add column if not exists notes text;
alter table receptionists add column if not exists active boolean default true;
alter table receptionists add column if not exists auth_uid uuid;
alter table receptionists add column if not exists created_at timestamptz default now();
alter table receptionists add column if not exists updated_at timestamptz default now();

create index if not exists receptionists_auth_uid_idx on receptionists(auth_uid);

alter table receptionists enable row level security;

-- Same posture as doctors/therapists: every staff role can read the
-- roster; only admin manages it.
drop policy if exists "staff read receptionists" on receptionists;
create policy "staff read receptionists" on receptionists for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin write receptionists" on receptionists;
create policy "admin write receptionists" on receptionists for all using (
  public.app_role() = 'admin'
) with check (
  public.app_role() = 'admin'
);


-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 10. MIGRATION — drop the removed `modalities` column from
-- │     treatment_templates and treatments
-- │ (source: supabase-migration-drop-modalities-2026-07-13.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Migration 2026-07-13 — Drop `modalities` column
--
-- The "الوسائل العلاجية" concept was removed from the product.
-- The treatment methods (طرق العلاج) field now covers every
-- clinical modality doctors select. This migration drops the
-- redundant column from both template and treatment tables and
-- rebuilds the RPCs that used to touch it.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table if exists treatment_templates drop column if exists modalities;
alter table if exists treatments           drop column if exists modalities;

-- The RPCs (create_treatment_template, update_treatment_template,
-- duplicate_treatment_template, restore_template_version,
-- create_treatment, update_treatment) are re-created by re-running
-- supabase-schema.sql and supabase-migration-treatments-2026-07-12.sql —
-- both of which no longer reference the column.

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 11. MIGRATION — configurable calendar working hours
-- │ (source: supabase-migration-calendar-hours-2026-07-13.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: configurable calendar working hours (2026-07-13)
--
-- The calendar grid and every time-slot picker previously hardcoded
-- 08:00–18:00. The working window now lives in clinic settings:
--   • calendar_start / calendar_end — visible time range
--   • appointment_duration (already existed) — slot duration
-- Every calendar view reads these live, so changing them in Settings
-- updates all therapist/doctor calendars immediately.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table clinic_settings add column if not exists calendar_start text default '08:00';
alter table clinic_settings add column if not exists calendar_end   text default '18:00';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 12. MIGRATION — treatment sessions ↔ treatment plans linkage,
-- │     session counters, packages column repair
-- │ (source: supabase-migration-sessions-plan-2026-07-13.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: link treatment sessions to treatment plans (2026-07-13)
--
-- Every treatment session (جلسة علاج) is generated from the patient's
-- active treatment plan (خطة العلاج):
--   • sessions.treatment_id  → the plan the session belongs to
--   • sessions.booking_id    → the appointment the session ran under
--   • per-session clinical payload: goals checked off, exercises
--     completed, mood, duration
--   • treatments.completed_sessions is maintained by a trigger — every
--     logged session updates the plan's completed/remaining counts
--     automatically, no manual bookkeeping.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── sessions: plan/appointment linkage + clinical payload ─────
alter table sessions add column if not exists treatment_id        text references treatments(treatment_id) on delete set null;
alter table sessions add column if not exists booking_id          text references bookings(booking_id) on delete set null;
alter table sessions add column if not exists goals               jsonb default '[]'::jsonb;
alter table sessions add column if not exists completed_exercises jsonb default '[]'::jsonb;
alter table sessions add column if not exists mood                int;
alter table sessions add column if not exists duration_minutes    int;

create index if not exists sessions_treatment_idx on sessions(treatment_id);
create index if not exists sessions_booking_idx   on sessions(booking_id);
create index if not exists sessions_patient_idx   on sessions(patient_id);

-- ── treatments: session counters ──────────────────────────────
-- estimated_sessions (already present) = total planned sessions.
-- completed_sessions = trigger-maintained count of logged sessions.
-- remaining = estimated_sessions - completed_sessions (computed in views/UI).
alter table treatments add column if not exists completed_sessions int default 0;

-- Recompute-based sync: correct under insert, delete, and re-linking a
-- session to a different plan; safe against replays.
create or replace function public.sync_treatment_session_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  v_ids := array_remove(array[
    case when tg_op in ('INSERT','UPDATE') then new.treatment_id end,
    case when tg_op in ('DELETE','UPDATE') then old.treatment_id end
  ], null);
  update treatments t
     set completed_sessions = (
           select count(*) from sessions s where s.treatment_id = t.treatment_id
         ),
         updated_at = now()
   where t.treatment_id = any(v_ids);
  return null;
end;
$$;

drop trigger if exists sessions_sync_treatment_count on sessions;
create trigger sessions_sync_treatment_count
  after insert or update of treatment_id or delete on sessions
  for each row execute function public.sync_treatment_session_count();

-- Backfill for databases that already have linked sessions (no-op when
-- treatment_id was just added).
update treatments t
   set completed_sessions = coalesce(
         (select count(*) from sessions s where s.treatment_id = t.treatment_id), 0);

-- ── packages: repair the FK-stub trap ─────────────────────────
-- The consolidated schema declared an id/name-only `packages` stub early
-- (so patient_subscriptions' FK resolves) and the full definition later —
-- but `create table if not exists` makes the later, full definition a
-- no-op, so databases created from scratch were missing these columns.
alter table packages add column if not exists sessions   int default 1;
alter table packages add column if not exists price      numeric default 0;
alter table packages add column if not exists active     boolean default true;
alter table packages add column if not exists popular    boolean default false;
alter table packages add column if not exists color      text default '#7BBDE8';
alter table packages add column if not exists sold       int default 0;
alter table packages add column if not exists created_at timestamptz default now();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 13. MIGRATION — persistent in-progress sessions (status/started_at)
-- │     + remove template version history (سجل الإصدارات)
-- │ (source: supabase/migrations/20260713050000_session_status_drop_versions.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: persistent in-progress sessions + drop template version
-- history (2026-07-13)
--
-- 1. Treatment sessions become durable the moment they START:
--    • sessions.status ('in_progress' | 'completed') + started_at
--    • the row is inserted at session start and updated at sign-off,
--      so navigation/refresh/re-login never loses a running session
--    • the plan counter only counts COMPLETED sessions
-- 2. Template version history (سجل الإصدارات) is removed end to end:
--    the snapshot writer becomes a no-op (existing RPC bodies keep
--    working), the restore RPC and the template_versions table are
--    dropped, and get_treatment_template stops returning versions.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── sessions: lifecycle status ─────────────────────────────────
alter table sessions add column if not exists status text default 'completed'
  check (status in ('in_progress','completed'));
alter table sessions add column if not exists started_at timestamptz;
create index if not exists sessions_status_idx on sessions(status);

-- Plan counters count only completed sessions.
create or replace function public.sync_treatment_session_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  v_ids := array_remove(array[
    case when tg_op in ('INSERT','UPDATE') then new.treatment_id end,
    case when tg_op in ('DELETE','UPDATE') then old.treatment_id end
  ], null);
  update treatments t
     set completed_sessions = (
           select count(*) from sessions s
            where s.treatment_id = t.treatment_id
              and coalesce(s.status, 'completed') = 'completed'
         ),
         updated_at = now()
   where t.treatment_id = any(v_ids);
  return null;
end;
$$;

drop trigger if exists sessions_sync_treatment_count on sessions;
create trigger sessions_sync_treatment_count
  after insert or update of treatment_id, status or delete on sessions
  for each row execute function public.sync_treatment_session_count();

-- Recount with the status filter applied.
update treatments t
   set completed_sessions = coalesce(
         (select count(*) from sessions s
           where s.treatment_id = t.treatment_id
             and coalesce(s.status, 'completed') = 'completed'), 0);

-- ── Template version history: removed ──────────────────────────
-- Neutralize the snapshot writer first — the template create/update/
-- duplicate RPCs still call it, and a no-op keeps them intact.
create or replace function public._tpl_write_version(
  p_template_id text, p_editor_uid uuid, p_editor_name text, p_summary text
) returns void language plpgsql security definer set search_path = public as $$
begin
  -- Version history was removed from the product; intentionally a no-op.
  return;
end;
$$;

-- get_treatment_template no longer returns a versions payload.
create or replace function public.get_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_tpl jsonb;
  v_stats jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) into v_tpl from treatment_templates t where t.template_id = p_template_id;
  if v_tpl is null then return null; end if;

  select jsonb_build_object(
    'usage_count',    coalesce(count(*),0),
    'completion_rate',coalesce(round(avg( (completed_at is not null)::int )::numeric * 100, 1), 0),
    'avg_recovery',   coalesce(round(avg(recovery_days),1), 0),
    'last_used_at',   max(applied_at)
  ) into v_stats
    from template_usage where template_id = p_template_id;

  return jsonb_build_object('template', v_tpl, 'stats', v_stats);
end;
$$;
grant execute on function public.get_treatment_template(text) to authenticated;

-- Drop the restore RPC (references the table) then the table and the
-- now-unused snapshot helper.
drop function if exists public.restore_template_version(text);
drop table if exists template_versions;
drop function if exists public._tpl_snapshot(text);


-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 14. SEED — main admin account (skipped if it already exists)
-- │ (source: seed-admin.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Kinetic — Main admin account: "amir"
--
-- Run this ONCE in the Supabase SQL editor, AFTER running
-- supabase-schema.sql.
--
--   Email:    amr@clinic.eg
--   Password: Amr@2026!     ←  CHANGE THIS after first login
--                                (Supabase Dashboard → Authentication →
--                                 Users → amr@clinic.eg → Reset password)
--
-- What it does:
--   1. Creates the Supabase Auth user (role "admin" is kept in
--      user_metadata for display, but permissions come from staff).
--   2. Creates the matching row in the `staff` table, linked via
--      auth_uid. This row is what public.app_role() and the app read
--      to authorize the user — it MUST exist for the account to work.
--
-- Safe to re-run: it skips the auth user if the email already exists
-- and upserts the staff row.
-- ============================================================

create extension if not exists pgcrypto;

do $$
declare
  uid uuid;
begin
  select id into uid from auth.users where email = 'amr@clinic.eg';

  if uid is null then
    uid := gen_random_uuid();

    -- NOTE: the *_token / *_change columns must be '' (not NULL) — GoTrue
    -- returns 500 "Database error" on login when they are NULL, which is
    -- the classic pitfall of SQL-created auth users.
    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token,
      email_change, email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token,
      is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000',
      uid,
      'authenticated',
      'authenticated',
      'amr@clinic.eg',
      crypt('Amr@2026!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"role":"admin","name":"أمير"}'::jsonb,
      now(), now(),
      '', '',
      '', '', '',
      '', '',
      '',
      false
    );

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      uid,
      uid::text,
      jsonb_build_object('sub', uid::text, 'email', 'amr@clinic.eg', 'email_verified', true),
      'email',
      now(), now(), now()
    );
  end if;

  -- Repair pass: if the user was created by an earlier version of this
  -- script (or any SQL insert) with NULL token columns, GoTrue answers
  -- every login with 500. Normalize them to '' so sign-in works.
  update auth.users set
    confirmation_token         = coalesce(confirmation_token, ''),
    recovery_token             = coalesce(recovery_token, ''),
    email_change               = coalesce(email_change, ''),
    email_change_token_new     = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    phone_change               = coalesce(phone_change, ''),
    phone_change_token         = coalesce(phone_change_token, ''),
    reauthentication_token     = coalesce(reauthentication_token, ''),
    email_confirmed_at         = coalesce(email_confirmed_at, now()),
    raw_user_meta_data         = coalesce(raw_user_meta_data, '{}'::jsonb)
                                   || '{"role":"admin","name":"أمير"}'::jsonb
  where email = 'amr@clinic.eg';

  insert into staff (staff_id, name, role, email, auth_uid)
  values ('ST-AMR', 'عمرو', 'admin', 'amr@clinic.eg', uid)
  on conflict (staff_id) do update
    set auth_uid = excluded.auth_uid,
        role     = 'admin',
        email    = excluded.email,
        name     = excluded.name;
end $$;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 15. SEED — clinic staff: therapists + receptionist
-- │ (source: seed-staff.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Kinetic — Staff seed: therapists + receptionist
--
-- Creates login accounts + staff rows for the clinic team:
--   Therapists (role "therapist"):
--     • دكتور عبد الرحمن   abdelrahman@clinic.eg
--     • دكتور اسماعيل      esmail@clinic.eg
--     • دكتور منه          menna@clinic.eg
--     • دكتور داليا        dalia@clinic.eg
--     • دكتور روضة         rawda@clinic.eg
--   Receptionist (role "receptionist"):
--     • مريم               mariam@clinic.eg
--
--   Password (ALL accounts): Clinic@2026!
--     ←  CHANGE THIS after first login
--        (Dashboard → Authentication → Users → Reset password)
--
-- What it does, per person:
--   1. Creates the Supabase Auth user (skipped if the email exists),
--      with the *_token / *_change columns set to '' — NULLs there make
--      GoTrue answer every login with a 500, the classic SQL-user pitfall.
--   2. Creates the matching auth.identities row (email provider).
--   3. Upserts the `staff` row (auth_uid + role) — this is what
--      public.app_role() reads to authorize the account.
--   4. For therapists only, upserts the `therapists` roster row so they
--      appear in the "الأخصائي المسؤول" picker on treatment plans. The
--      roster id equals the staff_id so every person has one canonical id.
--
-- Idempotent: safe to re-run. Run AFTER supabase-schema.sql (or just run
-- supabase-all-in-one.sql, which already includes this).
-- ============================================================


do $$
declare
  r   record;
  uid uuid;
begin
  for r in
    select * from (values
      ('abdelrahman@clinic.eg', 'دكتور عبد الرحمن', 'therapist',    'ST-ABDELRAHMAN'),
      ('esmail@clinic.eg',      'دكتور اسماعيل',    'therapist',    'ST-ESMAIL'),
      ('menna@clinic.eg',       'دكتور منه',        'therapist',    'ST-MENNA'),
      ('dalia@clinic.eg',       'دكتور داليا',      'therapist',    'ST-DALIA'),
      ('rawda@clinic.eg',       'دكتور روضة',       'therapist',    'ST-RAWDA'),
      ('mariam@clinic.eg',      'مريم',             'receptionist', 'ST-MARIAM')
    ) as t(email, name, role, staff_id)
  loop
    select id into uid from auth.users where email = r.email;

    if uid is null then
      uid := gen_random_uuid();

      insert into auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at,
        confirmation_token, recovery_token,
        email_change, email_change_token_new, email_change_token_current,
        phone_change, phone_change_token, reauthentication_token,
        is_sso_user
      ) values (
        '00000000-0000-0000-0000-000000000000',
        uid,
        'authenticated',
        'authenticated',
        r.email,
        crypt('Clinic@2026!', gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('role', r.role, 'name', r.name),
        now(), now(),
        '', '',
        '', '', '',
        '', '',
        '',
        false
      );

      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(),
        uid,
        uid::text,
        jsonb_build_object('sub', uid::text, 'email', r.email, 'email_verified', true),
        'email',
        now(), now(), now()
      );
    end if;

    -- Repair pass: normalize NULL token columns (login-breaking) and keep
    -- the display role/name in metadata current.
    update auth.users set
      confirmation_token         = coalesce(confirmation_token, ''),
      recovery_token             = coalesce(recovery_token, ''),
      email_change               = coalesce(email_change, ''),
      email_change_token_new     = coalesce(email_change_token_new, ''),
      email_change_token_current = coalesce(email_change_token_current, ''),
      phone_change               = coalesce(phone_change, ''),
      phone_change_token         = coalesce(phone_change_token, ''),
      reauthentication_token     = coalesce(reauthentication_token, ''),
      email_confirmed_at         = coalesce(email_confirmed_at, now()),
      raw_user_meta_data         = coalesce(raw_user_meta_data, '{}'::jsonb)
                                     || jsonb_build_object('role', r.role, 'name', r.name)
    where email = r.email;

    -- Authorization row. `staff.role` is the source of truth for app_role().
    insert into staff (staff_id, name, role, email, auth_uid)
    values (r.staff_id, r.name, r.role, r.email, uid)
    on conflict (staff_id) do update
      set auth_uid = excluded.auth_uid,
          role     = excluded.role,
          email    = excluded.email,
          name     = excluded.name;
  end loop;

  -- Therapist roster (only the therapists) — feeds the treatment-plan
  -- "الأخصائي المسؤول" picker. id == staff_id so it's one canonical id.
  insert into therapists (id, name, spec) values
    ('ST-ABDELRAHMAN', 'دكتور عبد الرحمن', 'أخصائي علاج طبيعي'),
    ('ST-ESMAIL',      'دكتور اسماعيل',    'أخصائي علاج طبيعي'),
    ('ST-MENNA',       'دكتور منه',        'أخصائي علاج طبيعي'),
    ('ST-DALIA',       'دكتور داليا',      'أخصائي علاج طبيعي'),
    ('ST-RAWDA',       'دكتور روضة',       'أخصائي علاج طبيعي')
  on conflict (id) do update
    set name = excluded.name,
        spec = excluded.spec;
end $$;

-- Refresh the PostgREST schema cache once, after all DDL above.
notify pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 12. MIGRATION — staff account status enforcement + admin actions    │
-- │ (admin password reset, activate/deactivate, audit trail)            │
-- └────────────────────────────────────────────────────────────────────┘
-- ══════════════════════════════════════════════════════════════════════
-- A staff account can be deactivated by an admin. A deactivated account:
--   • cannot sign in (blocked in signInEmail on the client, and the
--     Auth user is banned via the admin API so token refresh fails);
--   • loses ALL data access even with a still-valid access token, because
--     public.app_role() below returns NULL for a non-active staff row, so
--     every RLS policy that checks app_role() denies the request;
--   • keeps its row + all historical data (appointments, sessions,
--     invoices, audit logs) fully intact.
-- Reactivation simply flips status back to 'active' and unbans the user.
-- ══════════════════════════════════════════════════════════════════════

-- Status column already added earlier (default 'active'); make sure every
-- pre-existing row has a concrete value and constrain it to known states.
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

-- app_role() now resolves to the role ONLY for an ACTIVE staff row. A
-- deactivated (or missing) account resolves to NULL, so every RLS policy
-- that gates on app_role() denies it — this is the server-side teeth
-- behind deactivation. security definer + fixed search_path unchanged.
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

-- Refresh PostgREST so the redefined function + new column are live.
notify pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 13. SEED — treatment-plan template categories + diagnosis templates │
-- │ (embedded copy of seed-treatment-templates.sql; idempotent)         │
-- └────────────────────────────────────────────────────────────────────┘
-- ═══════════════════════════════════════════════════════════════
-- SEED: treatment-plan template categories + diagnosis templates
-- GENERATED by scripts/gen_treatment_templates_seed.py — DO NOT EDIT
-- BY HAND. Re-run the generator to regenerate.
--
-- Idempotent: categories insert only when a same-named category is
-- absent; every template uses a stable template_id with
-- `on conflict (template_id) do nothing`, so running this multiple
-- times never creates duplicates. Templates link to their category
-- by name (treatment_templates.category = template_categories.name),
-- which is how the template picker in the app resolves them.
-- ═══════════════════════════════════════════════════════════════

-- ── Categories (idempotent by name) ──────────────────────────
insert into template_categories (category_id, name, description, status, sort_order, created_by_name)
select 'TPC-SEED-SPINE', 'قوالب التشخيص للعمود الفقري', 'فئة تشخيصية للعلاج الطبيعي', 'active', 10, 'بذرة النظام'
where not exists (
  select 1 from template_categories where lower(trim(name)) = lower(trim('قوالب التشخيص للعمود الفقري'))
);
insert into template_categories (category_id, name, description, status, sort_order, created_by_name)
select 'TPC-SEED-SHOULDER', 'قوالب تشخيص الكتف', 'فئة تشخيصية للعلاج الطبيعي', 'active', 20, 'بذرة النظام'
where not exists (
  select 1 from template_categories where lower(trim(name)) = lower(trim('قوالب تشخيص الكتف'))
);

-- ── Spine templates (35) ──────────────────────────────────────
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-01', 'Lumber spondylosis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Lumber spondylosis', 'العمود الفقري',
   '["قصير المدى — تقليل الألم القطني بمقدار 50٪ خلال أسبوعين", "قصير المدى — تحسين المدى الحركي القطني", "قصير المدى — تفعيل عضلات الجذع العميقة", "طويل المدى — استعادة الوظائف اليومية دون ألم", "طويل المدى — تعزيز قدرة التحمل العضلي القطني", "طويل المدى — برنامج منزلي وقائي مستدام"]'::jsonb, '[{"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "إطالة العضلة الكمثرية والألوية", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "إطالة ثابتة لتخفيف التيبّس.", "notes": ""}]'::jsonb, '[{"name": "العلاج اليدوي"}, {"name": "تحريك المفاصل الوجيهية (Grade I–II)"}, {"name": "العلاج الحراري"}, {"name": "الموجات فوق الصوتية"}, {"name": "TENS"}, {"name": "تمارين التثبيت القطني"}]'::jsonb,
   'تمارين التثبيت القطني يوميًا، تجنّب الجلوس المطوّل، تطبيق الحرارة 15 دقيقة عند التيبّس.', 'الملخص السريري: تغيّرات تنكسية بالفقرات القطنية والأقراص والمفاصل الوجيهية مع تيبّس صباحي.

الأعراض الشائعة: ألم أسفل الظهر ميكانيكي يزداد بالوقوف الطويل، تيبّس صباحي، تحسّن بالحركة الخفيفة.

نتائج الفحص: محدودية المدى القطني، ألم عند الجسّ فوق المفاصل الوجيهية، اختبار الإطالة سلبي غالبًا.

ملاحظات سريرية: التركيز على تصحيح وضعية الجلوس وميكانيكا الرفع.', 'الاحتياطات: تجنّب الانثناء المتكرر تحت حمل، تدرّج في شدة التمارين.

موانع الاستعمال: عدم إجراء تحريك عالي السرعة عند وجود هشاشة عظام شديدة أو عجز عصبي متقدّم.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-02', 'Cervical spondylosis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Cervical spondylosis', 'العمود الفقري',
   '["قصير المدى — تخفيف الألم الرقبي", "قصير المدى — تحسين المدى الحركي العنقي", "قصير المدى — تفعيل الثنيات العنقية العميقة", "طويل المدى — منع تكرار النوبات", "طويل المدى — تحسين الوضعية الرأسية الأمامية", "طويل المدى — تعزيز قوة عضلات الرقبة والكتف"]'::jsonb, '[{"name": "انثناء الرقبة العميق (Chin tuck)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "تفعيل الثنيات العنقية العميقة.", "notes": ""}, {"name": "تراجع لوح الكتف (Scapular retraction)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة العضلة شبه المنحرفة العلوية", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران الرقبة النشط ضمن المدى المتاح", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "10 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}]'::jsonb, '[{"name": "العلاج اليدوي العنقي"}, {"name": "السحب العنقي اللطيف"}, {"name": "العلاج الحراري"}, {"name": "الموجات فوق الصوتية"}, {"name": "TENS"}, {"name": "تمارين الثنيات العميقة"}]'::jsonb,
   'تمارين chin tuck كل ساعتين أثناء العمل المكتبي، ضبط ارتفاع الشاشة.', 'الملخص السريري: تنكّس بالفقرات العنقية مع تضيّق محتمل بالثقوب البينية وتيبّس رقبي.

الأعراض الشائعة: ألم رقبي، صداع خلفي، تيبّس، أحيانًا تنميل بالطرف العلوي.

نتائج الفحص: محدودية دوران وانثناء الرقبة، ألم بالجسّ حول الفقرات العنقية، اختبار سبيرلينج قد يكون إيجابيًا.

ملاحظات سريرية: فحص الأعراض العصبية بانتظام واستبعاد الاعتلال النخاعي.', 'الاحتياطات: تجنّب البسط العنقي المفرط ووضعيات الرأس الأمامية المطوّلة.

موانع الاستعمال: عدم السحب أو التحريك العنيف عند عدم ثبات فقري أو أعراض نخاعية.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-03', 'Disc bulge — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Disc bulge', 'العمود الفقري',
   '["قصير المدى — تقليل الألم المركزي", "قصير المدى — تحسين تحمّل الجلوس", "قصير المدى — تفعيل الجذع العميق", "طويل المدى — استعادة الانثناء دون ألم", "طويل المدى — منع التطوّر لانزلاق أكبر", "طويل المدى — برنامج تثبيت مستدام"]'::jsonb, '[{"name": "بسط قطني بالانبطاح (Prone extension)", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "حركة McKenzie لتمركز الأعراض.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين الطائر–الكلب (Bird-Dog)", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت الجذع مع مدّ الذراع المقابلة والساق.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "انزلاق عصبي لطيف للطرف السفلي", "sets": "2", "reps": "8", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "منهج McKenzie (تفضيل البسط)"}, {"name": "العلاج اليدوي"}, {"name": "الجرّ القطني اللطيف"}, {"name": "الموجات فوق الصوتية"}, {"name": "TENS"}, {"name": "تمارين التثبيت"}]'::jsonb,
   'تكرار البسط القطني كل 3–4 ساعات، تجنّب الجلوس المطوّل والانثناء المحمّل.', 'الملخص السريري: انتفاخ متماثل للقرص دون تمزّق الحلقة الليفية، غالبًا بلا ضغط جذري واضح.

الأعراض الشائعة: ألم أسفل الظهر يزداد بالجلوس والانثناء، قد يمتد للأرداف.

نتائج الفحص: ألم عند الانثناء الأمامي، تفضيل البسط، اختبار SLR سلبي أو حدّي.

ملاحظات سريرية: راقب علامة التمركز (centralization) كمؤشّر تحسّن.', 'الاحتياطات: تجنّب الانثناء المتكرر والرفع من وضع الانحناء.

موانع الاستعمال: إيقاف أي حركة تُسبّب ترحيل الألم للطرف (peripheralization).', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 45,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-04', 'Disc protrusion — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Disc protrusion', 'العمود الفقري',
   '["قصير المدى — تمركز الأعراض نحو الظهر", "قصير المدى — تقليل حدّة الإشعاع", "قصير المدى — تفعيل التثبيت العميق", "طويل المدى — حلّ الضغط الجذري وظيفيًا", "طويل المدى — استعادة النشاط الكامل", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "بسط قطني متدرّج (Prone press-up)", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "إمالة الحوض مع تنشيط عرضي البطن", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "منهج McKenzie"}, {"name": "الجرّ القطني"}, {"name": "العلاج اليدوي"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "الانزلاق العصبي"}]'::jsonb,
   'تمارين البسط المتكرّرة، تجنّب الانحناء الأمامي المحمّل، مشي منتظم قصير.', 'الملخص السريري: بروز القرص مع بقاء الحلقة الليفية سليمة جزئيًا وضغط موضعي محتمل.

الأعراض الشائعة: ألم قطني مع إشعاع للطرف السفلي، يزداد بالسعال والجلوس.

نتائج الفحص: SLR إيجابي عند 40–60°، تفضيل البسط، عجز حسّي محتمل خفيف.

ملاحظات سريرية: متابعة الأعراض العصبية؛ إحالة عاجلة عند علامات إنذارية.', 'الاحتياطات: توقّف عند زيادة الأعراض بالطرف، تجنّب الجلوس الطويل.

موانع الاستعمال: عدم إجراء انثناء قطني قسري؛ استبعاد متلازمة ذيل الفرس.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-05', 'Disc prolapse — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Disc prolapse', 'العمود الفقري',
   '["قصير المدى — تخفيف الألم الجذري الحادّ", "قصير المدى — حماية العصب المضغوط", "قصير المدى — الحفاظ على القوة الوظيفية", "طويل المدى — استعادة القوة والإحساس", "طويل المدى — العودة التدريجية للنشاط", "طويل المدى — الوقاية طويلة المدى"]'::jsonb, '[{"name": "بسط قطني لطيف مدعوم", "sets": "3", "reps": "8", "duration": "", "hold_time": "3 ث", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تفعيل عرضي البطن بالاستلقاء", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}]'::jsonb, '[{"name": "الجرّ القطني"}, {"name": "منهج McKenzie الحذر"}, {"name": "TENS"}, {"name": "العلاج اليدوي اللطيف"}, {"name": "الموجات فوق الصوتية"}, {"name": "التثبيت العميق"}]'::jsonb,
   'راحة نسبية مع حركة لطيفة متكرّرة، تجنّب الرفع والانحناء، وضعيات مريحة للنوم.', 'الملخص السريري: انفتاق القرص عبر الحلقة الليفية مع ضغط جذري أوضح.

الأعراض الشائعة: ألم مُشِعّ حادّ بالطرف، تنميل، ضعف محتمل، تفاقم بالجلوس والسعال.

نتائج الفحص: SLR إيجابي مبكّر، عجز حسّي/حركي جذري محتمل، انعكاسات قد تتغيّر.

ملاحظات سريرية: نهج تحفّظي متدرّج؛ تنسيق مع الطبيب عند عجز تقدّمي.', 'الاحتياطات: مراقبة الضعف الحركي والوظيفة الحوضية.

موانع الاستعمال: إحالة فورية عند سلس/احتباس بولي أو تخدّر سرجي (ذيل الفرس).', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 3, 70,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-06', 'Sciatica — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Sciatica', 'العمود الفقري',
   '["قصير المدى — تخفيف الألم على مسار العصب", "قصير المدى — تحسين انزلاق العصب", "قصير المدى — تقليل شدّ الكمثرية", "طويل المدى — حلّ الأعراض الجذرية", "طويل المدى — استعادة تحمّل الجلوس والمشي", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "إطالة الكمثرية بالاستلقاء", "sets": "3", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "بسط قطني بالانبطاح", "sets": "2", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "تحريك العصب (Neural mobilization)"}, {"name": "منهج McKenzie"}, {"name": "العلاج اليدوي"}, {"name": "TENS"}, {"name": "العلاج الحراري"}, {"name": "إطالة الكمثرية"}]'::jsonb,
   'انزلاقات عصبية لطيفة يوميًا، إطالة الكمثرية، تجنّب الجلوس المطوّل.', 'الملخص السريري: ألم مُشِعّ على مسار العصب الوركي نتيجة تهيّج/ضغط جذري.

الأعراض الشائعة: ألم حارق يمتد من الأرداف للساق، تنميل، يزداد بالجلوس.

نتائج الفحص: SLR إيجابي، ألم على مسار العصب، قد يوجد عجز حسّي جذري.

ملاحظات سريرية: التمييز بين المنشأ الجذري والكمثري يوجّه العلاج.', 'الاحتياطات: تجنّب الإطالة العدوانية التي تُثير الألم المُشِعّ.

موانع الاستعمال: عدم الاستمرار عند عجز حركي تقدّمي؛ استبعاد ذيل الفرس.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-07', 'Numbness — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Numbness', 'العمود الفقري',
   '["قصير المدى — تحسين التوصيل العصبي الوظيفي", "قصير المدى — تقليل الضغط الجذري", "قصير المدى — تحسين الوضعية", "طويل المدى — استعادة الإحساس الطبيعي", "طويل المدى — منع العجز المزمن", "طويل المدى — برنامج عصبي منزلي"]'::jsonb, '[{"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "انزلاق العصب المتوسّط للطرف العلوي", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "عند تنميل الطرف العلوي.", "notes": ""}, {"name": "تمارين استقبال الحسّ (Proprioception)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}]'::jsonb, '[{"name": "تحريك العصب"}, {"name": "العلاج اليدوي"}, {"name": "الجرّ اللطيف"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "تمارين الوضعية"}]'::jsonb,
   'تمارين انزلاق عصبي لطيفة منتظمة، تجنّب الوضعيات الضاغطة على العصب.', 'الملخص السريري: تنميل بالطرف نتيجة تهيّج عصبي جذري أو محيطي مصاحب لمشكلة العمود الفقري.

الأعراض الشائعة: خدر ووخز بتوزيع جلدي، قد يصاحبه ألم خفيف.

نتائج الفحص: تغيّر حسّي بالفحص، اختبارات التوتر العصبي قد تكون إيجابية.

ملاحظات سريرية: تحديد مستوى الجذر يساعد في توجيه التحريك العصبي.', 'الاحتياطات: التمارين ضمن مدى غير مؤلم لتجنّب زيادة التهيّج.

موانع الاستعمال: تقييم عاجل عند تنميل تقدّمي أو ضعف حركي مصاحب.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 2, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-08', 'Femoralgia — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Femoralgia', 'العمود الفقري',
   '["قصير المدى — تخفيف الألم الفخذي الأمامي", "قصير المدى — تحسين انزلاق العصب الفخذي", "قصير المدى — الحفاظ على قوة الرباعية", "طويل المدى — حلّ الأعراض الجذرية الأمامية", "طويل المدى — استعادة قوة مدّ الركبة", "طويل المدى — العودة للنشاط"]'::jsonb, '[{"name": "انزلاق العصب الفخذي (Femoral nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "مدّ الركبة بالجلوس (Quad set / knee extension)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة عضلة الحرقفية القطنية", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "تحريك العصب الفخذي"}, {"name": "العلاج اليدوي القطني"}, {"name": "TENS"}, {"name": "العلاج الحراري"}, {"name": "الموجات فوق الصوتية"}, {"name": "تقوية الرباعية"}]'::jsonb,
   'انزلاق العصب الفخذي، تقوية الرباعية، تجنّب البسط القطني المفرط.', 'الملخص السريري: ألم على مسار العصب الفخذي (جذور L2–L4) بالوجه الأمامي للفخذ.

الأعراض الشائعة: ألم أمامي بالفخذ، ضعف محتمل بمدّ الركبة، خدر أمامي.

نتائج الفحص: اختبار التوتر الفخذي (Prone knee bend) إيجابي، ضعف رباعية محتمل.

ملاحظات سريرية: متابعة قوة الرباعية ومنعكس الرضفة.', 'الاحتياطات: تجنّب إطالة العصب العدوانية.

موانع الاستعمال: إيقاف عند تفاقم العجز الحركي بالرباعية.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-09', 'Spondylolythesis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Spondylolythesis', 'العمود الفقري',
   '["قصير المدى — تقليل الألم مع تجنّب البسط", "قصير المدى — تفعيل التثبيت العميق", "قصير المدى — تحسين تحمّل الوقوف", "طويل المدى — استقرار القطاع القطني وظيفيًا", "طويل المدى — منع تقدّم الانزلاق", "طويل المدى — برنامج تثبيت مستدام"]'::jsonb, '[{"name": "إمالة الحوض الخلفية مع تثبيت", "sets": "3", "reps": "12", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين البطن الجزئي المتحكّم (Curl-up)", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الطائر–الكلب (Bird-Dog)", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت الجذع مع مدّ الذراع المقابلة والساق.", "notes": ""}]'::jsonb, '[{"name": "تمارين التثبيت القطني (توجّه انثنائي)"}, {"name": "العلاج اليدوي اللطيف"}, {"name": "TENS"}, {"name": "العلاج الحراري"}, {"name": "تدريب التحكّم الحركي"}, {"name": "شدّ عضلي بطني"}]'::jsonb,
   'تمارين تثبيت بتوجّه انثنائي، تجنّب البسط القطني والقفز.', 'الملخص السريري: انزلاق فقرة أمامية على أخرى مع عدم ثبات محتمل بالقطاع القطني.

الأعراض الشائعة: ألم قطني يزداد بالبسط والوقوف، تحسّن بالانثناء والراحة.

نتائج الفحص: زيادة قعس محتملة، ألم بالبسط، اختبار عدم ثبات إيجابي أحيانًا.

ملاحظات سريرية: مراقبة العلامات العصبية؛ التوجّه الانثنائي هو حجر الأساس.', 'الاحتياطات: تجنّب البسط القطني المفرط والأنشطة عالية الصدمة.

موانع الاستعمال: عدم إجراء تحريك بسطي عالي السرعة؛ حذر مع الانزلاق الدرجة العالية.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-10', 'Retrolythesis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Retrolythesis', 'العمود الفقري',
   '["قصير المدى — تقليل الألم القطاعي", "قصير المدى — تحسين التحكّم الحركي", "قصير المدى — تفعيل الجذع العميق", "طويل المدى — استقرار وظيفي للقطاع", "طويل المدى — استعادة النشاط", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين الطائر–الكلب (Bird-Dog)", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت الجذع مع مدّ الذراع المقابلة والساق.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "تمرين اللوح الأمامي المعدّل (Modified plank)", "sets": "3", "reps": "", "duration": "20 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين التثبيت"}, {"name": "العلاج اليدوي اللطيف"}, {"name": "TENS"}, {"name": "العلاج الحراري"}, {"name": "تدريب التحكّم الحركي"}, {"name": "الموجات فوق الصوتية"}]'::jsonb,
   'تمارين تثبيت يومية، ضبط الوضعية، تجنّب الحركات القطنية المفاجئة.', 'الملخص السريري: انزلاق فقري خلفي مع تغيّر ميكانيكا القطاع وضغط محتمل بالثقوب.

الأعراض الشائعة: ألم قطني ميكانيكي، تيبّس، قد يصاحبه إشعاع خفيف.

نتائج الفحص: ألم بالجسّ القطاعي، محدودية حركة، اختبارات ثبات متغيّرة.

ملاحظات سريرية: التركيز على التحكّم الحركي أكثر من زيادة المدى.', 'الاحتياطات: تدرّج في الحمل وتجنّب الحركات المتطرّفة.

موانع الاستعمال: تجنّب التحريك العنيف عند عدم الثبات.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-11', 'Broadbase — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Broadbase', 'العمود الفقري',
   '["قصير المدى — تمركز الأعراض", "قصير المدى — تحسين تحمّل الجلوس", "قصير المدى — تفعيل التثبيت", "طويل المدى — استعادة الوظيفة", "طويل المدى — منع التطوّر", "طويل المدى — برنامج منزلي مستدام"]'::jsonb, '[{"name": "بسط قطني بالانبطاح", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}]'::jsonb, '[{"name": "منهج McKenzie"}, {"name": "العلاج اليدوي"}, {"name": "الجرّ اللطيف"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "التثبيت القطني"}]'::jsonb,
   'تمارين بسط متكرّرة، تجنّب الانثناء المحمّل، مشي منتظم.', 'الملخص السريري: انتفاق قرصي عريض القاعدة يمسّ عدة مناطق دون بؤرة ضغط واحدة.

الأعراض الشائعة: ألم قطني منتشر، تيبّس، إشعاع متغيّر خفيف.

نتائج الفحص: ألم بالانثناء، تفضيل البسط غالبًا، SLR حدّي.

ملاحظات سريرية: نهج مبنيّ على الاتجاه (directional preference).', 'الاحتياطات: مراقبة ترحيل الأعراض للطرف.

موانع الاستعمال: إيقاف الحركات التي تُثير الإشعاع المحيطي.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 45,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-12', 'Postrolat — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Postrolat', 'العمود الفقري',
   '["قصير المدى — تمركز الأعراض نحو الظهر", "قصير المدى — تخفيف الضغط الجذري", "قصير المدى — التثبيت العميق", "طويل المدى — حلّ الإشعاع الجذري", "طويل المدى — استعادة النشاط", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "تصحيح الانزلاق الجانبي (Side glide)", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "تصحيح انحراف الجذع قبل البسط.", "notes": ""}, {"name": "بسط قطني بالانبطاح", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}]'::jsonb, '[{"name": "منهج McKenzie مع انزلاق جانبي"}, {"name": "الجرّ القطني"}, {"name": "العلاج اليدوي"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "الانزلاق العصبي"}]'::jsonb,
   'تصحيح الانزلاق الجانبي ثم البسط، تجنّب الانثناء والدوران المحمّل.', 'الملخص السريري: انفتاق خلفي جانبي للقرص يميل لضغط الجذر العصبي في الزاوية.

الأعراض الشائعة: ألم قطني مع إشعاع جذري أحادي الجانب، تفاقم بالانثناء.

نتائج الفحص: SLR إيجابي، تفضيل البسط، توزيع جلدي للأعراض.

ملاحظات سريرية: تصحيح الانحراف الجانبي أولًا يحسّن الاستجابة للبسط.', 'الاحتياطات: مراقبة اتجاه تمركز الأعراض.

موانع الاستعمال: عدم الاستمرار عند ترحيل محيطي للأعراض.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-13', 'Paracentral — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Paracentral', 'العمود الفقري',
   '["قصير المدى — تخفيف الضغط الجذري", "قصير المدى — تمركز الأعراض", "قصير المدى — حماية العصب", "طويل المدى — استعادة الوظيفة الكاملة", "طويل المدى — منع التكرار", "طويل المدى — برنامج تثبيت"]'::jsonb, '[{"name": "بسط قطني متدرّج", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}]'::jsonb, '[{"name": "منهج McKenzie"}, {"name": "الجرّ القطني"}, {"name": "العلاج اليدوي"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "التثبيت العميق"}]'::jsonb,
   'تمارين البسط المتكرّرة، تجنّب الجلوس المطوّل والانثناء.', 'الملخص السريري: انفتاق مجاور للمركز يضغط الجذر النازل داخل القناة.

الأعراض الشائعة: ألم قطني وإشعاع للطرف، تفاقم بالجلوس والانثناء.

نتائج الفحص: SLR إيجابي، عجز حسّي جذري محتمل، تفضيل البسط.

ملاحظات سريرية: متابعة توزيع الأعراض الجذري.', 'الاحتياطات: مراقبة العلامات العصبية والوظيفة الحوضية.

موانع الاستعمال: استبعاد ذيل الفرس؛ إيقاف عند عجز تقدّمي.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-14', 'Central — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Central', 'العمود الفقري',
   '["قصير المدى — تخفيف الألم المركزي", "قصير المدى — تحسين تحمّل الوقوف/المشي", "قصير المدى — التثبيت العميق", "طويل المدى — استعادة النشاط", "طويل المدى — إدارة أعراض التضيّق", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "إمالة الحوض الخلفية", "sets": "3", "reps": "12", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمدّد الانثناء بالركبتين للصدر", "sets": "2", "reps": "", "duration": "", "hold_time": "20 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الطائر–الكلب (Bird-Dog)", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت الجذع مع مدّ الذراع المقابلة والساق.", "notes": ""}]'::jsonb, '[{"name": "تمارين التثبيت (توجّه انثنائي عند التضيّق)"}, {"name": "الجرّ اللطيف"}, {"name": "العلاج اليدوي"}, {"name": "TENS"}, {"name": "المشي المتدرّج"}, {"name": "الموجات فوق الصوتية"}]'::jsonb,
   'تمارين انثنائية عند وجود تضيّق، مشي متقطّع بحسب التحمّل.', 'الملخص السريري: انفتاق مركزي قد يضيّق القناة الشوكية ويسبّب أعراضًا ثنائية.

الأعراض الشائعة: ألم قطني، قد يصاحبه أعراض ثنائية، تفاقم بالبسط أحيانًا (تضيّق).

نتائج الفحص: محدودية الحركة، تقييم عصبي دقيق، اختبارات تضيّق محتملة.

ملاحظات سريرية: مطابقة اتجاه التمرين لآلية الأعراض (انفتاق مقابل تضيّق).', 'الاحتياطات: حذر مع البسط عند وجود تضيّق قناة.

موانع الاستعمال: تقييم عاجل عند أعراض ثنائية تقدّمية أو خلل حوضي.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 60,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-15', 'LBP — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'LBP', 'العمود الفقري',
   '["قصير المدى — تقليل الألم بمقدار 50٪", "قصير المدى — طمأنة وتثقيف المريض", "قصير المدى — تفعيل الجذع", "طويل المدى — استعادة النشاط الكامل", "طويل المدى — منع الإزمان", "طويل المدى — لياقة عامة"]'::jsonb, '[{"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الطائر–الكلب (Bird-Dog)", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت الجذع مع مدّ الذراع المقابلة والساق.", "notes": ""}, {"name": "مشي هوائي منتظم", "sets": "1", "reps": "", "duration": "20 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "نشاط هوائي معتدل يوميًا.", "notes": ""}]'::jsonb, '[{"name": "التمرين العلاجي المتدرّج"}, {"name": "العلاج اليدوي"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "التثقيف والطمأنة"}, {"name": "تمارين التثبيت"}]'::jsonb,
   'نشاط بدني منتظم، تجنّب الراحة التامة، تمارين تثبيت يومية.', 'الملخص السريري: ألم أسفل الظهر غير النوعي دون علامات جذرية أو إنذارية.

الأعراض الشائعة: ألم قطني ميكانيكي متغيّر، تيبّس، تحسّن بالحركة المعتدلة.

نتائج الفحص: فحص عصبي طبيعي، ألم عضلي/قطاعي، مدى حركي متغيّر.

ملاحظات سريرية: التثقيف والنشاط الفعّال أساس الإدارة.', 'الاحتياطات: تجنّب الخوف من الحركة (kinesiophobia).

موانع الاستعمال: إعادة تقييم عند ظهور علامات إنذارية.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   8, 2, 28,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-16', 'Muscle spasm — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Muscle spasm', 'العمود الفقري',
   '["قصير المدى — ارتخاء التشنّج العضلي", "قصير المدى — تخفيف الألم الحادّ", "قصير المدى — استعادة الحركة اللطيفة", "طويل المدى — منع تكرار التشنّج", "طويل المدى — استعادة المرونة والقوة", "طويل المدى — برنامج منزلي"]'::jsonb, '[{"name": "تمارين تنفّس واسترخاء", "sets": "2", "reps": "", "duration": "5 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "تهدئة الجهاز العصبي والعضلات.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "إطالة قطنية لطيفة (ركبة للصدر)", "sets": "2", "reps": "", "duration": "", "hold_time": "20 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "العلاج الحراري"}, {"name": "التدليك العلاجي"}, {"name": "الاسترخاء العضلي (Hold-relax)"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "إطالة لطيفة"}]'::jsonb,
   'حرارة موضعية 15 دقيقة، حركات لطيفة متكرّرة، تجنّب الأوضاع الثابتة الطويلة.', 'الملخص السريري: تشنّج عضلي واقٍ حادّ بالعضلات المجاورة للعمود القطني.

الأعراض الشائعة: ألم حادّ موضعي، تيبّس شديد، محدودية حركة مؤلمة.

نتائج الفحص: فرط توتّر عضلي محسوس بالجسّ، تقييد حركي دفاعي.

ملاحظات سريرية: استبعاد سبب كامن (قرص/جذر) عند الاستمرار.', 'الاحتياطات: تجنّب الإطالة القوية أثناء الطور الحادّ.

موانع الاستعمال: عدم استخدام الحرارة على التهاب حادّ أو جلد متضرّر.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   8, 3, 21,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-17', 'Mechanical pain — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Mechanical pain', 'العمود الفقري',
   '["قصير المدى — تحديد وتصحيح الوضعيات المُثيرة", "قصير المدى — تقليل الألم", "قصير المدى — تفعيل الجذع", "طويل المدى — استعادة الحركة دون ألم", "طويل المدى — تصحيح الأنماط الحركية", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تدريب ميكانيكا الرفع الصحيحة", "sets": "2", "reps": "8", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "محاكاة رفع بوضعية آمنة.", "notes": ""}]'::jsonb, '[{"name": "تصحيح الوضعية"}, {"name": "العلاج اليدوي"}, {"name": "التمرين الموجّه بالاتجاه"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "التثبيت"}]'::jsonb,
   'ضبط بيئة العمل، فترات حركة منتظمة، تمارين وضعية.', 'الملخص السريري: ألم ظهري ميكانيكي مرتبط بالوضعية والحركة دون مرض بنيوي واضح.

الأعراض الشائعة: ألم يتغيّر مع الوضعية والنشاط، يتحسّن بالراحة النسبية.

نتائج الفحص: ألم عند حركات محدّدة، فحص عصبي طبيعي.

ملاحظات سريرية: التثقيف حول الأنماط الحركية محوري.', 'الاحتياطات: تجنّب الأوضاع الثابتة المطوّلة.

موانع الاستعمال: إعادة تقييم عند ظهور أعراض جذرية.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   8, 2, 28,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-18', 'Sacroiliatis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Sacroiliatis', 'العمود الفقري',
   '["قصير المدى — تخفيف ألم المفصل العجزي", "قصير المدى — تحسين ثبات الحوض", "قصير المدى — توازن قوى العضلات المحيطة", "طويل المدى — استعادة وظيفة المفصل", "طويل المدى — منع التكرار", "طويل المدى — برنامج ثبات حوضي"]'::jsonb, '[{"name": "تنشيط الألوية (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تقنية الطاقة العضلية للمقرّبات/المبعّدات", "sets": "2", "reps": "5", "duration": "", "hold_time": "6 ث", "rest_time": "10 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إطالة الكمثرية", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تصحيح/تحريك المفصل العجزي الحرقفي"}, {"name": "تقنيات الطاقة العضلية (MET)"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "حزام العجز الحرقفي"}, {"name": "تمارين ثبات الحوض"}]'::jsonb,
   'تمارين تنشيط الألوية وثبات الحوض، استخدام حزام عند الحاجة، تجنّب الحمل الأحادي المفاجئ.', 'الملخص السريري: التهاب/خلل وظيفي بالمفصل العجزي الحرقفي مع ألم موضعي.

الأعراض الشائعة: ألم أسفل الظهر جانبي فوق المفصل، يزداد بالوقوف على رجل واحدة والانتقال.

نتائج الفحص: اختبارات الإثارة (FABER، الضغط، الفصل) إيجابية، ألم فوق SIJ.

ملاحظات سريرية: توازن قوى الحوض مفتاح النجاح.', 'الاحتياطات: تجنّب الوضعيات غير المتماثلة المطوّلة.

موانع الاستعمال: استبعاد الاعتلال الالتهابي (مثل التهاب الفقار) عند الاشتباه.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 35,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-19', 'Hip impingement — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Hip impingement', 'العمود الفقري',
   '["قصير المدى — تقليل الألم الأربي", "قصير المدى — تحسين مدى الورك ضمن حدود آمنة", "قصير المدى — تقوية مثبتات الورك", "طويل المدى — استعادة وظيفة الورك", "طويل المدى — تحسين الأنماط الحركية", "طويل المدى — منع تفاقم التصادم"]'::jsonb, '[{"name": "تنشيط الألوية (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "إطالة المثنية للورك (Hip flexor stretch)", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "سكوات ضمن مدى غير مؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "العلاج اليدوي للورك"}, {"name": "تحريك الأنسجة الرخوة"}, {"name": "تمارين التحكّم الحركي"}, {"name": "العلاج الحراري"}, {"name": "تقوية الألوية"}, {"name": "تدريب الوظيفة"}]'::jsonb,
   'تقوية الألوية، تجنّب الانثناء العميق والدوران الداخلي القسري.', 'الملخص السريري: اصطدام فخذي حُقّي (FAI) يقيّد حركة الورك ويسبّب ألمًا أربيًا.

الأعراض الشائعة: ألم أربي مع الانثناء والدوران الداخلي، تيبّس، طقطقة أحيانًا.

نتائج الفحص: اختبار FADIR إيجابي، محدودية الدوران الداخلي، ألم أربي.

ملاحظات سريرية: تعديل النشاط ضمن مدى غير مؤلم أساسي.', 'الاحتياطات: تجنّب حركات التصادم المؤلمة (انثناء+دوران داخلي عميق).

موانع الاستعمال: إحالة جراحية عند فشل التحفّظي أو تلف غضروفي كبير.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 2, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-20', 'Post cervical fixation — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Post cervical fixation', 'العمود الفقري',
   '["قصير المدى — حماية موقع الدمج", "قصير المدى — استعادة حركة لطيفة مسموحة", "قصير المدى — تنشيط عضلات الرقبة العميقة", "طويل المدى — استعادة الوظيفة العنقية الآمنة", "طويل المدى — تحسين القوة والوضعية", "طويل المدى — العودة للأنشطة"]'::jsonb, '[{"name": "انثناء الرقبة العميق اللطيف (Chin tuck)", "sets": "3", "reps": "8", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "مدى عنقي نشط ضمن الحدود المسموحة", "sets": "2", "reps": "8", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين توكيدية للكتف", "sets": "2", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين وضعية للجذع العلوي", "sets": "2", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين لطيفة محمية"}, {"name": "تفعيل الثنيات العميقة"}, {"name": "العلاج الحراري السطحي"}, {"name": "تدريب الوضعية"}, {"name": "تمارين الكتف والحزام"}, {"name": "تثقيف ما بعد الجراحة"}]'::jsonb,
   'تمارين محمية وفق بروتوكول الجرّاح، تجنّب الحركات المتطرّفة والحمل.', 'الملخص السريري: تأهيل بعد تثبيت جراحي للفقرات العنقية مع حماية القطاع المدمج.

الأعراض الشائعة: تيبّس رقبي بعد الجراحة، ضعف عضلي، محدودية حركة محمية.

نتائج الفحص: مدى محدود محميّ، ضعف الثنيات العميقة، حالة الجرح.

ملاحظات سريرية: التقدّم مرحليّ ومنسّق مع الفريق الجراحي.', 'الاحتياطات: الالتزام بقيود المدى والحمل بحسب مرحلة الالتئام.

موانع الاستعمال: عدم إجراء أي تحريك عنقي قسري أو سحب قبل إذن الجرّاح.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 2, 84,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-21', 'Post lumber fixation — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Post lumber fixation', 'العمود الفقري',
   '["قصير المدى — حماية موقع الدمج", "قصير المدى — تنشيط الجذع العميق بأمان", "قصير المدى — المشي المتدرّج", "طويل المدى — استعادة الوظيفة القطنية الآمنة", "طويل المدى — تقوية الجذع والأطراف", "طويل المدى — العودة للأنشطة اليومية"]'::jsonb, '[{"name": "تفعيل عرضي البطن بالاستلقاء", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إمالة الحوض اللطيفة", "sets": "2", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "مشي متدرّج بحسب التحمّل", "sets": "1", "reps": "", "duration": "10 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين الكاحل والدورة الدموية", "sets": "2", "reps": "15", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين تثبيت محمية"}, {"name": "تفعيل عرضي البطن"}, {"name": "المشي المتدرّج"}, {"name": "العلاج الحراري السطحي"}, {"name": "تدريب ميكانيكا الجسم"}, {"name": "تثقيف ما بعد الجراحة"}]'::jsonb,
   'المشي المنتظم المتدرّج، تمارين تثبيت محمية، تجنّب الانثناء/اللَّي/الرفع.', 'الملخص السريري: تأهيل بعد تثبيت جراحي قطني مع حماية الدمج وتدرّج الحمل.

الأعراض الشائعة: تيبّس قطني، ضعف الجذع، محدودية حركة محمية بعد الجراحة.

نتائج الفحص: ضعف عضلات الجذع، مدى محميّ، حالة الجرح والوضعية.

ملاحظات سريرية: التقدّم مرحليّ منسّق مع الجرّاح.', 'الاحتياطات: لا انثناء أو لَيّ أو رفع (BLT) خلال المرحلة المبكّرة.

موانع الاستعمال: عدم إجراء تحريك قطني قسري قبل إذن الجرّاح.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 2, 90,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-22', 'C-scoliosis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'C-scoliosis', 'العمود الفقري',
   '["قصير المدى — تحسين التناظر الوضعي", "قصير المدى — تقوية الجانب المحدّب", "قصير المدى — تحسين الوعي الوضعي", "طويل المدى — إبطاء/إدارة تقدّم المنحنى", "طويل المدى — تحسين التوازن العضلي", "طويل المدى — برنامج تمارين مستدام"]'::jsonb, '[{"name": "تمارين شروث للاستطالة والتصحيح", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "تصحيح ثلاثي الأبعاد مع تنفّس موجّه.", "notes": ""}, {"name": "تقوية غير متماثلة للجانب المحدّب", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة الجانب المقعّر", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تدريب الوعي الوضعي أمام المرآة", "sets": "2", "reps": "", "duration": "5 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين شروث (Schroth) الموجّهة"}, {"name": "تصحيح الوضعية ثلاثي الأبعاد"}, {"name": "التنفّس التصحيحي"}, {"name": "إطالة الجانب المقعّر"}, {"name": "تقوية الجانب المحدّب"}, {"name": "التثبيت المركزي"}]'::jsonb,
   'تمارين شروث اليومية، وعي وضعي مستمر، تنفّس تصحيحي.', 'الملخص السريري: انحناء جانبي بشكل حرف C بمنحنى أساسي واحد بالعمود الفقري.

الأعراض الشائعة: عدم تناظر بالكتفين/الخصر، تعب عضلي، ألم خفيف محتمل.

نتائج الفحص: منحنى C بالفحص، عدم تناظر، اختبار الانحناء الأمامي إيجابي.

ملاحظات سريرية: التقييم الدوري لزاوية Cobb يوجّه الخطة.', 'الاحتياطات: تجنّب التمارين المتماثلة التي قد تعزّز المنحنى.

موانع الاستعمال: متابعة تصويرية عند منحنى تقدّمي؛ قد يلزم الدعامة/الجراحة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   20, 3, 120,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-23', 'S-scoliosis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'S-scoliosis', 'العمود الفقري',
   '["قصير المدى — تحسين توازن المنحنيين", "قصير المدى — تقوية انتقائية موجّهة", "قصير المدى — تحسين الوعي الوضعي", "طويل المدى — إدارة تقدّم المنحنيين", "طويل المدى — تحسين التناظر الوظيفي", "طويل المدى — برنامج مستدام"]'::jsonb, '[{"name": "تمارين شروث للمنحنى المزدوج", "sets": "3", "reps": "8", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية انتقائية للقطاعين", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة الجوانب المقعّرة", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تدريب التوازن الوضعي", "sets": "2", "reps": "", "duration": "5 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين شروث للمنحنى المزدوج"}, {"name": "التصحيح ثلاثي الأبعاد"}, {"name": "التنفّس التصحيحي"}, {"name": "إطالة انتقائية"}, {"name": "تقوية انتقائية"}, {"name": "التثبيت المركزي"}]'::jsonb,
   'تمارين شروث يومية موجّهة للمنحنيين، وعي وضعي مستمر.', 'الملخص السريري: انحناء جانبي بشكل حرف S بمنحنيين متعاكسين (أوّلي وتعويضي).

الأعراض الشائعة: عدم تناظر مزدوج، تعب عضلي، اختلال توازن الجذع.

نتائج الفحص: منحنيان بالفحص، عدم تناظر، اختبار الانحناء الأمامي إيجابي.

ملاحظات سريرية: خطة فردية بحسب نمط المنحنيين وزوايا Cobb.', 'الاحتياطات: التمارين يجب أن تكون خاصّة بنمط المنحنى.

موانع الاستعمال: متابعة تصويرية؛ تدخّل تقويمي/جراحي عند التقدّم.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   20, 3, 120,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-24', 'Kyphosis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Kyphosis', 'العمود الفقري',
   '["قصير المدى — تحسين الاستقامة الصدرية", "قصير المدى — تقوية الباسطات الصدرية", "قصير المدى — إطالة الصدريّتين", "طويل المدى — تصحيح الوضعية المستدام", "طويل المدى — تحسين التحمّل الوضعي", "طويل المدى — منع التفاقم"]'::jsonb, '[{"name": "بسط صدري فوق أسطوانة رغوية", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين W-Y-T للباسطات والمثبتات", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة الصدريّة (Doorway stretch)", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انثناء الرقبة العميق (Chin tuck)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}]'::jsonb, '[{"name": "تمارين البسط الصدري"}, {"name": "تحريك العمود الصدري"}, {"name": "إطالة الصدريّتين"}, {"name": "تقوية المثبتات الكتفية"}, {"name": "تدريب الوضعية"}, {"name": "العلاج اليدوي الصدري"}]'::jsonb,
   'تمارين البسط الصدري يوميًا، إطالة الصدر، ضبط الوضعية أثناء العمل.', 'الملخص السريري: زيادة التحدّب الصدري الأمامي الخلفي مع ضعف الباسطات.

الأعراض الشائعة: استدارة الظهر العلوي، تعب، ألم بين الكتفين، رأس أمامي.

نتائج الفحص: زيادة الحدبة الصدرية، ضعف الباسطات الصدرية، شدّ الصدريّتين.

ملاحظات سريرية: التمييز بين الكايفوزيس الوضعي والبنيوي (شويرمان).', 'الاحتياطات: حذر عند الاشتباه بكسور هشاشية (كايفوزيس حادّ لدى المسنّين).

موانع الاستعمال: تجنّب البسط القوي عند وجود كسور فقرية هشّة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 60,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-25', 'Sacral neutation — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Sacral neutation', 'العمود الفقري',
   '["قصير المدى — تصحيح وضعية العجز", "قصير المدى — تحسين توازن الحوض", "قصير المدى — تنشيط الألوية والجذع", "طويل المدى — استعادة ميكانيكا الحوض", "طويل المدى — منع التكرار", "طويل المدى — برنامج ثبات"]'::jsonb, '[{"name": "تقنية الطاقة العضلية لتصحيح العجز", "sets": "2", "reps": "5", "duration": "", "hold_time": "6 ث", "rest_time": "10 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تنشيط الألوية (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}]'::jsonb, '[{"name": "تصحيح المفصل العجزي الحرقفي"}, {"name": "تقنيات الطاقة العضلية"}, {"name": "تمارين ثبات الحوض"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "تدريب التحكّم الحركي"}]'::jsonb,
   'تمارين ثبات الحوض وتنشيط الألوية، تجنّب الأوضاع غير المتماثلة.', 'الملخص السريري: خلل وضعية العجز في اتجاه النوتيشن يؤثّر على ميكانيكا الحوض.

الأعراض الشائعة: ألم أسفل الظهر/العجز، شعور بعدم التوازن الحوضي.

نتائج الفحص: عدم تناظر معالم العجز، اختبارات حركة SIJ متغيّرة.

ملاحظات سريرية: التصحيح ثم التثبيت هو التسلسل المنطقي.', 'الاحتياطات: تجنّب الحمل الأحادي المفاجئ.

موانع الاستعمال: استبعاد أسباب التهابية عند الأعراض المستمرة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 35,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-26', 'Flat curve — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Flat curve', 'العمود الفقري',
   '["قصير المدى — استعادة القعس القطني الوظيفي", "قصير المدى — إطالة أوتار الركبة", "قصير المدى — تقوية الباسطات", "طويل المدى — تحسين المحاذاة القطنية", "طويل المدى — تحمّل وضعي أفضل", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "بسط قطني بالانبطاح (استعادة القعس)", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة أوتار الركبة", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "مدّ الورك بالانبطاح (Prone hip extension)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "تمارين استعادة القعس"}, {"name": "إطالة أوتار الركبة"}, {"name": "تقوية الباسطات القطنية"}, {"name": "العلاج اليدوي"}, {"name": "تدريب الوضعية"}, {"name": "التثبيت"}]'::jsonb,
   'تمارين استعادة القعس، إطالة أوتار الركبة، ضبط وضعية الجلوس.', 'الملخص السريري: فقدان القعس القطني الطبيعي (ظهر مسطّح) مع زيادة الحمل على الأقراص.

الأعراض الشائعة: تيبّس قطني، تعب بالوقوف، صعوبة الاستطالة القطنية.

نتائج الفحص: نقص القعس القطني، شدّ أوتار الركبة، ضعف الباسطات.

ملاحظات سريرية: موازنة استعادة القعس مع تحمّل المريض.', 'الاحتياطات: تجنّب الجلوس المنحني المطوّل.

موانع الاستعمال: حذر عند وجود تضيّق قناة (البسط قد يزيد الأعراض).', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 2, 35,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-27', 'Piriform''s syndrome — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Piriform''s syndrome', 'العمود الفقري',
   '["قصير المدى — ارتخاء الكمثرية", "قصير المدى — تخفيف تهيّج العصب", "قصير المدى — تحسين حركة الورك", "طويل المدى — حلّ الأعراض العصبية", "طويل المدى — توازن قوى مدوّرات الورك", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "إطالة الكمثرية (Figure-4)", "sets": "3", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تنشيط الألوية المتوسطة (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تحرير ذاتي بكرة الرغوة للألوية", "sets": "2", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تحرير الكمثرية بالضغط الإفرائي"}, {"name": "تحريك العصب الوركي"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "الإطالة الموجّهة"}, {"name": "تقوية مبعّدات الورك"}]'::jsonb,
   'إطالة الكمثرية، انزلاق عصبي، تجنّب الجلوس المطوّل على أسطح صلبة.', 'الملخص السريري: ضغط/تهيّج العصب الوركي من العضلة الكمثرية المتشنّجة.

الأعراض الشائعة: ألم عميق بالأرداف يمتد للفخذ، يزداد بالجلوس المطوّل والدوران.

نتائج الفحص: ألم عند جسّ الكمثرية، اختبار FAIR/Pace إيجابي، SLR قد يكون سلبيًا.

ملاحظات سريرية: التمييز عن الاعتلال الجذري القطني ضروري.', 'الاحتياطات: تجنّب الإطالة المؤلمة المُثيرة للإشعاع.

موانع الاستعمال: استبعاد المنشأ الجذري القطني قبل التركيز على الكمثرية.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 35,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-28', 'ITB syndrome — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'ITB syndrome', 'العمود الفقري',
   '["قصير المدى — تقليل الألم الجانبي", "قصير المدى — تحسين مرونة الشريط الحرقفي", "قصير المدى — تقوية مبعّدات الورك", "طويل المدى — العودة للجري دون ألم", "طويل المدى — تصحيح ميكانيكا الطرف السفلي", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "تحرير الشريط الحرقفي ببكرة الرغوة", "sets": "2", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية مبعّدات الورك (Side-lying abduction)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تنشيط الألوية (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة الشريط الحرقفي بالوقوف", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}]'::jsonb, '[{"name": "تحرير الأنسجة الرخوة/الشريط"}, {"name": "بكرة الرغوة"}, {"name": "تقوية الألوية المتوسطة"}, {"name": "العلاج الحراري/البارد"}, {"name": "إطالة موجّهة"}, {"name": "تدريب النمط الحركي"}]'::jsonb,
   'بكرة الرغوة، تقوية الألوية، تدرّج العودة للجري.', 'الملخص السريري: متلازمة الشريط الحرقفي الظنبوبي مع احتكاك عند الجانب الخارجي للركبة/الورك.

الأعراض الشائعة: ألم خارجي بالركبة/الفخذ يزداد بالجري والنزول على الدرج.

نتائج الفحص: ألم عند جسّ الشريط الخارجي، اختبار Ober إيجابي، ضعف مبعّدات الورك.

ملاحظات سريرية: ضعف مبعّدات الورك سبب شائع قابل للتصحيح.', 'الاحتياطات: تجنّب زيادة مسافة الجري المفاجئة.

موانع الاستعمال: تقييم الركبة إذا استمر الألم رغم التأهيل.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-29', 'Peronial pain & numbness — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Peronial pain & numbness', 'العمود الفقري',
   '["قصير المدى — تخفيف تهيّج العصب الشظوي", "قصير المدى — تحسين انزلاق العصب", "قصير المدى — الحفاظ على قوة رفع القدم", "طويل المدى — استعادة الإحساس والقوة", "طويل المدى — تصحيح العوامل الضاغطة", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "انزلاق العصب الشظوي", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية رفع القدم (Dorsiflexion)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين استقبال الحسّ للكاحل", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة ربلة الساق", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}]'::jsonb, '[{"name": "تحريك العصب الشظوي"}, {"name": "تحرير الأنسجة عند رأس الشظية"}, {"name": "TENS"}, {"name": "العلاج الحراري"}, {"name": "تقوية الباسطات"}, {"name": "تدريب استقبال الحسّ"}]'::jsonb,
   'انزلاق العصب الشظوي، تقوية رفع القدم، تجنّب الضغط عند رأس الشظية (تربيع الساقين).', 'الملخص السريري: ألم وتنميل على توزيع العصب الشظوي بالوجه الخارجي للساق وظهر القدم.

الأعراض الشائعة: ألم/خدر خارج الساق وظهر القدم، ضعف رفع القدم أحيانًا.

نتائج الفحص: تغيّر حسّي شظوي، ضعف العضلات الباسطة للقدم محتمل، Tinel عند رأس الشظية.

ملاحظات سريرية: تحديد موضع الانضغاط (قطني مقابل شظوي) مهمّ.', 'الاحتياطات: تجنّب الضغط المطوّل على الجانب الخارجي للركبة.

موانع الاستعمال: تقييم عاجل عند ضعف رفع القدم التقدّمي (foot drop).', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 2, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-30', 'Facet''s arthropathy — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Facet''s arthropathy', 'العمود الفقري',
   '["قصير المدى — تخفيف ألم المفاصل الوجيهية", "قصير المدى — تحسين تحمّل البسط", "قصير المدى — تفعيل الجذع", "طويل المدى — استعادة الوظيفة", "طويل المدى — تصحيح الحمل الوضعي", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "إمالة الحوض الخلفية (تخفيف الوجيهية)", "sets": "3", "reps": "12", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمدّد الانثناء (ركبتان للصدر)", "sets": "2", "reps": "", "duration": "", "hold_time": "20 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمرين القط والجمل (Cat–Camel)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "حركة انسيابية للعمود الفقري القطني والصدري لتحسين المرونة.", "notes": ""}]'::jsonb, '[{"name": "تحريك المفاصل الوجيهية"}, {"name": "منهج بتوجّه انثنائي"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "الموجات فوق الصوتية"}, {"name": "تمارين التثبيت"}]'::jsonb,
   'تمارين انثنائية، تجنّب البسط والدوران المطوّل، ضبط الوقوف.', 'الملخص السريري: اعتلال تنكّسي بالمفاصل الوجيهية القطنية مع ألم بالبسط والدوران.

الأعراض الشائعة: ألم قطني موضعي يزداد بالبسط والدوران والوقوف، يتحسّن بالانثناء.

نتائج الفحص: ألم عند البسط/الدوران، حساسية فوق المفاصل الوجيهية، فحص عصبي طبيعي غالبًا.

ملاحظات سريرية: التوجّه الانثنائي يخفّف حمل المفاصل الوجيهية.', 'الاحتياطات: تجنّب البسط القطني المفرط.

موانع الاستعمال: حذر التحريك عند هشاشة شديدة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-31', 'Muscle strain — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Muscle strain', 'العمود الفقري',
   '["قصير المدى — حماية النسيج المصاب", "قصير المدى — تقليل الألم والتورّم", "قصير المدى — استعادة حركة لطيفة", "طويل المدى — استعادة القوة والمرونة الكاملة", "طويل المدى — العودة للنشاط", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "حركة قطنية لطيفة ضمن المدى", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إطالة قطنية لطيفة", "sets": "2", "reps": "", "duration": "", "hold_time": "20 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}]'::jsonb, '[{"name": "الراحة النسبية والحماية"}, {"name": "العلاج البارد ثم الحراري"}, {"name": "التدليك اللطيف"}, {"name": "TENS"}, {"name": "الإطالة المتدرّجة"}, {"name": "التقوية التدريجية"}]'::jsonb,
   'حماية نسبية أوّلًا، حرارة بعد 48–72 ساعة، تدرّج التمارين.', 'الملخص السريري: شدّ/تمزّق جزئي بالألياف العضلية القطنية نتيجة حمل زائد.

الأعراض الشائعة: ألم موضعي حادّ عند الحركة والجسّ، تشنّج واقٍ.

نتائج الفحص: ألم بالجسّ والانقباض المقاوم، محدودية حركة مؤلمة.

ملاحظات سريرية: تدرّج الحمل وفق مراحل الالتئام.', 'الاحتياطات: تجنّب التحميل الثقيل في الطور الحادّ.

موانع الاستعمال: عدم الإطالة القوية على تمزّق حادّ.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   8, 3, 21,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-32', 'Ankylosing spondylitis — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Ankylosing spondylitis', 'العمود الفقري',
   '["قصير المدى — الحفاظ على المدى الحركي والوضعية", "قصير المدى — تحسين توسّع الصدر", "قصير المدى — تخفيف التيبّس", "طويل المدى — إبطاء فقدان الحركة", "طويل المدى — الحفاظ على الوظيفة والاستقامة", "طويل المدى — لياقة عامة مستدامة"]'::jsonb, '[{"name": "بسط صدري وقطني وضعي", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين توسّع الصدر والتنفّس العميق", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "مدى حركي شامل للعمود الفقري", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "سباحة/تمرين مائي هوائي", "sets": "1", "reps": "", "duration": "20 د", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}]'::jsonb, '[{"name": "تمارين المدى والاستطالة اليومية"}, {"name": "تمارين التنفّس وتوسّع الصدر"}, {"name": "تمارين البسط الوضعي"}, {"name": "العلاج المائي"}, {"name": "التمرين الهوائي"}, {"name": "تثقيف مستمرّ"}]'::jsonb,
   'تمارين مدى وتنفّس يومية، وضعيات استقامة، نشاط هوائي منتظم.', 'الملخص السريري: اعتلال فقاري التهابي مزمن يسبّب تيبّسًا تدريجيًا وميلًا للاندماج.

الأعراض الشائعة: ألم/تيبّس قطني التهابي يتحسّن بالحركة، تيبّس صباحي أكثر من ساعة.

نتائج الفحص: محدودية توسّع الصدر والحركة القطنية (Schober معدّل)، اختبارات SIJ.

ملاحظات سريرية: الاستمرارية اليومية أهمّ من الشدّة؛ إدارة دوائية موازية.', 'الاحتياطات: حذر شديد مع أي تحريك عالي السرعة (خطر الكسر مع الاندماج).

موانع الاستعمال: عدم التلاعب أو الجرّ القوي؛ تنسيق مع طبيب الروماتيزم.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 3, 90,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-33', 'Sacral displacement — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Sacral displacement', 'العمود الفقري',
   '["قصير المدى — إعادة التماثل الحوضي", "قصير المدى — تخفيف الألم العجزي", "قصير المدى — تنشيط مثبتات الحوض", "طويل المدى — استعادة ميكانيكا العجز", "طويل المدى — منع التكرار", "طويل المدى — برنامج ثبات"]'::jsonb, '[{"name": "تقنية الطاقة العضلية لإعادة التماثل", "sets": "2", "reps": "5", "duration": "", "hold_time": "6 ث", "rest_time": "10 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تنشيط الألوية (Clamshell)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "إمالة الحوض الخلفية (Posterior pelvic tilt)", "sets": "2", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "تفعيل عضلات البطن وتخفيف الضغط القطني.", "notes": ""}]'::jsonb, '[{"name": "تصحيح/تحريك المفصل العجزي الحرقفي"}, {"name": "تقنيات الطاقة العضلية"}, {"name": "حزام العجز الحرقفي"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "تمارين ثبات الحوض"}]'::jsonb,
   'تمارين ثبات الحوض، حزام عند الحاجة، تجنّب الأوضاع غير المتماثلة.', 'الملخص السريري: إزاحة وضعية للعجز ضمن المفصل العجزي الحرقفي تؤثّر على التماثل الحوضي.

الأعراض الشائعة: ألم عجزي/حوضي، شعور بعدم التماثل، تفاقم بالانتقال والحمل الأحادي.

نتائج الفحص: عدم تناظر معالم العجز، اختبارات حركة SIJ إيجابية.

ملاحظات سريرية: تصحيح ثم تثبيت لمنع العَود.', 'الاحتياطات: تجنّب الحمل الأحادي المفاجئ بعد التصحيح.

موانع الاستعمال: استبعاد الأسباب الالتهابية عند استمرار الأعراض.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 35,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-34', 'Pars fracture — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Pars fracture', 'العمود الفقري',
   '["قصير المدى — حماية موقع الكسر (تجنّب البسط)", "قصير المدى — تخفيف الألم", "قصير المدى — تفعيل الجذع بتوجّه انثنائي", "طويل المدى — التئام/استقرار وظيفي", "طويل المدى — العودة التدريجية للرياضة", "طويل المدى — منع الانزلاق"]'::jsonb, '[{"name": "إمالة الحوض الخلفية مع تثبيت", "sets": "3", "reps": "12", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تمرين البطن المتحكّم (Dead bug)", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}, {"name": "تمدّد انثنائي لطيف", "sets": "2", "reps": "", "duration": "", "hold_time": "20 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تعديل النشاط والحماية"}, {"name": "تمارين تثبيت بتوجّه انثنائي"}, {"name": "العلاج الحراري"}, {"name": "TENS"}, {"name": "تدريب التحكّم الحركي"}, {"name": "برنامج عودة للرياضة"}]'::jsonb,
   'تجنّب البسط والالتواء وأنشطة الصدم، تمارين تثبيت انثنائية.', 'الملخص السريري: كسر بمنطقة البارس (Spondylolysis) قد يسبق الانزلاق الفقري.

الأعراض الشائعة: ألم قطني يزداد بالبسط والنشاط الرياضي، يتحسّن بالراحة.

نتائج الفحص: ألم بالبسط ووقوف على رجل واحدة (اختبار البسط الأحادي)، تفضيل الانثناء.

ملاحظات سريرية: شائع لدى الرياضيين اليافعين؛ الالتزام بالحماية مفتاح الالتئام.', 'الاحتياطات: تجنّب البسط القطني المتكرّر والرياضات عالية الصدمة أثناء الالتئام.

موانع الاستعمال: عدم إجراء تحميل بسطي؛ العودة للرياضة مرحلية بإذن طبي.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 84,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SPN-35', 'Radiculopathy — خطة علاج طبيعي', 'قوالب التشخيص للعمود الفقري', 'Radiculopathy', 'العمود الفقري',
   '["قصير المدى — تخفيف الضغط الجذري", "قصير المدى — تحسين انزلاق العصب", "قصير المدى — حماية الوظيفة العصبية", "طويل المدى — استعادة القوة والإحساس", "طويل المدى — العودة للنشاط الكامل", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "تمرين موجّه بالاتجاه (بسط/انزلاق)", "sets": "3", "reps": "10", "duration": "", "hold_time": "3 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق العصب الوركي (Sciatic nerve glide)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تحريك عصبي لطيف دون إثارة ألم مُشِعّ.", "notes": ""}, {"name": "تمرين الشد البطني (Abdominal bracing)", "sets": "3", "reps": "10", "duration": "", "hold_time": "8 ث", "rest_time": "20 ث", "equipment": "", "description": "تثبيت العضلات العميقة للجذع مع تنفس طبيعي.", "notes": ""}, {"name": "تقوية العضلات الضعيفة بتوزيع الجذر", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "جسر الحوض (Glute bridge)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "تقوية الألوية والباسطات القطنية.", "notes": ""}]'::jsonb, '[{"name": "الجرّ الفقري"}, {"name": "تحريك العصب"}, {"name": "منهج McKenzie الموجّه"}, {"name": "TENS"}, {"name": "العلاج اليدوي"}, {"name": "التثبيت العميق"}]'::jsonb,
   'تمارين موجّهة بالاتجاه وانزلاق عصبي، تجنّب الأوضاع الضاغطة.', 'الملخص السريري: اعتلال جذري نتيجة ضغط/تهيّج جذر عصبي مع أعراض بتوزيع جلدي/عضلي.

الأعراض الشائعة: ألم مُشِعّ، تنميل، ضعف بتوزيع جذري محدّد.

نتائج الفحص: عجز حسّي/حركي جذري، اختبارات توتر عصبي إيجابية، تغيّر انعكاسات.

ملاحظات سريرية: تحديد الجذر المصاب يوجّه التقوية والتحريك.', 'الاحتياطات: مراقبة العجز الحركي وتوزيعه.

موانع الاستعمال: إحالة عاجلة عند عجز تقدّمي أو أعراض ذيل الفرس.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;

-- ── Shoulder templates (14) ───────────────────────────────────
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-01', 'Postoperative — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Postoperative', 'الكتف',
   '["قصير المدى — حماية الإصلاح الجراحي", "قصير المدى — استعادة مدى منفعل لطيف", "قصير المدى — التحكّم في الألم والتورّم", "طويل المدى — استعادة المدى النشط الكامل", "طويل المدى — استعادة قوة الكفّة والمثبتات", "طويل المدى — العودة للوظائف"]'::jsonb, '[{"name": "تمرين البندول (Codman/Pendulum)", "sets": "3", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تأرجح لطيف للذراع لاسترخاء مفصل الكتف وتقليل الألم.", "notes": ""}, {"name": "مدى منفعل مساعد بالعصا (بحسب البروتوكول)", "sets": "3", "reps": "8", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "قبضات اليد وتمارين المرفق/الرسغ", "sets": "3", "reps": "15", "duration": "", "hold_time": "", "rest_time": "", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق كتفي مساعد على الطاولة", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين منفعلة/مساعدة محمية"}, {"name": "تعبئة مفصلية لطيفة لاحقًا"}, {"name": "العلاج البارد"}, {"name": "تفعيل المثبتات الكتفية"}, {"name": "تدريب استقبال الحسّ"}, {"name": "تثقيف ما بعد الجراحة"}]'::jsonb,
   'تمارين محمية وفق مرحلة البروتوكول، ارتداء الحمّالة بحسب التعليمات، تبريد عند الألم.', 'الملخص السريري: تأهيل الكتف بعد الجراحة وفق بروتوكول مرحلي يحمي الإصلاح.

الأعراض الشائعة: ألم وتيبّس بعد الجراحة، محدودية حركة محمية، ضعف عضلي.

نتائج الفحص: مدى محميّ، حالة الجرح، ضعف الكفّة المدوّرة والمثبتات.

ملاحظات سريرية: التقدّم مرحليّ منسّق مع الجرّاح.', 'الاحتياطات: الالتزام الصارم بقيود المدى والحمل بحسب مرحلة الالتئام.

موانع الاستعمال: عدم إجراء حركة نشطة أو مقاومة قبل السماح بالبروتوكول.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   20, 3, 120,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-02', 'Rotator Cuff — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Rotator Cuff', 'الكتف',
   '["قصير المدى — تقليل الألم", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تفعيل الكفّة والمثبتات", "طويل المدى — استعادة قوة الكفّة الكاملة", "طويل المدى — استعادة الوظيفة فوق الرأس", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "دوران خارجي بشريط مطّاطي", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "تقوية تحت الشوكة/المدوّرة الصغيرة.", "notes": ""}, {"name": "دوران داخلي بشريط مطّاطي", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "رفع أمامي/جانبي ضمن مدى غير مؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تمرين الصفّ المنخفض (Low row)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تقوية الكفّة المدوّرة"}, {"name": "تفعيل المثبتات الكتفية"}, {"name": "العلاج اليدوي/التعبئة"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد/الحراري"}, {"name": "إعادة التدريب الحركي"}]'::jsonb,
   'تمارين تقوية الكفّة بالشريط يومًا بعد يوم، تجنّب الأنشطة فوق الرأس المؤلمة.', 'الملخص السريري: اعتلال/إصابة الكفّة المدوّرة مع ضعف وألم عند رفع الذراع.

الأعراض الشائعة: ألم جانبي بالكتف، ضعف الرفع، ألم ليلي، ألم القوس المؤلم.

نتائج الفحص: ضعف/ألم عند اختبارات الكفّة (Jobe، المقاومة)، قوس مؤلم 60–120°.

ملاحظات سريرية: توازن الكفّة والمثبتات أساس النجاح.', 'الاحتياطات: تجنّب التحميل المؤلم فوق الرأس مبكرًا.

موانع الاستعمال: الاشتباه بتمزّق كامل يستدعي تقييمًا وربما جراحة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-03', 'Tendinitis — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Tendinitis', 'الكتف',
   '["قصير المدى — تقليل الالتهاب والألم", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تصحيح ميكانيكا اللوح", "طويل المدى — استعادة تحمّل الوتر", "طويل المدى — العودة للأنشطة فوق الرأس", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "انقباض ثابت للكفّة (Isometric)", "sets": "3", "reps": "5", "duration": "", "hold_time": "20 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية لامركزية للكفّة (Eccentric)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "دوران خارجي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الساعة الكتفية (Scapular clock)", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تحميل تدريجي للوتر (Isometric→Eccentric)"}, {"name": "العلاج اليدوي"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "تصحيح إيقاع اللوح"}, {"name": "تمارين المثبتات"}]'::jsonb,
   'تحميل تدريجي منتظم، تبريد بعد النشاط، تعديل الأنشطة المُثيرة.', 'الملخص السريري: التهاب/اعتلال أوتار الكتف (غالبًا فوق الشوكة) بسبب الحمل الزائد.

الأعراض الشائعة: ألم عند الرفع الجانبي والأنشطة فوق الرأس، حساسية موضعية.

نتائج الفحص: ألم عند اختبارات الاصطدام/المقاومة، قوس مؤلم.

ملاحظات سريرية: التحميل التدريجي أفضل من الراحة التامة.', 'الاحتياطات: تجنّب زيادة الحمل المفاجئة فوق الرأس.

موانع الاستعمال: عدم دفع التمارين خلال ألم حادّ متزايد.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-04', 'Tear — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Tear', 'الكتف',
   '["قصير المدى — تقليل الألم", "قصير المدى — استعادة المدى المنفعل", "قصير المدى — تفعيل الأوتار السليمة والمثبتات", "طويل المدى — تعظيم الوظيفة (تحفّظي) أو التحضير/التأهيل الجراحي", "طويل المدى — استعادة القوة الممكنة", "طويل المدى — استقلالية وظيفية"]'::jsonb, '[{"name": "تمرين البندول (Codman/Pendulum)", "sets": "3", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تأرجح لطيف للذراع لاسترخاء مفصل الكتف وتقليل الألم.", "notes": ""}, {"name": "مدى مساعد بالعصا", "sets": "3", "reps": "8", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "دوران خارجي خفيف بالشريط (بحسب التحمّل)", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية المثبتات (Low row)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "برنامج تحفّظي متدرّج"}, {"name": "تفعيل المثبتات والكفّة السليمة"}, {"name": "العلاج اليدوي اللطيف"}, {"name": "العلاج البارد"}, {"name": "الموجات فوق الصوتية"}, {"name": "تدريب وظيفي تعويضي"}]'::jsonb,
   'تمارين لطيفة ضمن التحمّل، تجنّب الرفع الثقيل، تبريد عند الألم.', 'الملخص السريري: تمزّق (جزئي أو كامل) بأحد أوتار الكفّة المدوّرة.

الأعراض الشائعة: ضعف وألم عند الرفع، ألم ليلي، صعوبة الأنشطة فوق الرأس.

نتائج الفحص: ضعف واضح باختبارات الكفّة، قد يكون هناك علامة إسقاط الذراع.

ملاحظات سريرية: القرار التحفّظي مقابل الجراحي حسب الحجم والوظيفة والعمر.', 'الاحتياطات: تجنّب تحميل الوتر الممزّق تحت مقاومة عالية.

موانع الاستعمال: التمزّق الكامل عند الشباب/النشطين قد يستلزم إصلاحًا جراحيًا.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 3, 70,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-05', 'Dislocation — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Dislocation', 'الكتف',
   '["قصير المدى — حماية المفصل ضمن مدى آمن", "قصير المدى — استعادة التحكّم العضلي", "قصير المدى — تقوية الكفّة والمثبتات", "طويل المدى — استعادة الثبات الوظيفي", "طويل المدى — العودة للأنشطة/الرياضة", "طويل المدى — منع تكرار الخلع"]'::jsonb, '[{"name": "انقباضات ثابتة متعدّدة الاتجاهات", "sets": "3", "reps": "6", "duration": "", "hold_time": "6 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين السلسلة المغلقة (تحميل الوزن على اليد)", "sets": "3", "reps": "10", "duration": "", "hold_time": "10 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي/داخلي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تمارين استقبال الحسّ باللوح المتأرجح", "sets": "2", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تمارين ثبات المفصل"}, {"name": "تقوية الكفّة والمثبتات"}, {"name": "تدريب استقبال الحسّ"}, {"name": "تمارين السلسلة المغلقة"}, {"name": "العلاج اليدوي الحذر"}, {"name": "برنامج عودة للرياضة"}]'::jsonb,
   'تمارين ثبات وتقوية، تجنّب وضعيات الخلع الاستفزازية (البسط+الدوران الخارجي).', 'الملخص السريري: خلع مفصل الكتف مع عدم استقرار وحاجة لإعادة الاستقرار الوظيفي.

الأعراض الشائعة: ألم وعدم ثبات، خوف عند الوضعيات الاستفزازية، ضعف.

نتائج الفحص: اختبار التوجّس (Apprehension) إيجابي، ضعف الكفّة والمثبتات.

ملاحظات سريرية: استقبال الحسّ والتحكّم العضلي أساس منع العَود.', 'الاحتياطات: تجنّب الوضعية الاستفزازية للخلع مبكّرًا.

موانع الاستعمال: عدم دفع المدى المتطرّف قبل استعادة التحكّم؛ تنسيق جراحي عند تكرار الخلع.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   16, 3, 70,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-06', 'Supraspinatus — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Supraspinatus', 'الكتف',
   '["قصير المدى — تقليل الألم عند الإبعاد", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تفعيل فوق الشوكة والمثبتات", "طويل المدى — استعادة قوة الإبعاد", "طويل المدى — استعادة الوظيفة فوق الرأس", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "انقباض ثابت للإبعاد", "sets": "3", "reps": "5", "duration": "", "hold_time": "20 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إبعاد ضمن مستوى اللوح (Scaption) بوزن خفيف", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تقوية لامركزية لفوق الشوكة", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تحميل تدريجي لفوق الشوكة"}, {"name": "تصحيح إيقاع اللوح الكتفي"}, {"name": "العلاج اليدوي"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "تمارين المثبتات"}]'::jsonb,
   'تمارين scaption وتقوية تدريجية، تجنّب الرفع الجانبي المؤلم مبكّرًا.', 'الملخص السريري: اعتلال/إصابة وتر فوق الشوكة، الأكثر شيوعًا بالكفّة المدوّرة.

الأعراض الشائعة: ألم عند الرفع الجانبي، قوس مؤلم 60–120°، ضعف الإبعاد.

نتائج الفحص: اختبار Jobe (العلبة الفارغة) إيجابي، ألم عند الإبعاد المقاوم.

ملاحظات سريرية: Scaption أكثر أمانًا من الإبعاد المستوي الصرف.', 'الاحتياطات: تجنّب الاصطدام بالرفع فوق الرأس المؤلم.

موانع الاستعمال: الاشتباه بتمزّق كامل يستدعي تقييمًا إضافيًا.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-07', 'Infraspinatus — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Infraspinatus', 'الكتف',
   '["قصير المدى — تقليل الألم الخلفي", "قصير المدى — تفعيل تحت الشوكة", "قصير المدى — تصحيح توازن الكفّة", "طويل المدى — استعادة قوة الدوران الخارجي", "طويل المدى — استعادة الوظيفة", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "دوران خارجي بالشريط (0° إبعاد)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي بالاستلقاء الجانبي بوزن خفيف", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية لامركزية للدوران الخارجي", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تمرين الساعة الكتفية", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تقوية الدوران الخارجي المتدرّجة"}, {"name": "تفعيل المثبتات الكتفية"}, {"name": "العلاج اليدوي"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "إعادة التدريب الحركي"}]'::jsonb,
   'تمارين الدوران الخارجي بالشريط، توازن مع المثبتات، تدرّج الحمل.', 'الملخص السريري: اعتلال/ضعف وتر تحت الشوكة المسؤول عن الدوران الخارجي.

الأعراض الشائعة: ألم خلفي بالكتف، ضعف الدوران الخارجي، تعب مع الأنشطة المتكرّرة.

نتائج الفحص: ضعف/ألم عند الدوران الخارجي المقاوم، حساسية خلفية.

ملاحظات سريرية: ضعف تحت الشوكة شائع لدى الرياضيين فوق الرأس.', 'الاحتياطات: تجنّب فرط تحميل الدوران الخارجي مبكّرًا.

موانع الاستعمال: عدم دفع التمارين خلال ألم حادّ.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-08', 'Adhesive capsulitis — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Adhesive capsulitis', 'الكتف',
   '["قصير المدى — تخفيف الألم", "قصير المدى — استعادة المدى تدريجيًا", "قصير المدى — إطالة المحفظة", "طويل المدى — استعادة المدى الوظيفي الكامل", "طويل المدى — استعادة القوة", "طويل المدى — العودة للأنشطة"]'::jsonb, '[{"name": "تمارين المدى بالعصا (Flexion/ER/IR)", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "انزلاق على الجدار (Wall walk)", "sets": "3", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة المحفظة الخلفية (Cross-body)", "sets": "3", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين البندول (Codman/Pendulum)", "sets": "3", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تأرجح لطيف للذراع لاسترخاء مفصل الكتف وتقليل الألم.", "notes": ""}, {"name": "انزلاق كتفي مساعد على الطاولة", "sets": "2", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تعبئة مفصلية (Grade مناسب للمرحلة)"}, {"name": "إطالة المحفظة"}, {"name": "العلاج الحراري قبل الإطالة"}, {"name": "تمارين المدى"}, {"name": "TENS"}, {"name": "برنامج منزلي مكثّف"}]'::jsonb,
   'تمارين المدى المتكرّرة عدة مرّات يوميًا، حرارة قبل الإطالة، إطالة لطيفة مستمرّة.', 'الملخص السريري: الكتف المتجمّد: التهاب وتليّف المحفظة يسبّب تيبّسًا مؤلمًا تدريجيًا.

الأعراض الشائعة: فقدان مدى شامل مؤلم (خاصة الدوران الخارجي)، ألم ليلي، تيبّس تدريجي.

نتائج الفحص: تقييد مدى منفعل ونشط بنفس النمط (capsular pattern)، الدوران الخارجي الأكثر تقييدًا.

ملاحظات سريرية: الصبر والانتظام أساس التحسّن؛ الحالة ذاتية التحدّد غالبًا.', 'الاحتياطات: إطالة ضمن ألم محتمل دون عنف يزيد الالتهاب.

موانع الاستعمال: تجنّب التعبئة العدوانية في الطور المؤلم الحادّ (Freezing).', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   18, 3, 120,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-09', 'Full thickness — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Full thickness', 'الكتف',
   '["قصير المدى — تخفيف الألم", "قصير المدى — الحفاظ على المدى المنفعل", "قصير المدى — تفعيل العضلات التعويضية", "طويل المدى — تعظيم الوظيفة (تحفّظي) أو تأهيل ما بعد الإصلاح", "طويل المدى — استعادة الاستقلالية", "طويل المدى — منع التيبّس"]'::jsonb, '[{"name": "تمرين البندول (Codman/Pendulum)", "sets": "3", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "تأرجح لطيف للذراع لاسترخاء مفصل الكتف وتقليل الألم.", "notes": ""}, {"name": "مدى منفعل/مساعد بالعصا", "sets": "3", "reps": "8", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تفعيل الدالية اللطيف ضمن المدى", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية المثبتات (Low row)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "برنامج تحفّظي/ما بعد جراحي متدرّج"}, {"name": "تمارين منفعلة ومساعدة"}, {"name": "تفعيل المثبتات والدالية"}, {"name": "العلاج البارد"}, {"name": "الموجات فوق الصوتية"}, {"name": "تدريب وظيفي تعويضي"}]'::jsonb,
   'تمارين لطيفة ضمن التحمّل، تجنّب الرفع الفعّال المقاوم، تبريد عند الألم.', 'الملخص السريري: تمزّق كامل السُّمك بوتر الكفّة المدوّرة عبر كامل عرض الوتر.

الأعراض الشائعة: ضعف واضح بالرفع، ألم، صعوبة كبيرة بالأنشطة فوق الرأس.

نتائج الفحص: ضعف شديد باختبارات الكفّة، علامة إسقاط الذراع محتملة.

ملاحظات سريرية: خطة العلاج تعتمد على قرار الإصلاح الجراحي من عدمه.', 'الاحتياطات: تجنّب التحميل المقاوم للوتر الممزّق.

موانع الاستعمال: غالبًا يتطلّب تقييمًا جراحيًا خاصة لدى النشطين.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   18, 3, 90,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-10', 'Partial thickness — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Partial thickness', 'الكتف',
   '["قصير المدى — تقليل الألم", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تفعيل الكفّة تدريجيًا", "طويل المدى — استعادة قوة الكفّة", "طويل المدى — العودة للأنشطة فوق الرأس", "طويل المدى — منع التقدّم لتمزّق كامل"]'::jsonb, '[{"name": "انقباض ثابت للكفّة", "sets": "3", "reps": "5", "duration": "", "hold_time": "20 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي/داخلي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "scaption بوزن خفيف ضمن المدى غير المؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تقوية لامركزية متدرّجة للكفّة", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تحميل تدريجي للكفّة"}, {"name": "تفعيل المثبتات الكتفية"}, {"name": "العلاج اليدوي"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "إعادة التدريب الحركي"}]'::jsonb,
   'تحميل تدريجي منتظم، تجنّب الأنشطة المؤلمة فوق الرأس مبكّرًا.', 'الملخص السريري: تمزّق جزئي السُّمك بوتر الكفّة دون امتداد عبر كامل العرض.

الأعراض الشائعة: ألم عند الرفع فوق الرأس وضعف خفيف، ألم ليلي متقطّع.

نتائج الفحص: ألم أكثر من الضعف باختبارات الكفّة، قوس مؤلم.

ملاحظات سريرية: الاستجابة للعلاج التحفّظي جيدة غالبًا.', 'الاحتياطات: تدرّج الحمل لتجنّب تفاقم التمزّق.

موانع الاستعمال: مراقبة أي زيادة ضعف قد تشير لتقدّم التمزّق.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   14, 3, 56,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-11', 'Biceptal tendinitis — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Biceptal tendinitis', 'الكتف',
   '["قصير المدى — تقليل الألم الأمامي", "قصير المدى — تقليل تهيّج الوتر", "قصير المدى — تصحيح ميكانيكا اللوح", "طويل المدى — استعادة تحمّل الوتر", "طويل المدى — العودة للأنشطة", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "انقباض ثابت لثني المرفق (Biceps isometric)", "sets": "3", "reps": "5", "duration": "", "hold_time": "20 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تقوية لامركزية لثني المرفق", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي بالشريط (توازن الكفّة)", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تمرين الساعة الكتفية", "sets": "2", "reps": "10", "duration": "", "hold_time": "", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تحميل تدريجي للعضلة ذات الرأسين"}, {"name": "تفعيل الكفّة والمثبتات"}, {"name": "العلاج اليدوي"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "تصحيح إيقاع اللوح"}]'::jsonb,
   'تحميل تدريجي، تبريد بعد النشاط، تجنّب الرفع الأمامي الثقيل المتكرّر.', 'الملخص السريري: التهاب/اعتلال الرأس الطويل لوتر العضلة ذات الرأسين بالأخدود.

الأعراض الشائعة: ألم أمامي بالكتف يمتد للذراع، يزداد بالرفع والدوران والحمل.

نتائج الفحص: ألم عند جسّ الأخدود، اختبار Speed/Yergason إيجابي.

ملاحظات سريرية: غالبًا مصاحب لاعتلال الكفّة والاصطدام.', 'الاحتياطات: تجنّب زيادة الحمل الأمامي المفاجئة.

موانع الاستعمال: استبعاد عدم استقرار/تمزّق الوتر الطويل عند الأعراض الشديدة.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-12', 'Hypertrophy — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Hypertrophy', 'الكتف',
   '["قصير المدى — تقليل الالتهاب والتضييق", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تحسين مسار اللوح", "طويل المدى — استعادة الوظيفة فوق الرأس", "طويل المدى — تصحيح الميكانيكا", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "تمرين الصفّ المنخفض (Low row)", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "دوران خارجي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "scaption ضمن المدى غير المؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "إطالة المحفظة الخلفية", "sets": "2", "reps": "", "duration": "", "hold_time": "30 ث", "rest_time": "15 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تصحيح إيقاع اللوح الكتفي"}, {"name": "تمارين المثبتات"}, {"name": "العلاج اليدوي/التعبئة"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "تعديل النشاط"}]'::jsonb,
   'تمارين تحسين مسار اللوح، تجنّب الأنشطة الضاغطة فوق الرأس، تبريد عند الألم.', 'الملخص السريري: تضخّم/سماكة الأنسجة حول الكتف (مثل المفصل الأخرمي الترقوي/الجراب) مسبّبة تضييقًا.

الأعراض الشائعة: ألم فوق الرأس وشعور بالتضييق، حساسية موضعية.

نتائج الفحص: ألم عند اختبارات الاصطدام، حساسية على المفصل الأخرمي الترقوي/الجراب.

ملاحظات سريرية: تحسين ميكانيكا اللوح يقلّل التضييق تحت الأخرم.', 'الاحتياطات: تجنّب الرفع فوق الرأس المؤلم المتكرّر.

موانع الاستعمال: تقييم إضافي عند استمرار الأعراض رغم التأهيل.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   12, 3, 49,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-13', 'AC arthritis — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'AC arthritis', 'الكتف',
   '["قصير المدى — تخفيف ألم المفصل الأخرمي الترقوي", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تفعيل المثبتات", "طويل المدى — استعادة الوظيفة", "طويل المدى — تعديل الأنشطة المُثيرة", "طويل المدى — الوقاية"]'::jsonb, '[{"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "دوران خارجي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الصفّ المنخفض", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "scaption ضمن المدى غير المؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمارين وضعية للجذع العلوي", "sets": "2", "reps": "10", "duration": "", "hold_time": "5 ث", "rest_time": "", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تعديل النشاط"}, {"name": "العلاج اليدوي اللطيف حول المفصل"}, {"name": "الموجات فوق الصوتية"}, {"name": "العلاج البارد"}, {"name": "تمارين المثبتات"}, {"name": "تصحيح الوضعية"}]'::jsonb,
   'تجنّب التقريب الأفقي والرفع الثقيل فوق الرأس، تبريد، تمارين مثبتات لطيفة.', 'الملخص السريري: التهاب مفصلي بالمفصل الأخرمي الترقوي مع ألم موضعي أعلى الكتف.

الأعراض الشائعة: ألم فوق المفصل الأخرمي الترقوي يزداد بالتقريب الأفقي والرفع فوق الرأس.

نتائج الفحص: ألم عند اختبار التقريب الأفقي (Cross-body)، حساسية على المفصل.

ملاحظات سريرية: تعديل النشاط عنصر أساسي للتحكّم بالأعراض.', 'الاحتياطات: تجنّب حركات التقريب الأفقي المؤلمة.

موانع الاستعمال: الحقن/الجراحة تُدرَس عند فشل التحفّظي.', 'التكرار الموصى به: 2 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 2, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;
insert into treatment_templates
  (template_id, name, category, diagnosis, body_part, goals, exercises, methods,
   home_instructions, notes, warnings, followup_instructions,
   estimated_sessions, weekly_frequency, expected_recovery_days,
   status, created_by_name)
values
  ('TPL-SEED-SHD-14', 'Bursitis — خطة علاج طبيعي', 'قوالب تشخيص الكتف', 'Bursitis', 'الكتف',
   '["قصير المدى — تقليل الالتهاب والألم", "قصير المدى — استعادة المدى غير المؤلم", "قصير المدى — تحسين مسار اللوح", "طويل المدى — استعادة الوظيفة الكاملة", "طويل المدى — تصحيح الميكانيكا", "طويل المدى — منع التكرار"]'::jsonb, '[{"name": "تمارين البندول اللطيفة", "sets": "3", "reps": "", "duration": "60 ث", "hold_time": "", "rest_time": "30 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تثبيت لوح الكتف (Scapular setting)", "sets": "3", "reps": "10", "duration": "", "hold_time": "6 ث", "rest_time": "15 ث", "equipment": "", "description": "سحب وخفض لوح الكتف لتفعيل المثبتات.", "notes": ""}, {"name": "دوران خارجي بالشريط", "sets": "3", "reps": "12", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "scaption ضمن المدى غير المؤلم", "sets": "3", "reps": "10", "duration": "", "hold_time": "", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}, {"name": "تمرين الصفّ المنخفض", "sets": "3", "reps": "12", "duration": "", "hold_time": "5 ث", "rest_time": "20 ث", "equipment": "", "description": "", "notes": ""}]'::jsonb, '[{"name": "تعديل النشاط والعلاج البارد"}, {"name": "تصحيح إيقاع اللوح"}, {"name": "العلاج اليدوي/التعبئة"}, {"name": "الموجات فوق الصوتية"}, {"name": "تمارين المثبتات والكفّة"}, {"name": "TENS"}]'::jsonb,
   'تبريد بعد النشاط، تجنّب الأنشطة فوق الرأس المؤلمة، تمارين مثبتات لطيفة.', 'الملخص السريري: التهاب الجراب تحت الأخرم/الداليّ مع ألم عند الحركة فوق الرأس.

الأعراض الشائعة: ألم جانبي/فوق الكتف مع الرفع، حساسية، ألم ليلي محتمل.

نتائج الفحص: ألم عند اختبارات الاصطدام (Neer/Hawkins)، قوس مؤلم.

ملاحظات سريرية: غالبًا مصاحب لمتلازمة الاصطدام واعتلال الكفّة.', 'الاحتياطات: تجنّب الرفع المتكرّر فوق الرأس أثناء الالتهاب.

موانع الاستعمال: عدم دفع التمارين خلال ألم التهابي حادّ متزايد.', 'التكرار الموصى به: 3 جلسات أسبوعيًا. إعادة التقييم كل 4–6 جلسات وتعديل الخطة وفق الاستجابة.',
   10, 3, 42,
   'active', 'بذرة النظام')
on conflict (template_id) do nothing;

-- Refresh PostgREST so the seeded rows are immediately queryable.
notify pgrst, 'reload schema';

