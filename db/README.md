# db/ — PostgreSQL migrations and database tests

The database for hosting.com (cPanel PostgreSQL). The rules every migration
follows are in [`docs/05-Backend-Schema.md`](../docs/05-Backend-Schema.md)
("hosting.com PostgreSQL conventions"); the architecture is in
[`docs/02-TRD.md`](../docs/02-TRD.md).

```
db/
├── package.json             # dependency: pg (nothing else)
├── migrate.js               # applies migrations/*.sql in order
├── migrations/
│   ├── 0001_baseline.sql    # Supabase_All_In_One.sql ported to plain PostgreSQL
│   ├── 0002_platform.sql    # platform/identity tables + catalog seed (no RLS)
│   ├── 0003_tenancy.sql     # organization_id/branch_id, FORCE RLS, plan limits
│   ├── 0004_audit_integrity.sql # members' audit rows: id/actor/time set by the database
│   ├── 0005_branches_no_delete.sql # branches are deactivated, never deleted
│   ├── 0006_staff_role.sql  # staff.role accepts 'staff'
│   ├── 0007_rpc_role_guards.sql # NULL-safe RPC role guards; billing RPCs admin/receptionist
│   ├── 0008_invitation_email_status.sql # invitations.email_status / email_status_at
│   └── 0009_inactive_branch_guard.sql # no new row on an inactive branch (BR409)
├── seed/
│   └── dev.sql              # two demo clinics — development/test ONLY
└── test/
    ├── helpers.js           # shared: migrate + seed once, contexts, fixtures, shared test lock
    ├── audit.test.js        # 0004: audit rows cannot be forged or squat ids
    ├── index.js             # `node --test db/test/` on Node 21+
    ├── baseline.test.js     # migrate.js and the 0001 port
    ├── migrate-safety.test.js # lock/statement timeouts, production backup gate, expand/contract lint
    ├── backup.test.js       # scripts/backup.sh and restore-check.sh
    ├── isolation.test.js    # tenant isolation of every clinic table
    ├── branch.test.js       # branch_scope / member_branches
    ├── limits.test.js       # plan limits (PL422)
    ├── rpc.test.js          # the 0001 RPCs under tenant context
    ├── role_guards.test.js  # 0007: RPCs refuse members without a usable role
    └── seed.test.js         # what dev.sql provides
```

## Requirements

- Node.js 18 or 20 (the hosting.com range). Node 22 also works; see the test
  command below.
- PostgreSQL 13 or newer. The migrations and tests have been run on 13.23
  and 16.
- Install the dependency once: `npm --prefix db install`.

## Local database

`scripts/dev-db.sh` starts a local PostgreSQL that behaves like cPanel: you
connect as the database owner, who is **not** a superuser and cannot create
roles. Anything that would fail on hosting.com fails here first.

```sh
scripts/dev-db.sh start 55001      # prints DATABASE_URL
scripts/dev-db.sh reset 55001      # drop + recreate the database (clean slate)
scripts/dev-db.sh stop  55001
```

Use your own port when several runs share a machine.

## Running migrations

```sh
export DATABASE_URL=$(scripts/dev-db.sh reset 55001)
node db/migrate.js            # applies every pending file, prints what it applied
node db/migrate.js            # second run: "nothing to apply"
node db/migrate.js --status   # lists applied/pending files, applies nothing
```

- Works from any directory; `node db/migrate.js` from the repo root is the
  usual form.
- Files run in filename order. Each file runs in its own transaction, together
  with its row in `public.schema_migrations (version, applied_at)`. `version`
  is the filename without `.sql`, for example `0001_baseline`.
- Applied files are skipped. A session advisory lock stops two runs from
  overlapping.
- On error, the failing file is rolled back completely and the runner exits
  with code 1. It prints `file:line`, the SQLSTATE and PostgreSQL's
  DETAIL/HINT/CONTEXT. The line number is only available for errors that
  PostgreSQL reports with a position (syntax errors, unknown
  columns/relations).

Live-database safety (docs/06 S3, `db/test/migrate-safety.test.js`):

