# Scale Readiness (10 items) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClinicSystem EG hold up at ~1,000 users across clinics: race conditions, N+1 / unbounded loading, error tracking, rate limits, background jobs, resource ("spend") alerts, rollback, live-database safety, webhooks, backups.

**Architecture:** Everything stays inside hosting.com (owner decision, 25 Oct 2026): PostgreSQL holds the shared state that several Passenger processes must agree on (rate-limit counters, jobs, error groups, idempotency keys, counters); cPanel cron runs bash/Node scripts (backups, job draining); the existing Node API and React classic scripts get small, focused modules. No external services, no extensions, no superuser.

**Tech Stack:** Node ≥ 18 (Express 5, pg), PostgreSQL ≥ 13 (no extensions), bash + `pg_dump`/`pg_restore`, cPanel cron, Playwright, node:test.

**Spec:** the owner's checklist "Ready for 1,000 users? 10 things that will expose it" (conversation, 25 Oct 2026) + `docs/02-TRD.md` + `docs/05-Backend-Schema.md`. The owner opted out of brainstorming questions: "start directly, everything inside hosting.com".

## Global Constraints

- Inside hosting.com only: no Sentry, no S3, no external queues. cPanel: PostgreSQL ≥ 13, Node from "Setup Node.js App", cron, SMTP with an hourly limit.
- Migrations are new files from `0010`; never edit an applied one. Every migration keeps the previous release working (expand/contract).
- New platform/ops tables have no RLS and are never exposed by `/api/data` (convention 4); add them to `PLATFORM_TABLES` in `db/test/helpers.js`.
- No health data in logs, error events, job payloads or alerts (NFR-012): scrub e-mails, phones, long digit runs, query strings, request bodies.
- Error codes in English (`slot_taken`, `rate_limited`...), messages shown to people through `tt()` with English in `src/lang/`.
- Every change updates the six docs + `docs/PROGRESS.md` in the same commit (CLAUDE.md). One commit per task.
- Tests: `npm test`, `DATABASE_URL=… node --test 'db/test/*.test.js' 'api/test/*.test.js'`, full Playwright suite — all green before each commit.

## Review Focus

- Two receptionists press «تأكيد الحجز» for the same therapist, date and time within the same second → exactly one booking, the other sees «هذا الموعد محجوز بالفعل».
- A double click (or a retried request after a timeout) on a quick payment → one payment, one receipt; the second request gets the same answer.
- The database disk is nearly full when the nightly backup runs → the backup refuses to fill the disk, says so, and an alert goes out.
- A deploy whose new release does not start → the previous release is serving again within a minute, without a manual step.
- An error message that contains a patient's phone number or e-mail → stored with the number/e-mail masked.

---

### Task 1: Backups (item 10)

**Files:** Create `scripts/backup.sh`, `scripts/restore-check.sh`, `db/test/backup.test.js`; modify `scripts/dev-db.sh` (also create an empty `clinicsys_restore` database owned by the app role), `docs/08-Hosting-Migration.md` (cron lines, runbook).

**Interfaces — Produces:** `scripts/backup.sh [--db-only]` with env `DATABASE_URL`, `FILES_DIR`, `BACKUP_DIR` (default `$HOME/clinicsys-backups`), `BACKUP_KEEP_DAILY=7`, `BACKUP_KEEP_WEEKLY=4`, `BACKUP_MIN_FREE_MB=1024` → writes `BACKUP_DIR/<UTC stamp>/{db.dump,files.tar.gz,manifest.json}`, exit 0; exit 3 when free space would drop under `BACKUP_MIN_FREE_MB`; exit 4 when `BACKUP_DIR` is inside `public_html` or inside `FILES_DIR`. `manifest.json` = `{stamp, kind:"daily"|"weekly", db:{file,bytes,sha256}, files:{file,bytes,sha256}|null, release}`. Sunday backups are `weekly`. `scripts/restore-check.sh` with `RESTORE_DATABASE_URL` → restores the newest `db.dump` there (`pg_restore --clean --if-exists --no-owner`), compares `count(*)` of every `public` table with the live database, checks `tar -tzf`, prints a table and exits 1 on any difference.

