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
-- Used by RLS policies that resolve the logged-in therapist by account.
create index if not exists therapists_auth_uid_idx on therapists(auth_uid);

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

-- Ask PostgREST to refresh its schema cache immediately so the new
-- columns are usable without waiting for the automatic reload.
notify pgrst, 'reload schema';
