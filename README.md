# Physical Therapy Clinic Management System

An Arabic-first (RTL), single-branch clinic management system for physical
therapy practices. It digitises the full front-desk and clinical workflow —
patients, appointments, treatment plans, concurrent therapy sessions,
billing, and reports — into one role-scoped web application backed by
[Supabase](https://supabase.com).

## Features

- **Role-based access (RBAC)** — tailored views for **admin**,
  **receptionist**, **doctor**, and **therapist**, enforced end-to-end by
  Postgres Row Level Security (every policy reads the role from the `staff`
  table via `app_role()`).
- **Patient management** — full patient records, file uploads, bulk import
  of historical paper records (`?import=1`), and "incomplete profile"
  flagging for quick phone/WhatsApp bookings.
- **Appointments & calendar** — department/doctor-driven booking, quick
  booking (حجز سريع), recurring patient schedules, and configurable
  calendar working hours.
- **Treatment plans & templates** — a library of 49 ready-made,
  diagnosis-specific physiotherapy templates (spine and shoulder
  categories) with goals, exercises, manual-therapy methods, precautions,
  and session parameters.
- **Concurrent treatment sessions** — therapists can run multiple patient
  sessions in parallel without losing timers or notes.
- **Billing & payments** — invoices, quick payments, a payments ledger, and
  treatment packages/subscriptions.
- **WhatsApp appointment reminders** — one-click, DB-driven reminder
  messages.
- **Reports & analytics** — financial and operational dashboards for
  managers.
- **Staff management** — admin creation of user accounts, password resets,
  and activation/deactivation via Supabase Edge Functions (with full audit
  logging to `audit_events`).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 via **Babel Standalone** (CDN, no build step), RTL layout |
| Backend | **Supabase** — Postgres, Auth, Storage, auto-generated REST, RLS |
| Server logic | Supabase **Edge Functions** (Deno) for privileged admin actions |
| Hosting | Any Node host (Railway, Vercel, …) — `server.js` is a zero-dependency static server |

There is no bundler and nothing to install: the browser compiles
`src/*.jsx` on the fly, and `@supabase/supabase-js` loads from a CDN.

## Getting Started

### 1. Set up Supabase (once)

Open your Supabase project → **SQL Editor**, paste the entire contents of
[`Supabase_All_In_One.sql`](Supabase_All_In_One.sql), and run it. It
contains the full schema, all migrations, RLS policies, the storage
bucket, and the admin seed, and is safe to re-run.

It seeds an initial admin account (see [`DEPLOY.md`](DEPLOY.md)) — change
its password after first login.

Optionally run
[`seed-treatment-templates.sql`](seed-treatment-templates.sql) afterwards
to load the treatment-plan template library.

Set your project's URL and anon key in [`src/supabase.jsx`](src/supabase.jsx)
(or define `window.SUPABASE_URL` / `window.SUPABASE_ANON_KEY` in
`index.html` before the script tags).

### 2. Run locally

```bash
npm start        # serves the app on http://localhost:3000
```

Requires Node ≥ 18. No `npm install` needed.

### 3. Modes

| Mode | URL | Description |
|------|-----|-------------|
| Production | `/` | Loads everything from Supabase; log in with a staff account |
| Demo | `/?demo=1` | Offline demo with sample data and a role picker — nothing touches Supabase |
| Bulk import | `/?import=1` | Data-entry page for historical patient records (any authenticated staff) |

## Project Structure

```
├── index.html                  # App shell — loads React, Babel, and src/*.jsx
├── server.js                   # Zero-dependency static file server
├── src/
│   ├── core.jsx                # App bootstrap and shared state
│   ├── ui.jsx                  # Shared UI components
│   ├── roles.jsx               # RBAC / role-scoped navigation
│   ├── screens1.jsx            # Screens (patients, appointments, …)
│   ├── screens2.jsx            # Screens (billing, reports, settings, …)
│   ├── multisession.jsx        # Concurrent treatment-session runner
│   ├── import.jsx              # Bulk historical-patient import page
│   └── supabase.jsx            # Supabase client, data layer, config
├── supabase/
│   ├── migrations/             # Versioned schema migrations (Supabase CLI)
│   └── functions/              # Edge Functions: admin-create-user,
│                               # admin-reset-password, admin-set-status
├── Supabase_All_In_One.sql     # Consolidated schema + seeds (SQL-editor friendly)
├── seed-admin.sql              # Admin account seed
├── seed-staff.sql              # Sample staff seed
├── seed-treatment-templates.sql# 49 physiotherapy plan templates
├── scripts/                    # Generator for the templates seed
├── DEPLOY.md                   # Full deployment guide
└── PRD.md                      # Product requirements document
```

## Deployment

See [`DEPLOY.md`](DEPLOY.md) for the full guide, including:

- Deploying to Railway (or any Node host) with `npm start`.
- Deploying the three admin Edge Functions (`admin-create-user`,
  `admin-reset-password`, `admin-set-status`) via the Dashboard or
  `./deploy-edge-function.sh` — recommended for unlimited, instant staff
  account creation with the service-role key kept server-side.
- Adding staff accounts and booking data (departments & doctors).

## Documentation

- [`PRD.md`](PRD.md) — full product requirements: roles, feature modules,
  database schema, API surface, and design system.
- [`supabase/README.md`](supabase/README.md) — how the versioned migrations
  relate to `Supabase_All_In_One.sql`.

## License

ISC