- [ ] Test `backup.test.js`: runs `backup.sh` against the test DB into a temp dir; asserts manifest fields and sha256; runs it 9 times with faked stamps (`BACKUP_STAMP=` env) and asserts only 7 daily + Sunday weekly remain; asserts exit 4 for `BACKUP_DIR=$FILES_DIR/x`; runs `restore-check.sh` into `clinicsys_restore` and asserts exit 0 and a printed `patients` count equal to the live one; then inserts a row in the live DB after the dump and asserts `restore-check.sh` exits 1.
- [ ] Watch it fail, implement, watch it pass; commit "Backups: nightly pg_dump + files archive with rotation and a restore check".

### Task 2: Health endpoint, deploy and rollback (item 7)

**Files:** Create `api/src/routes/health.js`, `scripts/deploy.sh`, `scripts/rollback.sh`, `test/deploy.test.mjs`; modify `api/src/create-app.js` (mount `/api/health`).

**Interfaces — Produces:** `GET /api/health` → `200 {ok:true, release, db:"ok"}` or `503 {ok:false, db:"down"}` (one `select 1`, 2 s timeout, no auth, no tenant). `scripts/deploy.sh <release-dir-or-tarball>`: env `APP_HOME` (layout `APP_HOME/releases/<stamp>-<id>/`, `APP_HOME/current` → symlink, `APP_HOME/shared/` for `.env` and `FILES_DIR`), steps: `backup.sh --db-only` (abort on failure) → copy release → `npm ci --omit=dev` in `api/` and `db/` (skippable with `SKIP_INSTALL=1`) → `node db/migrate.js` → atomic switch (`ln -s` to a temp link + `mv -T`) → restart (`touch current/api/tmp/restart.txt`, overridable `RESTART_CMD`) → poll `HEALTH_URL` (default `http://127.0.0.1:$PORT/api/health`) for 60 s → on failure switch back to the previous release, restart, exit 2. Keeps the 5 newest releases. `scripts/rollback.sh [release-name]` → previous (or named) release, restart, health check, exit 0/2. Code-only rollback; the database is never rolled back automatically (expand/contract makes the previous release work; a bad migration is undone by restoring the pre-deploy dump — runbook).

- [ ] Test `deploy.test.mjs` (fake `APP_HOME`, `SKIP_INSTALL=1`, `MIGRATE_CMD=true`, `BACKUP_CMD=true`, a tiny local HTTP server as `HEALTH_URL` that the test makes healthy or failing): deploy A → current=A; deploy B healthy → current=B, A kept; deploy C with a failing health → exit 2 and current=B; `rollback.sh` → current=A; 7 deploys → 5 releases kept. API test for `/api/health` 200 and 503 (pool pointed at a closed port).
- [ ] Watch fail → implement → pass → commit "Deploy with atomic switch, health check and automatic rollback".

### Task 3: Live-database safety (item 8)

**Files:** Modify `db/migrate.js`; create `db/test/migrations-lint.test.js`; modify `api/test/helpers.js` / `db/test/helpers.js` only if the guard needs it.

**Interfaces — Produces:** `migrate.js` sets per migration `SET LOCAL lock_timeout = '5s'` (`MIGRATE_LOCK_TIMEOUT`) and `SET LOCAL statement_timeout = '15min'`; when `APP_ENV=production` (or `NODE_ENV=production`) it refuses to apply pending migrations unless `BACKUP_DIR` has a `manifest.json` newer than 2 hours (`--no-backup-check` overrides), exit 5 with an Arabic+English message. Lint: every migration `>= 0010` must not contain `drop table`, `drop column`, `rename`, `alter column … type`, `set not null` unless the line before carries `-- contract:` with a reason.

- [ ] Tests: lint test fails on a fixture file with `drop column` and passes with `-- contract:`; a migrate test proves a lock held by another session makes the migration fail fast (≤ 6 s, SQLSTATE 55P03) instead of hanging, and that `APP_ENV=production` without a fresh manifest exits 5.
- [ ] Fail → implement → pass → commit "Migrations: lock timeout, backup gate in production, expand/contract lint".

### Task 4: Race conditions (item 1) — migration `0010_concurrency.sql`

**Files:** Create `db/migrations/0010_concurrency.sql`, `db/test/concurrency.test.js`, `api/src/idempotency.js`, `api/test/concurrency.test.js`; modify `api/src/errors.js` (`BK409` → 409 `slot_taken`), `api/src/routes/rpc.js` (Idempotency-Key), `src/supabase.jsx` (send the key for `record_quick_payment`; Arabic/English message for `slot_taken`), `src/lang/en-tenant.jsx`.