- Each file waits at most `MIGRATE_LOCK_TIMEOUT` (default `5s`) for a lock
  and runs at most `MIGRATE_STATEMENT_TIMEOUT` (default `15min`). A file that
  hits either (SQLSTATE `55P03` / `57014`) is rolled back; retry it later,
  instead of every clinic's requests queueing behind it.
- With `NODE_ENV=production`, pending files need a backup younger than 2
  hours in `BACKUP_DIR` (default `~/clinicsys-backups`, written by
  `scripts/backup.sh`), else exit code 5. `--no-backup-check` skips this on
  purpose. `scripts/deploy.sh` takes that backup before migrating.

On hosting.com, `scripts/deploy.sh` runs the migrations of a release
(docs/08 «النشر والتراجع»); by hand, from the cPanel Terminal (or SSH) after
`. ~/clinicsys/shared/env`.

### Writing a migration

- Name it `NNNN_short_name.sql` with the next 4-digit number. The runner
  refuses other names and duplicate numbers.
- Do not write `BEGIN`/`COMMIT`/`ROLLBACK` in the file. The runner wraps it
  and refuses files that contain them.
- Never edit a file that has been applied to a shared database. Add a new one.
- Expand/contract (from `0010`, enforced): the release still running during
  a deploy uses the new schema, so add, do not break. `drop table`,
  `drop column`, `rename`, a column type change and `set not null` are
  refused unless the line before (or the same line) carries
  `-- contract: <reason>` — do them one release after the code stopped
  using the old shape.
- PostgreSQL 13 syntax only: no `CREATE OR REPLACE TRIGGER`, `MERGE`,
  `NULLS NOT DISTINCT`, `security_invoker` views or jsonb subscripting. No
  extensions. No `CREATE ROLE`, `GRANT` to Supabase roles, or `ALTER SYSTEM`.
- Check it with `scripts/dev-db.sh reset`, then `node db/migrate.js` twice,
  then the tests.

## Tests

```sh
export DATABASE_URL=$(scripts/dev-db.sh reset 55001)
node --test db/test/                 # any Node version (test/index.js handles Node 21+)
node --test 'db/test/*.test.js'      # same, with a glob
npm --prefix db test                 # any Node version
node --test db/test/ api/test/       # both suites on one database (see below)
```

The tests run the real migrations against `DATABASE_URL` (a no-op when they
are applied). The tenancy tests (`helpers.js` → `ensureDatabase()`) also apply
`db/seed/dev.sql` when the demo clinics are missing — and refuse when the
database already has other organizations, so point them at a database made
by `scripts/dev-db.sh reset`. Everything else runs in rolled-back
transactions; several test files can share one database at the same time.

The API tests (`api/test`) wipe, re-migrate and re-seed the same database
when `API_TEST_DATABASE_URL` is unset. The two suites coordinate with the
advisory lock 2026102210: every db test process holds it **shared** for its
lifetime (`helpers.js` → `shareDatabase()`, also called by
`baseline.test.js`), each API test file holds it **exclusively** and leaves
the database migrated + seeded when it ends. Without that lock a combined run
fails (checked: 9 db tests failed with it disabled).

On Node ≥ 21 a directory argument to `node --test` is treated as a file
pattern; `test/index.js` then loads every `*.test.js` inside its own
`describe()` in one process (on Node 18/20 it is an empty file).

`isolation.test.js` discovers every table with `organization_id` from the
catalog. For each clinic table it checks FORCE RLS, the RESTRICTIVE
`tenant_isolation` policy, the default/NOT NULL/FK/index on
`organization_id`, organization-scoped uniques, and — as the table owner with
the API's request context — that a demo-physio member never reads, inserts,
updates or deletes demo-dental rows; that a non-member context, no context, a
Super Admin, a disabled membership/account and a suspended clinic get nothing
(except the public branding rows: `clinic_settings` and visible
`custom_sections`, which `/api/orgs/resolve` reads without a role, and one's
own `staff` row); and that the global template library is readable by both
clinics and writable by neither. `branch.test.js`, `limits.test.js`,
`rpc.test.js` and `seed.test.js` cover branches, plan limits, the RPCs and the
seed.

`baseline.test.js` checks:

- the migration CLI: it applies once, a second run applies nothing, it exits 1
  without `DATABASE_URL` or a reachable database, a failing file is rolled back
  and not recorded, and bad file names and transaction statements are refused;
