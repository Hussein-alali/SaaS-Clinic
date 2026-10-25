-- =====================================================================
-- 0013_jobs.sql — background jobs and the e-mail log (docs/06 S7;
-- api/src/jobs.js, api/src/job-handlers.js, api/scripts/run-jobs.js).
--
-- jobs: work done after a request or on a schedule, inside hosting.com
-- (no external queue): a failed invitation or password-reset e-mail sent
-- again, the daily maintenance, the resource check (S8). A runner claims
-- one due job at a time with FOR UPDATE SKIP LOCKED (several Passenger
-- processes and the cron runner never run one job twice) and runs it in
-- its own transaction; a failure waits min(2^attempts, 360) minutes and the
-- job is dead after max_attempts (kept with last_error). dedupe_key: one
-- pending job per key. Payloads hold ids only: no e-mail address, token or
-- health data.
--
-- mail_log: one row per e-mail sent or failed (kind, ok), never the
-- address: the SMTP hourly/daily limits are watched from it (S8).
--
-- Platform/ops tables (convention 4): no RLS, never reachable through
-- /api/data.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create table if not exists public.jobs (
  id           bigserial   primary key,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  run_at       timestamptz not null default now(),
  attempts     integer     not null default 0,
  max_attempts integer     not null default 5 check (max_attempts between 1 and 50),
  last_error   text,
  locked_by    text,       -- the runner of the last attempt
  done_at      timestamptz,
  dead_at      timestamptz,
  dedupe_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists jobs_due on public.jobs (run_at, id) where done_at is null and dead_at is null;
create unique index if not exists jobs_dedupe_pending on public.jobs (dedupe_key)
  where done_at is null and dead_at is null;
create index if not exists jobs_dedupe_key on public.jobs (dedupe_key) where dedupe_key is not null;
comment on table public.jobs is
  'Background jobs (S7): claimed with FOR UPDATE SKIP LOCKED, retried with backoff, dead after max_attempts. Payloads hold ids only. Platform/ops table: no RLS (0013).';

create table if not exists public.mail_log (
  id      bigserial   primary key,
  sent_at timestamptz not null default now(),
  kind    text,
  ok      boolean     not null
);
create index if not exists mail_log_sent_at on public.mail_log (sent_at);
comment on table public.mail_log is
  'One row per e-mail sent or failed, never the address: SMTP limits are watched from it (S8). Platform/ops table: no RLS (0013).';