**Interfaces — Produces:**
- Trigger `bookings_slot_guard` (BEFORE INSERT OR UPDATE OF therapist_id, doctor_id, date, time, status): when the row is active (status not in `('ملغي','ملغى','cancelled','متاح')`), takes `pg_advisory_xact_lock(hashtext('clinicsys.slot'), hashtext(org||therapist||date||time))` and raises SQLSTATE `BK409` message `slot_taken` if another active booking of the same organization has the same `therapist_id` (non-null), `date`, `time`; same rule for `doctor_id`. Existing duplicate rows are left alone (no unique index, so legacy data migrates).
- `org_counters(organization_id, name, value)` + `next_org_counter(org uuid, name text) returns bigint` (row lock); `record_quick_payment` re-created so `receipt_no = 'RCT-' || to_char(now(),'YYYYMMDD') || '-' || lpad(next_org_counter(org,'receipt')::text, 5, '0')` and `unique(organization_id, receipt_no)` replaces the global unique (task 2.10).
- `new_record_id(prefix text) returns text` (prefix + base36 epoch ms + 6 random base36 chars, same shape as `newRecordId`) used by the SQL generators of `PMT-`, `TPL-`, `TM-`, `TU-`, `TPC-` (task 2.10).
- `idempotency_keys(scope text, key text, organization_id uuid, user_id uuid, status int, response jsonb, created_at)`, primary key `(scope, key)`. `api/src/idempotency.js`: `withIdempotency(db, {scope, key, orgId, userId}, run: () => Promise<{status, body}>) → {status, body, replayed}`; same key + same user → stored answer (`Idempotency-Replayed: true`), same key + another user → 409 `idempotency_conflict`; keys 8–100 chars `[A-Za-z0-9_-]`.
- `/api/rpc/:fn` honours header `Idempotency-Key` (scope `rpc:<fn>`); the client sends one key per payment attempt (kept across retries of that attempt).

- [ ] DB tests: two connections insert the same therapist/date/time concurrently → one succeeds, one gets `BK409`; a cancelled booking does not block; 20 parallel `record_quick_payment` calls → 20 distinct receipt numbers `RCT-<today>-00001…00020` per org; two clinics both get `00001`. API test: the same `Idempotency-Key` twice → one payment row, identical bodies, second has `Idempotency-Replayed: true`; another user with that key → 409. e2e: booking the same slot from two pages → the second shows the Arabic message.
- [ ] Fail → implement → pass → commit "Concurrency: slot guard, per-clinic receipt counters, SQL record IDs, idempotent payments".

### Task 5: Rate limits (item 4) — migration `0011_ops.sql` (part 1)

**Files:** Create `db/migrations/0011_ops.sql` (tables of tasks 5–8), `api/src/ratelimit.js`, `api/test/ratelimit.test.js`; modify `api/src/auth.js` (replace the in-memory `FailureLimiter` for login with the shared one), `api/src/routes/auth.js` (reset), `api/src/routes/org.js` + `api/src/routes/platform.js` (invitations), `api/src/routes/invitations.js`, `api/src/routes/files.js`, `api/src/create-app.js` (per-user in-memory throttle), `src/supabase.jsx` + `src/lang/en-tenant.jsx` (`rate_limited` message with minutes).

**Interfaces — Produces:** table `rate_limits(bucket, key_hash, window_start, count)` PK `(bucket, key_hash, window_start)`; `hit(db, bucket, key, {limit, windowSec}) → {allowed, count, retryAfterSec}` (fixed window, one upsert, key stored as sha256); `limitMiddleware(bucket, keyFn, opts)`; 429 `{code:'rate_limited', message, retry_after}` + `Retry-After`. Limits: login failures 10/15 min per e-mail and 50/15 min per IP; password-reset requests 3/h per e-mail, 20/h per IP; invitation create+resend 5/day per target e-mail (task 2.19) and 200/day per clinic; invitation lookup/accept 30/10 min per IP; uploads 120/h per user; client error reports 30/min per IP; general API 600/min per user in memory per process (runaway-loop guard).

- [ ] Tests: 11th failed login for one e-mail → 429 with `Retry-After`, from a second app instance sharing the DB too (proves cross-process); success does not count; 6th resend to one e-mail in a day → 429; window rollover allows again (fake clock via `RATE_LIMIT_NOW` test hook). Client test: `rate_limited` shows the Arabic/English message.
- [ ] Fail → implement → pass → commit "Shared rate limits in PostgreSQL for login, reset, invitations, uploads".

### Task 6: Error tracking (item 3)