- the catalog: the 25 RPC functions exist (the 23 that `src/*.jsx` calls,
  re-read from the source, plus the legacy `create_treatment_method` /
  `update_treatment_method`); the only extension is `plpgsql`; every policy is
  `TO PUBLIC`; there is no `storage` schema and no pgcrypto; the seeds were
  kept (settings row, 9 methods, 2 categories, 49 templates) and the
  password seeds are gone;
- the `auth` compatibility schema: columns, case-insensitive unique email,
  `auth.uid()` from `app.user_id` (transaction-local), and reset tokens
  cascading with their user;
- a single-clinic smoke test under the current role model (`app_role()` reads
  `staff`): an admin adds a patient, a booking and an invoice; calls
  `record_quick_payment` (ledger row, audit event, all-or-nothing on over-pay)
  and `list_treatment_templates`; receptionists and inactive staff are
  refused. Another test forces RLS on `patients` (rolled back) to show that
  the ported policies still filter rows for the owner role.

Every write happens inside a transaction that is rolled back, so the tests
leave the database as the migration made it. Other test files can share the
database.

After `0003_tenancy.sql` replaces `app_role()`, the two old-role-model tests
skip themselves, and the 0001 seed rows are counted in the system context
(they are now global rows); the tenancy tests cover the new model.

### RPC role guards (fixed by 0007)

The Supabase functions checked roles with `if v_role not in (...) then raise`
(or `<> 'admin'`). When `app_role()` is NULL that condition is NULL, not
true, so an anonymous caller or a non-member passed the guard, and
`record_quick_payment` and `list_invoices_filtered` had no role check at all.
The baseline kept this on purpose (a faithful port). `0007_rpc_role_guards`
re-creates every RPC with `if v_role is null or v_role not in (...)` (or
`coalesce(public.app_role(), '') not in (...)`), gives the two billing RPCs
an admin/receptionist check, drops the unused legacy
`create_treatment_method` / `update_treatment_method`, and fails if a
security-definer function still has a NULL-unsafe guard. The test
`RPC role guards refuse a caller without a role (0007)` checks all 23 RPCs.

## Multi-clinic model (0002 + 0003)

The rules are in `docs/05-Backend-Schema.md` (conventions 3–12). In practice:

- **Request context.** The API runs each request in a transaction and sets,
  with `set_config(..., true)`: `app.user_id` (→ `auth.uid()`), `app.org_id`
  (→ `app_org_id()`, only after checking an active membership in an active
  clinic), `app.branch_id` (→ `app_branch_id()`), and `app.system = 'on'` for
  internal operations only (→ `app_is_system()`). Never let a request choose
  these values directly.
- **Platform tables** (`organizations`, `organization_members`,
  `member_branches`, `invitations`, `platform_admins`, `specialties`,
  `modules`, `specialty_modules`, `organization_modules`,
  `subscription_plans`, `subscriptions`, `reserved_slugs`) have no RLS; only
  dedicated API routes touch them.
- **Clinic tables** (the 25 others) have `organization_id NOT NULL DEFAULT
  app_org_id()` and ENABLE + FORCE RLS. On top of the 0001 role policies
  (which now see the role in the current clinic, `app_role()`), every clinic
  table has the RESTRICTIVE `tenant_isolation` policy and a permissive
  `system_access` policy for `app.system = 'on'`. `bookings`, `sessions`,
  `invoices`, `payments`, `payment_receipts`, `patient_schedules` and
  `treatments` also have `branch_id NOT NULL DEFAULT app_branch_id()` and the
  RESTRICTIVE `branch_scope` policy (`can_access_branch()`: the admin sees
  every branch, others their `member_branches`).
- **Global rows.** `organization_id IS NULL` in `treatment_templates`,
  `template_categories`, `treatment_methods` and `template_usage` = the
  platform's library (the 0001 seed): readable by every clinic, written only
  in the system context. `audit_events.organization_id IS NULL` = a platform
  event (system context only).
- **Audit integrity (0004).** Outside the system context a BEFORE INSERT
  trigger sets `audit_events.id` (shared sequence), `actor_uid` (`auth.uid()`),
  `actor_role` (`app_role()`) and `created_at` (`now()`), whatever the caller
  sent: members cannot forge the actor or back-date rows, and cannot occupy
  ids the sequence hands out to other clinics.
