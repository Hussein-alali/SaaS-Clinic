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
create index if not exists bookings_date_idx      on bookings(date);
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
