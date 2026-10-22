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
src/mailer.js          SMTP (nodemailer) or JSON files in .outbox/
src/static.js          dist/ with SPA fallback
src/routes/            auth, orgs, data, rpc, files, admin*, org*, invitations*, platform*
test/                  node:test against a real PostgreSQL (fixture: test/fixtures/schema.sql)
```

`*` = mounted but empty: plan task 2.7 fills them in (see "Writing routes").

## Environment variables

| Variable | Default (development) | Production |
|---|---|---|
| `NODE_ENV` | `development` | `production` (turns on the checks below) |
| `PORT` | `3000` | set by Passenger |
| `DATABASE_URL` | `postgres://clinic_owner:clinic_owner_dev@127.0.0.1:54329/clinicsys` | **required** |
| `JWT_SECRET` | a fixed dev value | **required**, ≥ 32 characters |
| `FILES_SIGNING_SECRET` | a fixed dev value | **required**, ≥ 32 characters, different from `JWT_SECRET` |
| `APP_BASE_DOMAIN` | `localhost` | `clinicsyseg.com` (`staging.clinicsyseg.com` on staging) |
| `COOKIE_DOMAIN` | empty (host-only cookie) | `.clinicsyseg.com` |
| `COOKIE_SECURE` | `false` | `true` (also sends HSTS) |
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
Secrets live only in the cPanel Node.js app environment — never in Git.

## Running locally

```bash
scripts/dev-db.sh start                 # prints DATABASE_URL (port 54329)
# apply the schema: node db/migrate.js + db/seed/dev.sql (plan tasks 2.2–2.4)
npm install && npm run build            # repository root → dist/
cd api && npm install && npm start      # http://localhost:3000
```

Open `http://demo-physio.localhost:3000` (browsers resolve `*.localhost` to
127.0.0.1), or `http://localhost:3000` with the `X-Org-Slug` header (the
frontend's `?org=<slug>`). `http://admin.localhost:3000` is the platform
(Super Admin) context. E-mails are written to `api/.outbox/*.json`.

## Tests

```bash
scripts/dev-db.sh start 55003           # the test database
cd api && npm test                      # = node --test test/
scripts/dev-db.sh stop 55003
```

The tests **drop and recreate the `auth` and `public` schemas** of
`API_TEST_DATABASE_URL` (default
`postgres://clinic_owner:clinic_owner_dev@127.0.0.1:55003/clinicsys`) and load
`test/fixtures/schema.sql`, a small database that follows the contract of the
real migrations (conventions 1–12 of the Schema doc). Test files take a
PostgreSQL advisory lock, so they can run in parallel processes.
`test/index.js` makes `node --test test/` work on Node ≥ 21 too, where a
directory argument is no longer expanded.

## API summary

All errors: `{"error": {"message", "code"}}`. Every non-GET `/api` request
needs the header `X-Requested-With: clinicsys` (403 `csrf_header_required`).

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
| `POST /api/rpc/:fn` `{args}` | whitelisted functions, named arguments |
| `POST /api/files/upload` (multipart `bucket`, `path`, `file`, `upsert`) | `{path, fullPath}`; 409 exists, 413 > 20 MB, 422 plan storage limit |
| `POST /api/files/sign` `{bucket, path, expiresIn}` | `{signedUrl: "/api/files/signed?token=…"}`; `expiresIn` is capped at 600 s |
| `GET /api/files/object/:bucket/*path` | session + clinic; `?org=<slug>` may name the clinic for `<img src>` in development |
| `GET /api/files/signed?token=` | no session; HMAC-SHA256 over `{org, bucket, path, exp}` |
| `POST /api/files/remove` `{bucket, paths}` | `{removed:[paths]}` |

Clinic context: the organization comes from the Host `<slug>.<APP_BASE_DOMAIN>`,
otherwise from `X-Org-Slug`; it is set only for an active member of an
active clinic (else 403: `org_required`, `not_a_member`, `org_inactive`).
The branch is `X-Branch-Id` when the member may use it (admin: any branch of
the clinic; other roles: `member_branches`), otherwise the oldest accessible
branch.

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
  `PL422` → 422, statement timeout → 503, connection/internal classes → 500,
  anything else → 400. `code` is the SQLSTATE.

### Files

`FILES_DIR/<organization_id>/<bucket>/<path>`; buckets: `patient-files`.
Paths are refused (400 `invalid_path`) when they contain `..`, start with `/`,
contain `\`, NUL/control characters, empty segments or a segment starting
with `.`. Roles follow the old Storage policies: read/upload — admin,
receptionist, doctor, therapist; replace (`upsert`) — admin, receptionist;
remove — admin and receptionist anything, others only what they uploaded
(owner kept in `FILES_DIR/<org>/.meta/<bucket>/<path>.json`). Only images,
PDF, plain text and MP4 render inline; everything else downloads as
`application/octet-stream` with a sandbox CSP.

## Writing routes (plan task 2.7)

`src/routes/{admin,org,invitations,platform}.js` export empty Express routers,
already mounted at `/api/admin`, `/api/org`, `/api/invitations`, `/api/platform`.

```js
const { requireOrg } = require('../tenant');           // session + active membership → req.ctx
const auth = require('../auth');                         // requireSession, requireSuperAdmin,
                                                         // validatePassword, hashPassword, issueSession, sha256
const { badRequest, forbidden, notFound, HttpError } = require('../errors');

router.post('/create-user', requireOrg(), async (req, res) => {
  if (req.ctx.role !== 'admin') throw forbidden();
  const { db, mailer, config } = req.app.locals;
  const row = await db.withContext(req.ctx, (client) => client.query('...'));         // RLS as the caller
  await db.withContext({ ...req.ctx, system: true }, (client) => client.query('...')); // internal operation
  res.json({ ok: true });
});
```

Handlers may be `async` and `throw`: the error handler answers
`{error:{message, code}}` (and maps PostgreSQL errors as above). Platform and
identity tables have no RLS: query them with `db.query` and check permissions
in the route. `req.app.locals.background(fn)` runs work after the response
(used for e-mails).

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
