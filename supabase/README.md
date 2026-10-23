# Supabase — schema & migrations

This folder holds the database schema as **versioned migrations** for the
Supabase CLI. The repo-root `Supabase_All_In_One.sql` carries the same content
(plus the seeds) as a single paste-friendly file for the Dashboard SQL editor —
the two are kept in sync.

```
supabase/
├── config.toml                              # CLI project config
├── seed.sql                                 # (admin bootstrap note)
└── migrations/
    ├── 20260101000000_baseline_schema.sql   # full schema (idempotent)
    ├── 20260712000000_payments_templates_patients_treatments.sql
    │                                        # catch-up: Quick Payment, payments
    │                                        # ledger, subscriptions, treatment
    │                                        # methods/templates, patient fields,
    │                                        # files, staff roles, treatments
    ├── 20260713000000_appointment_scheduling.sql
    │                                        # recurring patient schedules,
    │                                        # optional doctor / required
    │                                        # therapist, calendar indexes
    ├── 20260713010000_staff_roster_columns.sql
    │                                        # auth_uid/contact columns on
    │                                        # doctors + therapists, and the
    │                                        # receptionists table (PGRST204 fix)
    ├── 20260713020000_drop_modalities.sql   # drop removed `modalities` column
    ├── 20260713030000_calendar_hours.sql    # configurable calendar working
    │                                        # hours (calendar_start/_end)
    ├── 20260713040000_sessions_plan_link.sql
    │                                        # sessions ↔ treatment plans link,
    │                                        # completed-session counters,
    │                                        # packages column repair
    └── 20260713050000_session_status_drop_versions.sql
                                             # durable in-progress sessions
                                             # (status/started_at) + remove
                                             # template version history
```

Every statement is **idempotent** (`create ... if not exists`,
`alter ... add column if not exists`, `drop policy if exists` + `create policy`,
`create or replace function`, `insert ... on conflict`). So applying it to a
**fresh** project or an **existing** database is safe — existing objects are
left untouched and only what's missing is created.

## Applying it

### Option A — Supabase CLI (recommended)

```bash
# one-time
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>

# push all pending migrations to the linked project
supabase db push
```

Then provision the admin once (see `seed.sql`): run `seed-admin.sql` in the
Dashboard SQL editor.

### Option B — Dashboard (no CLI)

1. Open your project → **SQL Editor**.
2. Paste and run the root **`Supabase_All_In_One.sql`** — it contains the full
   schema, every migration, and the seeds in dependency order.

## Adding future changes

Create a **new** timestamped migration (never edit an applied one):

```bash
supabase migration new add_something   # creates supabase/migrations/<ts>_add_something.sql
# write your idempotent DDL, then:
supabase db push
```

Keep the root `Supabase_All_In_One.sql` in sync (it's the consolidated file
used by Dashboard users) by adding the same statements as a new numbered
section before the seed sections.

## What the baseline contains

Tables: `clinic_settings`, `custom_sections`, `patients` (+`therapist_id`),
`bookings` (+`doctor_id`, `department_id`), `sessions`, `invoices`, `staff`,
`therapists`, `departments`, `doctors`, `packages`, `campaigns`, `branches`,
`patient_files`, `audit_events` — plus the `app_role()` helper, row-level
security on every table, and the public **`patient-files`** Storage bucket with
its access policies.
