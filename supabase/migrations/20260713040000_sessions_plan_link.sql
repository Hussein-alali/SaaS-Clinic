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

-- ── Relationship notes (requirement audit) ────────────────────
-- Enforced by FK: patients→treatments, treatments→sessions (via
-- sessions.treatment_id), sessions→patients, sessions→bookings,
-- bookings→patients, patient_schedules→patients, subscriptions→patients.
-- therapist_id columns (bookings/sessions/treatments/patients) stay as
-- soft text references: legacy rows mix therapists.id and staff.staff_id
-- values, so a hard FK would reject valid historical data. They are
-- indexed and resolved through the therapists/staff tables by the app
-- and the RLS policies.

notify pgrst, 'reload schema';