**Files:** `0011_ops.sql` (`error_groups`, `error_events`); create `api/src/errorlog.js`, `api/src/routes/client-errors.js`, `api/test/errorlog.test.js`, `src/errors.jsx` (listed in `index.html` right after `src/apiclient.jsx`), `e2e/errors.spec.cjs`; modify `api/src/create-app.js` (5xx + `unhandledRejection`/`uncaughtException`), `api/src/routes/platform.js` (`GET /errors`, `POST /errors/:fingerprint/resolve`), `src/platform.jsx` (A08 «الأخطاء» page + A01 card), `src/screens3.jsx` (an `ErrorBoundary` around each page), dictionaries.

**Interfaces — Produces:** `recordError({source:'api'|'client', message, stack, route, method, status, code, orgId, userId, release, userAgent})` → never throws; scrubs (e-mails → `[email]`, `\+?\d[\d\s-]{6,}` → `[number]`, query strings dropped, stack ≤ 4 KB); `fingerprint = sha256(source + normalized message + first stack frame)`; upsert `error_groups(fingerprint, source, message, route, first_seen, last_seen, count, last_release, resolved_at)` and store at most 1 `error_events` row per fingerprint per minute (count still increments). `POST /api/client-errors` (no session needed; org/user attached when present; body ≤ 8 KB; rate-limited). `src/errors.jsx`: `window.onerror`, `unhandledrejection`, `reportClientError(err, info)`; `ErrorBoundary` shows «حدث خطأ في هذه الصفحة» / "Something went wrong on this page" with «إعادة المحاولة» and reports once. A group re-appearing after `resolved_at` is unresolved again.

- [ ] Tests: API throws in a test route → one group, count 2 after two hits, one event within the minute; a message `call 01012345678 or a@b.test` is stored as `call [number] or [email]`; client report endpoint stores `source:'client'`; platform list sorted by `last_seen` and resolve; e2e: a page that throws shows the boundary card (both languages) and the platform A08 lists it.
- [ ] Fail → implement → pass → commit "Error tracking inside the database: API and browser errors, grouped, scrubbed, in the platform panel".

### Task 7: Background jobs (item 5)

**Files:** `0011_ops.sql` (`jobs`, `mail_log`); create `api/src/jobs.js`, `api/scripts/run-jobs.js`, `api/test/jobs.test.js`; modify `api/app.js` (in-process poller), `api/src/invites.js` + password-reset code (failed e-mail → retry job), `api/src/mailer.js` (count sends in `mail_log`, no addresses).

**Interfaces — Produces:** table `jobs(id bigserial, kind, payload jsonb, run_at, attempts, max_attempts default 5, locked_at, locked_by, last_error, done_at, dedupe_key unique where done_at is null, created_at)`. `enqueue(db, kind, payload, {runAt, maxAttempts, dedupeKey}) → id`; `register(kind, async (payload, ctx) => {})`; `runDue(db, {limit=20, workerId}) → {done, failed, retried}` using `select … for update skip locked`, each job in its own transaction, backoff `min(2^attempts minutes, 6 h)`, dead after `max_attempts` (kept with `last_error`). Runners: `node api/scripts/run-jobs.js` (cron every minute; drains up to 60 s then exits) and an in-process poller every 10 s (`JOBS_POLL_MS`, off in tests). Kinds now: `email.invitation` `{invitationId, lang}` (re-issues a token like «إعادة الإرسال», never stores a token), `email.password_reset` `{userId, lang}`, `maintenance.daily` (purge `rate_limits` > 2 days, `error_events` > 90 days, done `jobs` > 30 days, `mail_log` > 90 days), `usage.check` (task 8). Payloads never contain e-mails, tokens or health data. Platform A01 shows queued / failed counts.

- [ ] Tests: a handler that fails twice then succeeds → done with attempts 3; a dead job after 5; two concurrent `runDue` never run one job twice (SKIP LOCKED); invitation e-mail failure → `email_status:'failed'` then a job that re-sends and sets `sent`; `dedupeKey` collapses duplicates; payload of an invitation job has no e-mail/token.
- [ ] Fail → implement → pass → commit "Background jobs in PostgreSQL with retries, cron runner and e-mail retries".

### Task 8: Resource ("spend") alerts (item 6)

**Files:** `0011_ops.sql` (`usage_snapshots`, `alert_state`); create `api/src/usage.js`, `api/test/usage.test.js`; modify `api/src/routes/platform.js` (`GET /usage`), `src/platform.jsx` (A01 «الموارد» card), `api/src/jobs.js` (register `usage.check`, hourly via dedupe key per hour), `api/src/mailer.js` (e-mail jobs defer when `mail_log` last hour ≥ `SMTP_HOURLY_LIMIT`).