- **References stay in one clinic:** composite foreign keys
  `(organization_id, x) → parent (organization_id, key)`. The ones that replace
  `ON DELETE SET NULL` keys are `DEFERRABLE INITIALLY DEFERRED` (checked at
  commit) next to the original single-column key.
- **Inactive branches (0009).** A branch is deactivated, never deleted. A
  BEFORE INSERT / UPDATE OF branch_id trigger on the seven branch-scoped
  tables refuses a NEW row on an inactive branch with SQLSTATE `BR409`
  (message `branch_inactive`; the API answers 409 `branch_inactive`).
  Reading, updating (including an upsert of an existing key) and deleting the
  branch's rows still work, and the system context may still write there.
- **Invitation e-mails (0008).** `invitations.email_status` is `pending`
  (created / re-sent), `sent` or `failed`, with `email_status_at`; NULL for
  older rows. The API writes it.
- **Plan limits:** a new active branch, an activated membership or a new
  pending invitation beyond `subscription_plans.max_branches` / `max_users`
  raises SQLSTATE `PL422` with the message `plan_limit:branches` or
  `plan_limit:users` (the API maps it to HTTP 422). `NULL` = unlimited.
- **Existing data.** On a database that already holds single-clinic data (a
  Supabase import), 0003 creates the organization `clinic` (physio, active,
  plan `default`) and its branch `الفرع الرئيسي`, moves every row there,
  and turns `staff` rows linked to an account into `organization_members`
  (non-admins get the main branch). On a fresh database it only removes the
  default `clinic_settings` row: the API creates one per clinic.

## Development seed (`db/seed/dev.sql`)

**Never run it on production.** It refuses a database that already has
organizations.

```sh
export DATABASE_URL=$(scripts/dev-db.sh reset 55001)
node db/migrate.js
psql "$DATABASE_URL" -f db/seed/dev.sql    # or let the tests apply it
```

Every password is `Dev@12345`. Accounts: `super@clinicsys.test` (Super Admin,
no clinic) and, for `demo-physio` (physio) and `demo-dental` (dental),
`admin@`, `receptionist@`, `doctor@`, `therapist@` (branch 1 only, except the
admin) and `receptionist2@<slug>.test` (both branches). Each clinic has two
branches (`br-<slug>-1`, `br-<slug>-2`) and rows in every clinic table. To
change the seed, edit the file (the password hashes were generated with
bcryptjs, cost 10).

## What 0001_baseline.sql changed against `Supabase_All_In_One.sql`

The header of the file lists the changes, and every change site is marked
`[cPanel port]`. In short:

1. **Added** schema `auth` (compatibility layer): `auth.users`, `auth.uid()`
   (reads `app.user_id`, set by the API with `set_config(..., true)`) and
   `auth.password_reset_tokens`.
2. **Removed** all 30 `GRANT ... TO authenticated` statements. The policies
   have no `TO` clause, so they apply to `PUBLIC`.
3. **Removed** `storage.buckets` / `storage.objects` (the bucket and its 4
   policies). Files move to `FILES_DIR` behind `/api/files/*`.
4. **Removed** the seeds that created login accounts with hard-coded
   passwords: the main admin (section 14) and the clinic staff, plus their
   `staff`/`therapists` rows (section 15). They were the only users of
   pgcrypto and `auth.identities`, so `create extension pgcrypto` went too.
5. **Dropped** `notify pgrst` (there is no PostgREST).

Everything else is copied verbatim. A catalog comparison was run against the
original file applied to a mock Supabase database. Tables, columns,
constraints, indexes, function bodies, triggers, policies and the seeded
template/method/settings rows were identical. The only differences were the
pgcrypto functions, `schema_migrations`, and the 7 `staff` + 5 `therapists`
rows of the removed seeds.

RLS is **enabled, not forced**, as in Supabase. The API connects as the table
owner, so policies only apply to it once `0003_tenancy.sql` forces RLS. Note
for 0003: forcing RLS on `staff` while `app_role()` still reads `staff`
recurses (`stack depth limit exceeded`), because the staff policy calls
`app_role()`. `app_role()` must stop reading `staff` first.
