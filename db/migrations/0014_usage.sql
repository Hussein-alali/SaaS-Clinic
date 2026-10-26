-- =====================================================================
-- 0014_usage.sql — resource ("spend") alerts (docs/06 S8; api/src/usage.js).
--
-- On hosting.com the limits that stop the platform are the account's disk
-- quota (database + clinic files + backups) and the SMTP hourly/daily
-- sending limits, not a bill. The hourly job usage.check stores a snapshot
-- here and e-mails the platform admins when a level (70 / 85 / 95 %) is
-- crossed upward, at most once per level a day, and once when it falls
-- back below 70 % (alert_state).
--
-- Platform/ops tables (convention 4): no RLS, never reachable through
-- /api/data. Old snapshots are kept 90 days (maintenance.daily).
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create table if not exists public.usage_snapshots (
  id               bigserial   primary key,
  taken_at         timestamptz not null default now(),
  db_bytes         bigint,
  files_bytes      bigint,
  backups_bytes    bigint,
  disk_total_bytes bigint,
  disk_free_bytes  bigint,
  emails_last_hour integer,
  emails_today     integer,
  levels           jsonb       not null default '{}'::jsonb
);
create index if not exists usage_snapshots_taken_at on public.usage_snapshots (taken_at desc);
comment on table public.usage_snapshots is
  'Hourly resource snapshots (disk quota, SMTP budget). Platform/ops table: no RLS (0014).';

create table if not exists public.alert_state (
  key        text        primary key,              -- disk, email_hour, email_day
  level      integer     not null default 0,       -- 0, 70, 85 or 95
  sent       jsonb       not null default '{}'::jsonb, -- {"70": "<when the 70 % alert was sent>", ...}
  updated_at timestamptz not null default now()
);
comment on table public.alert_state is
  'The last alert level of each resource and when each level was e-mailed. Platform/ops table: no RLS (0014).';
