-- =====================================================================
-- 0011_rate_limits.sql — rate-limit counters shared by every API process
-- (docs/06 S5; api/src/ratelimit.js).
--
-- Passenger runs several Node processes for the API; an in-memory counter
-- is per process (the limit multiplied by their number) and forgotten on
-- every restart. One row per (bucket, sha256 of the key, window start),
-- incremented with one upsert: fixed windows (login failures 15 minutes,
-- password-reset requests and uploads an hour, invitations a day...).
-- The key itself (an e-mail, an IP, a user id) is never stored.
-- Rows of past windows are removed by the maintenance job (docs/06 S7).
--
-- Platform/ops table (convention 4): no RLS, never reachable through
-- /api/data; written by api/src/ratelimit.js only.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create table if not exists public.rate_limits (
  bucket       text        not null,   -- login_email, reset_ip, invite_org, ...
  key_hash     text        not null,   -- sha256 hex of the key
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket, key_hash, window_start)
);
create index if not exists rate_limits_window_start on public.rate_limits (window_start);
comment on table public.rate_limits is
  'Rate-limit counters per bucket, sha256(key) and fixed window, shared by every API process. Platform/ops table: no RLS (0011).';
