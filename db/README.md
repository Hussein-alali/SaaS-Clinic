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
│   └── 0001_baseline.sql    # Supabase_All_In_One.sql ported to plain PostgreSQL
└── test/
    └── baseline.test.js     # node:test + pg, against a real database
```

## Requirements

- Node.js 18 or 20 (the hosting.com range). Node 22 also works; see the test
  command below.
- PostgreSQL 13 or newer. The baseline has been applied and tested on 13.23
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

On hosting.com, run the same command from the cPanel Terminal (or SSH) in the
application directory, with the production `DATABASE_URL`. Take a backup with
`pg_dump` first (docs/02-TRD.md, "Rollback").

### Writing a migration

- Name it `NNNN_short_name.sql` with the next 4-digit number. The runner
  refuses other names and duplicate numbers.
- Do not write `BEGIN`/`COMMIT`/`ROLLBACK` in the file. The runner wraps it
  and refuses files that contain them.
- Never edit a file that has been applied to a shared database. Add a new one.
- PostgreSQL 13 syntax only: no `CREATE OR REPLACE TRIGGER`, `MERGE`,
  `NULLS NOT DISTINCT`, `security_invoker` views or jsonb subscripting. No
  extensions. No `CREATE ROLE`, `GRANT` to Supabase roles, or `ALTER SYSTEM`.
- Check it with `scripts/dev-db.sh reset`, then `node db/migrate.js` twice,
  then the tests.

## Tests

```sh
export DATABASE_URL=$(scripts/dev-db.sh reset 55001)
node --test db/test/                 # Node 18 / 20
node --test db/test/*.test.js        # Node 21+ (a directory argument is no longer expanded)
npm --prefix db test                 # any Node version
```

The tests run the real `node db/migrate.js` against `DATABASE_URL`. On a fresh
database it applies the migrations; on a migrated one it applies nothing. The
tests then check:

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
skip themselves; the tenancy and isolation tests cover that model.

### Known issue (todo test)

`RPC role guards refuse a caller without a role` is marked **todo**. The
Supabase functions check roles with `if v_role not in (...) then raise` (or
`<> 'admin'`). When `app_role()` is NULL that condition is NULL, not true, so
an anonymous caller, or a user without an active staff row, passes the guard.
For example, `create_treatment_template` succeeds anonymously.
`record_quick_payment` and `list_invoices_filtered` have no role check at all.
The baseline keeps this behaviour on purpose: it is a faithful port. A later
migration should change the guards to `if v_role is null or v_role not in
(...)`; the todo test then passes.

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
