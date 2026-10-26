-- =====================================================================
-- 0012_error_log.sql — error tracking inside the database (docs/06 S6;
-- api/src/errorlog.js; platform page A08 «الأخطاء»).
--
-- No external service on hosting.com: the API's 5xx and unhandled errors
-- and the browser's reports (POST /api/client-errors) are grouped by
-- fingerprint (sha256 of source + normalized message + first stack frame).
-- error_groups keeps one row per fingerprint (count, first/last seen, the
-- last release, resolved_at; a new occurrence reopens a resolved group);
-- error_events keeps at most one sample per group a minute. Messages and
-- stacks are scrubbed before they get here (e-mails, phone numbers and
-- long digit runs, query strings): no health data (NFR-012).
-- Samples older than 30 days are removed by the maintenance job (S7).
--
-- Platform/ops tables (convention 4): no RLS, never reachable through
-- /api/data; read by the Super Admin through /api/platform/errors.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create table if not exists public.error_groups (
  fingerprint   text        primary key,
  source        text        not null check (source in ('api', 'client')),
  message       text        not null,
  route         text,
  status        integer,
  code          text,
  count         bigint      not null default 1,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_event_at timestamptz,
  last_release  text,
  resolved_at   timestamptz
);
create index if not exists error_groups_last_seen on public.error_groups (last_seen desc);
comment on table public.error_groups is
  'Errors grouped by fingerprint (api, client), scrubbed. Platform/ops table: no RLS (0012).';

create table if not exists public.error_events (
  id              bigserial   primary key,
  fingerprint     text        not null references public.error_groups (fingerprint) on delete cascade,
  created_at      timestamptz not null default now(),
  message         text        not null,
  stack           text,
  route           text,
  method          text,
  status          integer,
  code            text,
  organization_id uuid,
  user_id         uuid,
  release         text,
  user_agent      text
);
create index if not exists error_events_fingerprint_created on public.error_events (fingerprint, created_at desc);
create index if not exists error_events_created_at on public.error_events (created_at);
comment on table public.error_events is
  'At most one scrubbed sample per error group a minute. Platform/ops table: no RLS (0012).';
