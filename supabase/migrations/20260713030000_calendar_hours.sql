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

-- Ask PostgREST to refresh its schema cache immediately.
notify pgrst, 'reload schema';