**Interfaces — Produces:** `collectUsage(db, config) → {dbBytes, filesBytes, backupsBytes, diskTotalBytes, diskFreeBytes, emailsLastHour, emailsToday}` (`pg_database_size`, a size walk of `FILES_DIR` and `BACKUP_DIR`, `fs.statfs`, `mail_log`); env `DISK_QUOTA_MB` (default 30720), `SMTP_HOURLY_LIMIT` (default 100), `SMTP_DAILY_LIMIT` (default 1000). `checkUsage(db, config, {now})` stores a snapshot and returns alerts; levels 70 / 85 / 95 % of quota or limit; an alert e-mail (both languages) goes to every platform admin when a level is crossed upward, at most once per level per 24 h (`alert_state(key, level, sent_at)`), plus «انتهى الخطر» when it falls below 70 %.

- [ ] Tests: fake usage at 72 % → one 70 % alert, a second check sends nothing, 86 % → 85 % alert; e-mails deferred when the hourly limit is reached (job `run_at` moved to the next hour); `/api/platform/usage` returns the latest snapshot.
- [ ] Fail → implement → pass → commit "Resource alerts: disk, database, backups and e-mail budget".

### Task 9: N+1 queries and bounded loading (item 2)

**Files:** Modify `api/src/db.js` (per-request query counter, exposed to tests), create `api/test/querycount.test.js`, `db/migrations/0012_indexes.sql`; modify `src/supabase.jsx` (`hydrateDomainTables` loads a date window for time-series tables), the screens that need older rows (patient history, reports, payments «كل الفترات») to load their range on demand; `e2e/` test for the window.

**Interfaces — Produces:** `db.queryCount(req)` (test hook); index migration: `(organization_id, branch_id, date)` on `bookings`, `sessions`, `invoices`, `payments`; `(organization_id, patient_id)` on `bookings`, `sessions`, `invoices`, `payments`, `patient_files`, `treatments`. Startup window: `bookings`/`sessions`/`payments` from today − 180 days to today + 180 days; `invoices` in that window **or** not fully paid; `KineticData.listRange(table, fromIso, toIso, {patientId})` for older rows, used by patient history, reports outside the window, and «كل الفترات».

- [ ] Tests: list endpoints (`/api/org/members`, `/api/org/invitations`, `/api/platform/organizations`, `/api/platform/audit`, `/api/org/usage`) run the same number of queries with 3 and with 60 rows; startup requests with 2,000 old bookings return only the window; a patient's 2-year-old session still shows in their history; a report for last year shows last year's totals.
- [ ] Fail → implement → pass → commit "No N+1 in list endpoints; indexes; the app loads a date window and fetches older rows on demand".

### Task 10: Webhooks foundation (item 9)

**Files:** Create `api/src/webhooks.js`, `api/test/webhooks.test.js`; modify `api/src/create-app.js` (mount `/api/webhooks/:provider` only for providers with a configured secret).

**Interfaces — Produces:** `verifySignature({secret, rawBody, signatureHex, timestamp, toleranceSec=300, now}) → boolean` (HMAC-SHA256 of `timestamp + "." + rawBody`, constant-time compare); `webhookRoute({provider, secret, parse: (rawBody, headers) => ({eventId, type, timestamp, signature, data})})` → raw-body Express handler: 400 bad signature / stale timestamp, idempotency through `idempotency_keys` (scope `webhook:<provider>`, key `eventId`), enqueue job `webhook.<provider>.<type>`, answer `200 {received:true}` within one transaction, duplicates `200 {received:true, duplicate:true}`. No provider is configured today (subscriptions are manual); `WEBHOOK_<PROVIDER>_SECRET` turns one on.

- [ ] Tests with a fake provider: valid → 200 + one job; same event again → 200 duplicate, still one job; wrong signature → 400; timestamp 10 min old → 400; unconfigured provider → 404.
- [ ] Fail → implement → pass → commit "Webhook foundation: signature, replay window, idempotency, async processing".

### After the ten tasks

- [ ] `docs/02-TRD.md`: section «الجاهزية للتوسع» with the ten items as standing requirements for every future feature; `docs/PROGRESS.md` working rule pointing to it.
- [ ] Full verification (client, db+api, Playwright, build size) and a final review of the whole diff (superpowers:requesting-code-review).
