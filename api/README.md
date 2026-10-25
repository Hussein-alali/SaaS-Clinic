# ClinicSystem EG — Node.js API

One Node.js application (Express 5) that serves `/api/*` **and** the built
frontend (`dist/`) for every domain: `clinicsyseg.com`, `<slug>.clinicsyseg.com`
and `admin.clinicsyseg.com`. It replaces Supabase (PostgREST, Auth, Storage,
Edge Functions) on hosting.com. The binding design is in
[`docs/02-TRD.md`](../docs/02-TRD.md) ("API contract") and
[`docs/05-Backend-Schema.md`](../docs/05-Backend-Schema.md).

- Node.js 18–20 (hosting.com's Setup Node.js App offers up to 20), CommonJS.
- PostgreSQL ≥ 13, no extensions. The app connects as the cPanel database
  user (owner, not superuser); every clinic table has `FORCE ROW LEVEL SECURITY`,
  and every query runs in a transaction that sets `app.user_id`, `app.org_id`,
  `app.branch_id` (and `app.system` for internal operations only).

## Layout

```
app.js                 entry point (cPanel startup file); exports the Express app
src/config.js          environment variables (below)
src/create-app.js      middleware order, route mounting, error handler
src/db.js              Pool (max 10) + withContext(ctx, fn)
src/auth.js            bcrypt, JWT cookie, session loading, rate limiter
src/tenant.js          clinic from Host / X-Org-Slug, membership, branch
src/catalog.js         table/column/function catalog for /api/data and /api/rpc
src/data-query.js      SQL builder for /api/data (identifiers validated, values bound)
src/rpc-whitelist.js   the functions the frontend may call
src/files.js           paths, signed links, safe download headers
src/mailer.js          SMTP (nodemailer) or JSON files in .outbox/; X-Lang, bilingual messages
src/static.js          dist/ with SPA fallback
src/audit.js           writeAudit(): audit_events rows in the same transaction
src/members.js         memberships, member_branches, staff rows, plan seats, newRecordId()
src/invites.js         invitation tokens (SHA-256), links, e-mails, resend/revoke
src/platform.js        slug rules, module dependencies, plans, organization detail
src/routes/            auth, orgs, data, rpc, files, admin, org, invitations, platform
scripts/create-super-admin.js   creates or promotes a Super Admin (platform_admins)
test/                  node:test against the real migrations + db/seed/dev.sql (+ test/fixtures/extras.sql)
```

## Environment variables

| Variable | Default (development) | Production |
|---|---|---|
| `NODE_ENV` | `development` | `production` (turns on the checks below) |
| `PORT` | `3000` | set by Passenger |
| `DATABASE_URL` | `postgres://clinic_owner:clinic_owner_dev@127.0.0.1:54329/clinicsys` | **required** |
| `JWT_SECRET` | a fixed dev value (only when `APP_BASE_DOMAIN` is local) | **required**, ≥ 32 characters |
| `FILES_SIGNING_SECRET` | a fixed dev value (only when `APP_BASE_DOMAIN` is local) | **required**, ≥ 32 characters, different from `JWT_SECRET` |
| `APP_BASE_DOMAIN` | `localhost` | `clinicsyseg.com` (`staging.clinicsyseg.com` on staging) |
| `COOKIE_DOMAIN` | empty (host-only cookie) | `.clinicsyseg.com` |
| `COOKIE_SECURE` | `false` | `true` by default (also sends HSTS); `false` turns it off |
| `TRUST_PROXY` | `loopback` | hops or addresses of the web server in front of Node (see deployment) |
| `FILES_DIR` | `api/uploads` | a folder **outside** `public_html`, e.g. `/home/<user>/clinicsys-files` |
| `DIST_DIR` | `../dist` (relative to `api/`) | where `dist/` was uploaded |
| `MAIL_TRANSPORT` | `file` | `smtp` |
| `MAIL_OUTBOX_DIR` | `api/.outbox` | — |
| `MAIL_FROM` | `ClinicSystem EG <no-reply@localhost>` | e.g. `ClinicSystem EG <no-reply@clinicsyseg.com>` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `localhost`, `587` | the cPanel e-mail account |
| `SMTP_SECURE` | `true` when `SMTP_PORT=465` | — |
| `DB_POOL_MAX` | `10` | keep ≤ 10 on shared hosting |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | — |

With `NODE_ENV=production` the API refuses to start (exit code 1) when
`DATABASE_URL`, `JWT_SECRET` or `FILES_SIGNING_SECRET` is missing or weak.
Outside production the built-in development secrets (public, in
`src/config.js`) are accepted only when `APP_BASE_DOMAIN` is a local name
(`localhost`, `*.localhost`, `*.test`, `127.x.x.x`); on any other domain
the API refuses to start until both secrets are set, so a server left in
cPanel "Development" mode cannot accept sessions anyone can sign.
Secrets live only in the cPanel Node.js app environment — never in Git.

## Running locally

```bash
export DATABASE_URL=$(scripts/dev-db.sh start)   # port 54329
npm --prefix db install && node db/migrate.js
psql "$DATABASE_URL" -f db/seed/dev.sql  # demo-physio / demo-dental, password Dev@12345
npm install && npm run build            # repository root → dist/
cd api && npm install && npm start      # http://localhost:3000
```

Then open `http://localhost:3000/?org=demo-physio` and sign in as
`admin@demo-physio.test` (or `receptionist@`, `doctor@`, `therapist@`,
`receptionist2@`) with `Dev@12345`; `super@clinicsys.test` is the Super Admin
(platform: `http://admin.localhost:3000`, or any host with `X-Platform: 1` in
development).

Open `http://demo-physio.localhost:3000` (browsers resolve `*.localhost` to
127.0.0.1), or `http://localhost:3000` with the `X-Org-Slug` header (the
frontend's `?org=<slug>`). `http://admin.localhost:3000` is the platform
(Super Admin) context. E-mails are written to `api/.outbox/*.json`.

## Tests

```bash
export API_TEST_DATABASE_URL=$(scripts/dev-db.sh reset 55003)   # a scratch database
npm --prefix db install                 # the tests run db/migrate.js
cd api && npm test                      # = node --test test/
scripts/dev-db.sh stop 55003
```

The tests run against the **real schema**: each test file **drops the `auth`
and `public` schemas** of `API_TEST_DATABASE_URL` (else `DATABASE_URL`, else
`postgres://clinic_owner:clinic_owner_dev@127.0.0.1:55003/clinicsys`), applies
`db/migrations/*.sql` with `db/migrate.js`, `db/seed/dev.sql` and
`test/fixtures/extras.sql` (accounts and clinics in states the dev seed does
not have: a `staff` role, a disabled membership, a disabled account, a member
of both clinics, suspended / closed / pending / draft clinics, a plan with a
1 MB storage limit, an account with a Supabase `$2a$` hash). When the file
ends, the database is left migrated + seeded (without the extras), the state
`db/test` expects; `API_TEST_KEEP_DB=1` skips that. Every password is
`Dev@12345`; ids and accounts are in `test/helpers.js` (`ORG`, `USER`,
`BRANCH`).

Safety: the harness refuses to wipe a database that has an account that is
not `*.test`, a clinic other than the test slugs (and the `apitest-*` clinics
the tests create through `/api/platform`), or (before 0003) any patient.

`journey.test.js` runs J1/J2 through the API only: the Super Admin creates a
clinic, the invitation e-mail lands in the outbox, the first admin accepts
(clinic active), adds a branch (the plan's branch limit → 422), invites a
receptionist for one branch (user limit → 422), and the receptionist reads
only that branch; suspension then ends both open sessions.
`create-super-admin.test.js` runs the script as a child process.
`security.test.js` holds the regression tests of the 22 Oct 2026 security
review: forged/id-squatting audit rows through `/api/data`, create-user on an
account that belongs to no clinic, an oversized e-mail (regex backtracking),
the production `Secure` cookie default and the refusal of the public
development secrets on a non-local `APP_BASE_DOMAIN`.
`frontend.test.js` loads `../src/apiclient.jsx` + `../src/supabase.jsx` (plain
JS, joined like the bundle) into a `node:vm` "browser" with a real `fetch` and
a cookie jar, signs in at `?org=demo-physio` and drives every Supabase call
chain of `src/supabase.jsx`, `src/screens1.jsx` and `src/import.jsx` through
the functions the screens call (as admin, receptionist, doctor, therapist, a
non-member and a deactivated member). `FRONTEND_COMPAT_REPORT=1` prints one
line per call with its requests and HTTP statuses.

`test/helpers.js` takes the advisory lock 2026102210 **exclusively** while a
file runs, and `db/test` takes it **shared**, so both suites can run in one
command against one database, in parallel processes:

```bash
node --test 'db/test/*.test.js' 'api/test/*.test.js'   # any Node version
node --test db/test/ api/test/                          # also works: see test/index.js
```

`test/index.js` makes `node --test test/` work on Node ≥ 21 too, where a
directory argument is no longer expanded. `rpc.test.js` adds a few
`apitest_*` functions to the database and to the whitelist (in-process only)
to cover result shapes no real RPC has (set of rows, set of scalars, void,
composite row, int8, overloads).

## API summary

All errors: `{"error": {"message", "code"}}`. Every non-GET `/api` request
needs the header `X-Requested-With: clinicsys` (403 `csrf_header_required`).
The browser client also sends `X-Lang: ar|en`, the interface language:
the e-mails a request sends (invitations, password reset) are bilingual,
Arabic and English in one message (subject `<Arabic> / <English> — ClinicSystem EG`,
text and HTML in two sections, HTML `dir`/`lang` per section), with the
requester's language first (Arabic when the header is missing or not `en`).
Error messages stay English; the frontend shows its own text per `code`.

| Route | Notes |
|---|---|
| `POST /api/auth/login` `{email, password, remember}` | `{user, is_super_admin, memberships}` + cookie `cs_session` (JWT `{sub, sv}`, 12 h or 30 days). One message for every failure (401 `invalid_credentials`). 10 failures per e-mail and per IP in 15 min → 429 with `Retry-After` |
| `POST /api/auth/logout` | 204, cookie cleared |
| `GET /api/auth/session` | same body as login, or 401 |
| `POST /api/auth/password` `{password}` | 204; `session_version + 1` (other sessions end) and the cookie is re-issued |
| `PATCH /api/auth/profile` `{name}` | `{user}` (name in `auth.users.raw_user_meta_data`) |
| `POST /api/auth/reset/request` `{email}` | 204 whether or not the account exists; e-mail with `https://<APP_BASE_DOMAIN>/?reset=<token>` (dev: `http://<base>:<PORT>`), token stored as SHA-256, 1 hour, single use |
| `POST /api/auth/reset/confirm` `{token, password}` | 204; ends every session |
| `GET /api/orgs/resolve?slug=` | public. Active or `pending_activation`: `{id, slug, name, status, specialty_code, modules, settings:{display_name, subtitle, logo, primary_color}}`; suspended: `{slug, status}`; closed/draft/unknown: 404 |
| `GET /api/orgs/current` | `{organization:{…as resolve}, role, branches:[branch rows], current_branch_id}` |
| `POST /api/data` | PostgREST replacement, `{data, count}`, ≤ 1000 rows per response |
| `POST /api/rpc/:fn` `{args}` | whitelisted functions, named arguments. Optional `Idempotency-Key` (8–100 of `[A-Za-z0-9_-]`, `src/idempotency.js`): claimed in the call's transaction, so a repeat answers the stored result with `Idempotency-Replayed: true`; another user's key → 409 `idempotency_conflict`; malformed → 400 `invalid_idempotency_key`; a failed call stores nothing |
| `POST /api/files/upload` (multipart `bucket`, `path`, `file`, `upsert`) | `{path, fullPath}`; 409 exists, 413 > 20 MB, 422 plan storage limit |
| `POST /api/files/sign` `{bucket, path, expiresIn}` | `{signedUrl: "/api/files/signed?token=…"}`; `expiresIn` is capped at 600 s |
| `GET /api/files/object/:bucket/*path` | session + clinic; `?org=<slug>` may name the clinic for `<img src>` in development |
| `GET /api/files/signed?token=` | no session; HMAC-SHA256 over `{org, bucket, path, exp}` |
| `POST /api/files/remove` `{bucket, paths}` | `{removed:[paths]}` |
| `POST /api/admin/create-user` `{email, password, name, role, phone[, branch_ids]}` | clinic admin. `{ok:true, uid, staff_id, linked}`; see "Clinic administration" |
| `POST /api/admin/reset-password` `{staff_id \| auth_uid, password}` | clinic admin. `{ok:true, staff_id}`; ends the account's sessions |
| `POST /api/admin/set-status` `{staff_id, active}` (or `status`) | clinic admin. `{ok:true, staff_id, status}` |
| `GET /api/org/invitations` | clinic admin. `[invitation]` (newest first; `status` pending/accepted/revoked/expired; `email_status` pending/sent/failed or null for older rows, `email_status_at`) |
| `POST /api/org/invitations` `{email, role, branch_ids}` | clinic admin. 201 `{invitation, email_sent}` (`email_sent` true/false, null while the SMTP server is still busy after 10 s; the outcome is stored as `email_status` even then); 409 `already_member` / `invitation_exists`; 422 `plan_limit:users` |
| `POST /api/org/invitations/:id/resend` | new token + 7 days, `email_status` back to `pending` until the e-mail is sent → `{invitation, email_sent}` |
| `DELETE /api/org/invitations/:id` | 204; status `revoked` (rows are kept) |
| `GET /api/invitations/:token` | public. `{organization:{name, slug}, email, role, status, expires_at, account_exists}`; 404 / 410 / 403 `org_inactive` |
| `POST /api/invitations/:token/accept` `{password, name}` | public. Login payload + `organization`, `role` + cookie |
| `/api/platform/*` | Super Admin only; see "Platform (Super Admin)" |

Clinic context: the organization comes from the Host `<slug>.<APP_BASE_DOMAIN>`,
otherwise from `X-Org-Slug`; it is set only for an active member of an
active clinic (else 403: `org_required`, `not_a_member`, `org_inactive`).
The branch is `X-Branch-Id` when the member may use it (admin: any branch of
the clinic; other roles: `member_branches`), otherwise the oldest active
accessible branch (or the oldest accessible one). An inactive branch asked for
in `X-Branch-Id` is kept: its rows can be read and updated, but a new row
there (`/api/data` insert, an RPC such as `record_quick_payment`) is refused
by the database with 409 `{code:'branch_inactive', message:'Branch is inactive'}`.

### `/api/data` request

```json
{ "table": "patients", "action": "select|insert|update|upsert|delete",
  "columns": "*", "filters": [{"column": "patient_id", "op": "eq", "value": "P-1"}],
  "order": [{"column": "created_at", "ascending": false, "nullsFirst": false}],
  "range": {"from": 0, "to": 999}, "count": "exact", "single": "single|maybeSingle",
  "values": {}, "onConflict": "patient_id", "returning": true,
  "head": false, "ignoreDuplicates": false }
```

- `table`: public tables with RLS **and** FORCE RLS, minus the platform and
  identity tables. Columns (in `columns`, filters, order, values, `onConflict`)
  must exist in `information_schema.columns`; the catalog is cached and
  re-read (at most every 5 s) when a name is missing.
- `columns`: `*` or `a,b,c` (plain identifiers only; no embeds, aliases or casts).
- `op`: `eq neq gt gte lt lte is in like ilike`; `is` takes `null|true|false`;
  `in` takes an array.
- `returning` defaults to `true`; send `false` for supabase-js "minimal" writes.
  `count` on a write is the number of affected rows. `head: true` returns only
  the count. `ignoreDuplicates: true` turns an upsert into `DO NOTHING`.
- `update` and `delete` need at least one filter. `upsert` without
  `onConflict` uses the primary key. Rows with different keys: a missing key is
  `DEFAULT`.
- `organization_id` in `values` must be the current clinic (403); it is
  normally omitted and filled by `DEFAULT app_org_id()`.
- json/jsonb values are sent as JSON text; numeric/int8 come back as numbers,
  `date` as `YYYY-MM-DD`, timestamps as ISO-8601 (`…T…+00:00`, session time zone UTC).
- PostgreSQL errors: `23505` → 409, `42501`/row-level security → 403,
  `PL422` → 422, `BR409` (new row on an inactive branch) → 409
  `branch_inactive`, `BK409` (another active booking holds the therapist's or
  doctor's slot, 0010) → 409 `slot_taken`, statement timeout → 503,
  connection/internal classes → 500, anything else → 400. `code` is the
  SQLSTATE (`branch_inactive` for BR409, `slot_taken` for BK409).

### Files

`FILES_DIR/<organization_id>/<bucket>/<path>`; buckets: `patient-files`.
Paths are refused (400 `invalid_path`) when they contain `..`, start with `/`,
contain `\`, NUL/control characters, empty segments or a segment starting
with `.`. Roles follow the old Storage policies: read/upload — admin,
receptionist, doctor, therapist; replace (`upsert`) — admin, receptionist;
remove — admin and receptionist anything, others only what they uploaded
(owner kept in `FILES_DIR/<org>/.meta/<bucket>/<path>.json`). Only images,
PDF, plain text and MP4 render inline; everything else downloads as
`application/octet-stream` with a sandbox CSP. Every files route (upload,
sign, object, signed link, remove) answers 403 `module_disabled` while the
bucket's module (`patient-files` → `core.files`) is off for the clinic; the
files are kept.

## Clinic administration (`/api/admin/*`, `/api/org/*`)

The caller is an **active admin of the current clinic** (Host / `X-Org-Slug`).
`/api/admin/*` keeps the Edge Function bodies (`admin-create-user`,
`admin-reset-password`, `admin-set-status`): every error is
`{ok:false, error, detail}` with the HTTP status (401 → `missing_token` /
`invalid_token`, 403 `forbidden` for other roles, 422 `plan_limit_users`).

- **create-user**: Edge validation order (`invalid_email`, `weak_password`,
  `invalid_role` — admin, receptionist, doctor, therapist; default
  receptionist — `missing_name`). A new e-mail gets an account; an account
  that belongs to this clinic only (a former member) is re-linked and its
  password set; an active member, an account of another clinic or a Super
  Admin → 409 `email_exists` (they join by invitation). Then: active
  membership, `member_branches` (`branch_ids`, default the caller's current
  branch; none for admin), the staff row (created or linked by `auth_uid` /
  e-mail, same role), pending invitations of the e-mail revoked. Seats =
  active members + pending invitations (422 when full).
- **reset-password**: the staff row is looked up with the caller's RLS; the
  account must be a member of THIS clinic (`staff.auth_uid` alone is
  admin-editable and never trusted → `no_auth_account`) and of no other
  clinic and not a Super Admin (403 `shared_account`). `session_version + 1`;
  the caller keeps their own session (cookie re-issued).
- **set-status**: inactive → `staff.status = 'inactive'`, membership
  `disabled`, `session_version + 1` (open sessions end). `auth.users.status`
  is **not** changed: the account may belong to other clinics, and accounts
  are not the clinic admin's to lock (docs/05: memberships are disabled, not
  accounts). Active → membership `active` (seat checked). An admin cannot
  deactivate themselves.
- **Invitations**: token = 32 random bytes (base64url), only its SHA-256 in
  `invitations.token_hash`, 7 days. Link
  `<https|http>://<slug>.<APP_BASE_DOMAIN>[:PORT]/?invite=<token>`, plus
  `&org=<slug>` outside production. Non-admin roles need ≥ 1 active branch.
  A pending invitation holds a seat (trigger → 422); an expired one is shown
  as `expired`, and re-sending it takes a seat again. The e-mail is sent
  after the commit; `email_sent` is `false` on failure and `null` when SMTP
  takes more than 10 s (the invitation stays valid either way). It is
  bilingual, the inviting (or re-sending) person's `X-Lang` first, with the
  role named in both languages (e.g. «موظف استقبال» / Receptionist).
- **Accept** (`/api/invitations/:token/accept`): one transaction (system
  context). A new e-mail needs `password` (6–72 bytes) and `name`; an
  existing account must give **its own** password (never overwritten;
  failures count in the login rate limit, 429). Membership `active` with the
  invitation's role and still-existing branches, staff row created/linked
  (role `staff` → `staff.role` NULL: 0001's CHECK has no `staff`), invitation
  `accepted`, and the first admin moves a `pending_activation` clinic to
  `active`. 410 `invitation_used` / `invitation_expired` /
  `invitation_revoked`; 403 `org_inactive`, `account_disabled`.

Every action writes `audit_events` in its transaction: `staff.create`,
`staff.password_reset`, `staff.activate`, `staff.deactivate`,
`invitation.create|resend|revoke|accept`, `user.create`,
`organization.activate`.

### Members and plan usage (clinic admin)

| Route | Notes |
|---|---|
| `GET /api/org/members` | Members of the current clinic, active first: `{id, user_id, email, name, role, status, branch_ids, joined_at, created_at, staff_id, staff_status, phone, is_self}`. Admin only (403 `forbidden`). |
| `PATCH /api/org/members/:id` `{role?, branch_ids?}` | Non-admin roles need at least one active branch (`branch_required`, `invalid_branch`, `invalid_branch_ids`). `cannot_change_own_role`, 404 `member_not_found`. A role outside the clinic roles is 400 `invalid_role` and is audited as a denied `member.update`. A role change ends the member's open sessions. |
| `GET /api/org/usage` | The clinic's plan and limits plus usage (active branches; active members + pending unexpired invitations) for the screen counters. |

Since migration 0006 a `staff` membership's staff row has `role = 'staff'`. Since 0005 branches cannot be deleted by members (RLS); deactivate them with `status = 'inactive'`.

### Disabled modules

`/api/data` and `/api/rpc` answer **403 `module_disabled`** for the tables and functions of a module the clinic has not enabled (or that is planned); the rows are kept. The mapping lives in `src/modules.js` (tests: `test/modules.test.js`): `core.patients` → patients; `core.appointments` → bookings, patient_schedules; `core.files` → patient_files; `core.billing` → invoices, payments, payment_receipts, packages, patient_subscriptions + record_quick_payment, list_invoices_filtered, delete_payment_receipt; `physio.sessions` → sessions; `physio.treatment_plans` → treatments and its RPCs; `physio.templates` → template tables and RPCs. `/api/files` is not gated yet.

## Platform (Super Admin, `/api/platform/*`)

Needs a session, a `platform_admins` row (403 `not_super_admin`) and the
platform context: Host `admin.<APP_BASE_DOMAIN>`, or `X-Platform: 1` when
`NODE_ENV` is not `production` (403 `platform_required`).

| Route | Notes |
|---|---|
| `GET /stats` | `{organizations:{draft, pending_activation, active, suspended, closed, total}, pending_invitations, retention_overdue}` |
| `GET /organizations?q=&status=&specialty=&limit=&offset=` | `{data, count}`, newest first |
| `POST /organizations` `{name, slug, specialty_code, modules, plan_id, admin_email}` | 201 detail + `invitation`, `email_sent`. ONE transaction: organization `pending_activation`, branch «الفرع الرئيسي» (`br_…`), `clinic_settings`, `organization_modules` (`modules` or the specialty's active defaults; dependencies checked), subscription, first-admin invitation. No `plan_id` → plan `default` |
| `GET /organizations/:id` | `{organization, modules, branches, members, invitations, subscription, usage}` (no patient data) |
| `PATCH /organizations/:id` `{name, specialty_code, plan_id}` | detail |
| `POST /organizations/:id/status` `{status, reason}` | `draft→pending_activation→active⇄suspended→closed` (409 `invalid_transition`); `reason` required for suspended/closed; suspend sets `suspended_at`, `retention_until = now() + 6 months`; reactivation clears both |
| `PUT /organizations/:id/modules` `{codes}` | the enabled set; `depends_on` must be in it (400 `module_dependency`); only catalog-`active` modules; plan `included_modules` (core.* always allowed, else 422 `plan_limit_modules`); other rows kept disabled |
| `PUT /organizations/:id/subscription` `{plan_id, status, period_start, period_end, notes}` | new `subscriptions` row (history kept) + `organizations.plan_id` |
| `GET/POST /organizations/:id/invitations`, `POST …/invitations/:invId/resend`, `DELETE …/invitations/:invId` | as `/api/org/invitations`, for any clinic in `pending_activation` or `active` |
| `GET /slug-available?slug=` | `{available, reason}`; reason `invalid_format` (`^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`), `reserved` (`reserved_slugs`), `taken` |
| `GET /specialties`, `GET /modules` | catalogs (specialties with `default_modules`) |
| `GET /plans`, `POST /plans`, `PATCH /plans/:id` | `{code, name, max_users, max_branches, max_storage_mb, included_modules, status}`; `null` = unlimited |
| `GET /audit?organization_id=&actor=<uuid or e-mail>&action=<name or prefix*>&from=&to=&limit=&offset=` | `{data, count}`, newest first; `payload` only for the API's own platform/membership rows (clinic RPC rows may hold patient data) |

Every write is audited with `actor_role = 'super_admin'`.

### Super Admin accounts

```bash
DATABASE_URL=... node api/scripts/create-super-admin.js --email owner@example.com --password '…' [--name 'Owner']
printf '%s' "$PASS" | DATABASE_URL=... node api/scripts/create-super-admin.js --email owner@example.com --password-stdin
```

Creates the account (or promotes an existing one: re-activated, password
replaced only when given, which ends its sessions) and adds the
`platform_admins` row; audited as `platform_admin.create|grant`. Exit code 1
on any error.

## Writing routes

```js
const { requireOrg } = require('../tenant');           // session + active membership → req.ctx
const auth = require('../auth');                         // requireSession, requireSuperAdmin,
                                                         // validatePassword, hashPassword, issueSession, sha256
const { writeAudit } = require('../audit');
const { badRequest, forbidden, notFound, HttpError } = require('../errors');

router.post('/example', requireOrg(), async (req, res) => {
  if (req.ctx.role !== 'admin') throw forbidden();
  const { db } = req.app.locals;
  await db.withContext(req.ctx, async (client) => {          // RLS as the caller
    await client.query('...');
    await writeAudit(client, { orgId: req.ctx.orgId, actorUid: req.ctx.userId, actorRole: 'admin',
                               action: 'thing.change', tableName: 'things', rowPk: '…' });
  });
  // db.withContext({ ...req.ctx, system: true }, fn) — internal operation (app.system = 'on')
  res.json({ ok: true });
});
```

Handlers may be `async` and `throw`: the error handler answers
`{error:{message, code}}` (and maps PostgreSQL errors as above). Platform and
identity tables have no RLS: query them with `db.query` and check permissions
in the route. `req.app.locals.background(fn)` runs work after the response.

## Deploying on hosting.com (cPanel → Setup Node.js App)

1. Upload the repository's `api/` folder (without `node_modules`, `.outbox`,
   `uploads`) to e.g. `/home/<user>/clinicsys/api`, and the built `dist/` next to
   it (`/home/<user>/clinicsys/dist`). Neither goes under `public_html`.
2. cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: the highest offered (18–20);
   - Application mode: `Production`;
   - Application root: `clinicsys/api`;
   - Application URL: `clinicsyseg.com` (repeat the domain mapping for the
     wildcard `*.clinicsyseg.com` and `admin.clinicsyseg.com` so every host
     reaches this one app);
   - Application startup file: `app.js`.
3. Add the environment variables (table above) in the same screen:
   `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `FILES_SIGNING_SECRET`
   (generate each with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`),
   `APP_BASE_DOMAIN=clinicsyseg.com`, `COOKIE_DOMAIN=.clinicsyseg.com`,
   `COOKIE_SECURE=true`, `FILES_DIR=/home/<user>/clinicsys-files`,
   `DIST_DIR=/home/<user>/clinicsys/dist`, `MAIL_TRANSPORT=smtp`, `SMTP_*`, `MAIL_FROM`.
4. **Run NPM Install** (installs from `package.json` / `package-lock.json`).
5. **Restart** the application. Check `https://clinicsyseg.com/api/orgs/resolve?slug=<slug>`
   and the app's log (stderr) for `Invalid API configuration`.
6. Client IP for the login rate limit: open the app with a wrong password from
   two different networks and confirm both are not blocked together. If the web
   server in front of Node connects over TCP from another address, set
   `TRUST_PROXY` to it (or to `1` for one proxy hop). When the client address
   cannot be determined the API applies only the per-e-mail limit.
7. After every code or environment change: **Restart** (and **Run NPM Install**
   when `package.json` changed).
