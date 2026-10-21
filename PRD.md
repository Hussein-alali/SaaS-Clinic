# Product Requirements Document
## كينيتك (Kinetic) — Physical Therapy Clinic Management System

**Version:** 2.0
**Date:** July 2026
**Status:** Draft (Merged Spec — MVP / Graduation Project)

---

## 1. Overview

Kinetic is an Arabic-first, single-branch clinic management system for physical therapy practices. It combines a public marketing website, a role-scoped internal application (admin, receptionist, doctor, therapist), and a patient portal, backed by a REST API and Supabase database.

The web app frontend runs on React 18 (Babel Standalone CDN, no build step, RTL layout). The backend is **Supabase** — a managed PostgreSQL database with built-in Auth, Storage, and auto-generated REST/Realtime APIs — accessed directly from the client via the `@supabase/supabase-js` SDK loaded from a CDN. Media files (clinic logo, patient uploads) live in Supabase Storage or Cloudinary. The frontend is deployed on Vercel.

### 1.1 Problem Statement

Physical therapy clinics in Egypt rely on fragmented tools — paper appointment books, spreadsheets for billing, WhatsApp messages sent manually — causing missed appointments, incomplete treatment records, billing gaps, and no aggregate view of clinical or financial performance.

### 1.2 Goals

- Digitise every front-desk and clinical workflow into one cohesive web system.
- Give every role a tailored, role-scoped view enforced by RBAC.
- Enable therapists to run concurrent patient sessions without losing any timer or note.
- Provide patients a self-service portal for booking, treatment tracking, and payment.
- Surface real-time financial and operational analytics for branch managers.
- Ship a production-grade backend (JWT auth, REST API, secure headers, rate limiting) suitable for a graduation project MVP.

### 1.3 Non-Goals (v1)

- Multi-branch support (single branch only).
- Native mobile app (responsive web only; PWA later).
- Insurance / takaful claims processing.
- EHR/EMR integration with external hospital systems.

---

## 2. System Architecture

```
                ┌────────────────────────────────────────────┐
                │              Public Website                │
                │  (Home / About / Services / Booking / …)   │
                └──────────────────┬─────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐        ┌────────▼─────────┐       ┌────────▼────────┐
│ Patient Portal │        │ Staff Application│       │  Admin Console  │
│  (JWT-guarded) │        │  (JWT + RBAC)    │       │  (JWT + RBAC)   │
└───────┬────────┘        └────────┬─────────┘       └────────┬────────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   Supabase (managed)        │
                    │  Auth · Postgres · Storage  │
                    │  Auto REST · Realtime · RLS │
                    │  Edge Functions (Deno)      │
                    └──────────────┬──────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐        ┌────────▼─────────┐       ┌────────▼────────┐
│  PostgreSQL    │        │ Supabase Storage │       │  WhatsApp / SMS │
│ (RLS enforced) │        │   / Cloudinary   │       │   (Twilio etc.) │
└────────────────┘        └──────────────────┘       └─────────────────┘
```

**Deployment:**

| Tier | Host | Notes |
|------|------|-------|
| Frontend (public + app) | **Vercel** | Static build, edge cache |
| Backend | **Supabase** | Managed PostgreSQL + Auth + Storage + auto REST/Realtime; accessed from client via `@supabase/supabase-js` |
| Custom server logic (optional) | **Supabase Edge Functions** | Deno runtime for webhooks, scheduled jobs, and privileged mutations |
| Media / uploads | **Supabase Storage** or **Cloudinary** | Signed uploads |
| WhatsApp / SMS | WhatsApp Business API or **Twilio** | Configurable channel |

---

## 3. Public Website

Accessible without login. Anonymous marketing and lead-capture surface.

| Page | Purpose |
|------|---------|
| **Home** | Hero, value proposition, CTA to book |
| **About Clinic** | Story, mission, branch info, opening hours |
| **Services** | List of treatment modalities and packages |
| **Therapists** | Staff bios, specialities, photos |
| **Contact** | Phone, WhatsApp, address, embedded map |
| **Online Booking** | Public booking flow (no login required) |
| **FAQ** | Common questions grouped by category |

Language: Arabic (RTL) with optional English toggle.

---

## 4. Users, Roles & Access Control

### 4.1 Roles

| Role | Arabic | Scope | Default Landing |
|------|--------|-------|----------------|
| Admin / Branch Manager | مدير | Full access — all patients, all data, all reports | Admin Dashboard |
| Receptionist | موظف استقبال | Appointments, patient registration, payments | Reception Dashboard |
| Doctor | طبيب | Own patients and appointments; treatment plans; reports | Clinical Daily View |
| Physical Therapist | الأخصائي | Own schedule, sessions for own patients | Daily Schedule |
| Patient | (portal) | Own appointments, plan progress, bills, messages | Patient Home |

Data scoping is enforced server-side: doctors and therapists only see records where `dr` / `th` matches their profile.

### 4.2 Authentication

- **JWT-based authentication.** Access token issued on login; refresh token stored HTTP-only.
- **Password hashing** with bcrypt (cost factor ≥ 10).
- **Protected APIs.** All non-public endpoints require `Authorization: Bearer <token>`.
- **Role-Based Access Control (RBAC).** Middleware checks role against route allowlist.
- **Session persistence** in `localStorage` on the client for route restoration.

### 4.3 Login Flow

1. User submits credentials via `supabase.auth.signInWithPassword({ email, password })`.
2. Supabase Auth verifies against the managed `auth.users` table; the linked `staff` (or `patients`) row supplies the app-level role.
3. On success, Supabase returns an access JWT (with `role` claim) + refresh token; the SDK persists them and auto-refreshes.
4. Frontend reads the session; RBAC guard maps the JWT role to the allowed routes.
5. `supabase.auth.signOut()` clears the session locally and revokes the refresh token server-side.

---

## 5. Feature Modules

### 5.1 Role-Specific Dashboards

**Admin Dashboard**
- **KPIs:** patients today, sessions today, revenue today, monthly revenue.
- **Charts:** daily patients, revenue trend, most common diagnoses, appointment status breakdown.
- **Management shortcuts:** patients, staff (therapists / doctors / receptionists), packages, rooms, working hours.
- Sparkline per KPI for trend context.
- Export KPIs to CSV / Excel / PDF / Print.

**Reception Dashboard**
- **Appointments:** create booking, edit booking, cancel booking, check in patient.
- **Patients:** register patient, search patient, view history.
- **Payments:** create invoice, receive payment, print receipt.
- Today's appointment queue with status.
- Overdue payments panel.

**Doctor Dashboard**
- **Patients:** view assigned patients, create diagnosis, medical history, treatment plan.
- **Reports:** clinical notes, progress report.
- Own appointments for the day.
- Patients needing attention (pain regression, missed sessions).

**Physical Therapist Dashboard**
- Today's schedule.
- Concurrent sessions panel.
- Session timer.
- Pain scale.
- Treatment checklist.
- Voice notes.
- Progress tracking.
- Session history.

### 5.2 Patient Management

**Patient Record**
- Personal information (name, phone, age, gender, DOB, job, address, national ID, emergency contact).
- Medical information (diagnosis, chief complaint, chronic conditions, prior surgeries).
- Treatment plans (linked plans with progress).
- Session history (chronological log).
- Invoices (linked invoices).
- Uploaded files (referrals, imaging, consent).
- WhatsApp history (messages sent / received).

**Patient List**
- Sortable/searchable table: ID, name, phone, diagnosis, doctor, therapist, package, remaining sessions, last visit, payment status.
- Quick WhatsApp and call buttons per row.
- Role-scoped: doctors see only their patients, therapists see only theirs.
- CSV / Excel / PDF export.

**Patient Detail (tabbed)**
- Overview / History / Treatment Plan / Files / Invoices / WhatsApp History.

**Add Patient (multi-step form)**
1. Personal info (name, phone, DOB, gender, job, address, national ID).
2. Medical info (diagnosis with voice-to-text, chief complaint, chronic conditions, surgeries).
3. File uploads (referral, imaging, consent).
4. Review & confirm.

### 5.3 Appointment System

**Booking Flow (5 steps)**

| Step | Action |
|------|--------|
| 1 | **Patient information** — الاسم · رقم الهاتف · العمر · الجنس · نوع الحالة · ملاحظات |
| 2 | **Choose therapist** (speciality, load vs. capacity) |
| 3 | **Choose date** (mini-calendar) |
| 4 | **Choose available time** (slot grid) |
| 5 | **Confirmation** (summary + WhatsApp confirmation) |

**Business Rules**
- No duplicate booking for the same patient at the same time.
- Working hours validation (08:00–19:00 configurable).
- Therapist availability check (not already booked, within max daily load).
- Maximum daily capacity per therapist and per room.
- Automatic booking ID generation.

**Calendar View**
- Week view with time-column grid (08:00–19:00, 30-min slots).
- Colour-coded by status: completed (green), in-session (violet), confirmed (blue), pending (amber), cancelled/no-show (red), available (grey).
- Therapist filter chips.
- Day navigation.
- Click slot → reschedule modal.

**Appointment List**
- Table with status badges. Inline reschedule and cancel.

**Reschedule Modal**
- Date + slot picker, reason dropdown, optional WhatsApp notification.

### 5.4 Treatment Plans

Each plan contains:
- Diagnosis
- Goals
- Exercises
- Modalities
- Expected sessions
- Completed sessions
- Progress percentage

**Plan List**
- Table with plan ID, patient, diagnosis, therapist, progress bar, session count, status.
- KPIs: active plans, goals achieved %, average sessions to goal.
- Template library modal.

**Create / Edit Plan**
- Patient + therapist selector.
- Diagnosis text field.
- Goals textarea (one per line).
- Treatment modalities multi-select (manual therapy, strength training, stretching, heat, electro, ultrasound, hydrotherapy, cupping, dry needling).
- Notes.
- Schedule: total sessions, frequency, start date → auto end date.
- AI suggestion panel: average session count for similar diagnoses.
- Save as draft or publish.

### 5.5 Treatment Sessions (Concurrent)

**Core capability:** a therapist manages multiple patients simultaneously. Every active session runs its own independent live timer — switching between patient cards never pauses any timer.

**Every session contains**

| Field | Description |
|-------|-------------|
| Session ID | Auto-generated |
| Patient | Linked patient record |
| Therapist | Assigned therapist |
| Date | ISO date |
| Duration | Elapsed seconds |
| Pain Score | 0–10 scale |
| Mood | worse / same / better |
| Exercises | Checklist of exercises performed |
| Modalities | Checklist of modalities applied |
| Session Notes | Text (voice-to-text supported) |
| Voice Notes | Web Speech API transcript |
| Attachments | Cloudinary URLs |
| Goals Completed | Array of goal IDs |

**Concurrent Sessions Panel**
- Active session rail: patient avatar, name, room, type, live elapsed timer, pain score badge.
- Pause / resume per session without affecting others.
- End session.
- Add session button opens patient picker.
- One shared heartbeat drives all timers.

**Session Detail Card**
- Header, live timer, pain scale, mood selector, treatment checklist, notes, goals, WhatsApp + call, sign-off.

**Session History List**
- Table with date, session #, pain, mood, notes excerpt.
- Timeline view.

### 5.6 Billing

**Data**
- Invoices
- Payments
- Receipts
- Outstanding balance

**Payment Methods**
- Cash · Visa · MasterCard · InstaPay · Vodafone Cash · Bank Transfer

**Main Payments Screen (tabbed)**

*Invoices tab*
- KPI cards: collected this month, outstanding, overdue (>14 days), average invoice.
- Filter bar: search, status chips, payment method dropdown.
- Table: invoice ID, patient, date, amount, paid, method, status, actions.
- New invoice button.
- Export to CSV / Excel / PDF.

*Payment Methods tab*
- Distribution chart, per-method totals.

*Receipts tab*
- Receipt list, invoice modal with print + WhatsApp actions.

### 5.7 Treatment Packages

**Package Grid**
- Card per package with gradient header, name, price, session count, features, monthly sales, active/inactive toggle.
- Edit modal: name, sessions, price, colour, validity days.

**Packages (seed)**

| Package | Sessions | Price (EGP) |
|---------|----------|-------------|
| Single Session | 1 | 850 |
| Starter — 6 | 6 | 4,650 |
| Core — 10 *(most popular)* | 10 | 7,250 |
| Recovery — 15 | 15 | 10,100 |
| Post-Op — 24 | 24 | 15,400 |
| Classic — 30 *(inactive)* | 30 | 18,500 |

### 5.8 Notifications

**Notification Types**
- Booking confirmation
- Appointment reminder
- Follow-up reminder
- Payment reminder

**Delivery Channels**
- WhatsApp Business API (primary)
- Twilio WhatsApp (fallback)
- SMS
- Email

Channel selection is configurable per notification type in Settings. Users can opt in/out per channel in their profile.

### 5.9 Reports & Analytics

**Financial Report**
- Revenue trend (daily), revenue by package / therapist / modality.
- Outstanding and overdue summary.

**Medical Report**
- Diagnoses distribution, avg sessions to goal by diagnosis, therapist workload, treatment outcome rates.

**Operational Report**
- Appointment fill rate, no-show rate, room utilisation, peak hours heatmap.

**Analytics KPIs**
- Daily patients
- Weekly patients
- Monthly revenue
- Appointment rate
- Cancellation rate
- No-show rate
- Most common diagnoses
- Average sessions per patient
- Therapist workload
- Revenue by therapist
- Revenue by package

All reports share a date-range selector (last 30 days / this month / this quarter / YTD).

### 5.10 Search

Global search available across the application. Supported search axes:
- Patient name
- Phone number
- Diagnosis
- Therapist
- Booking date
- Invoice number

### 5.11 Export

All list and report views support:
- **Excel** (`.xlsx`)
- **CSV** (`.csv`)
- **PDF**
- **Print** (browser print dialog with print CSS)

### 5.12 Patient Portal

**Dashboard**
- Upcoming appointments
- Treatment progress
- Remaining sessions
- Payment status

**Booking**
- Choose service · therapist · date · time
- Prevent duplicate booking
- Confirmation page

**Treatment**
- Session history
- Progress chart
- Pain score history
- Files

**Payments**
- View invoices
- Download invoice
- Pay later

**Profile**
- Personal information · phone · emergency contact · notification settings

### 5.13 Settings (Admin)

- **Clinic branding** — admin edits clinic name, subtitle, primary color, and uploads a logo (base64 data URL persisted to `clinic_settings`). Sidebar `<Sidebar />` subscribes to the `kinetic:clinic-updated` event and re-renders live.
- **Custom sections** — admin can add, rename, reorder, hide/show, and delete sidebar sections. Each section stores `slug`, `label`, `icon`, group, description, and freeform body content in `custom_sections`. Routes use the `custom:<id>` prefix; RBAC allows the `custom:` prefix only for `role === "مدير"`.
- Staff management (add/edit staff, assign roles).
- Rooms configuration.
- Working hours and appointment slot duration.
- Notification preferences per channel.
- Package management (link to packages screen).

**Persistence layer.** `src/supabase.jsx` exposes `loadClinic / saveClinic / loadSections / addSection / updateSection / removeSection`. When `SUPABASE_URL` + `SUPABASE_ANON_KEY` are configured on `window`, changes flush to the `clinic_settings` / `custom_sections` tables. Otherwise the module falls back transparently to `localStorage` keys `kinetic.clinic` and `kinetic.sections` for offline / demo use.

---

## 6. Database Schema (Supabase / PostgreSQL)

Supabase (PostgreSQL) is the primary data store. Each entity below maps to a table with the listed primary key. Row Level Security (RLS) is enabled on every table; policies key off the JWT `role` claim. See `supabase-schema.sql` for the executable DDL.

### Table 1 — patients

| Column | Type | Notes |
|--------|------|-------|
| `patient_id` | string (PK) | `P-XXXXX` |
| `name` | string | Full name |
| `phone` | string | E.164 |
| `age` | number | |
| `gender` | enum | M / F |
| `diagnosis` | string | Primary diagnosis |
| `notes` | string | Freeform |
| `created_at` | ISO datetime | Auto |

### Table 2 — bookings

| Column | Type | Notes |
|--------|------|-------|
| `booking_id` | string (PK) | `A-XXXX` |
| `patient_id` | string (FK) | → Patients |
| `therapist_id` | string (FK) | → Staff |
| `date` | ISO date | |
| `time` | HH:mm | |
| `status` | enum | pending / confirmed / in-session / completed / cancelled / no-show / available |
| `notes` | string | |

### Table 3 — sessions

| Column | Type | Notes |
|--------|------|-------|
| `session_id` | string (PK) | |
| `patient_id` | string (FK) | → Patients |
| `therapist_id` | string (FK) | → Staff |
| `date` | ISO date | |
| `pain_score` | number 0–10 | |
| `session_notes` | string | |
| `session_number` | number | Ordinal within plan |

### Table 4 — invoices

| Column | Type | Notes |
|--------|------|-------|
| `invoice_id` | string (PK) | `INV-YYYY-NNNN` |
| `patient_id` | string (FK) | → Patients |
| `amount` | number | EGP |
| `paid` | number | EGP |
| `payment_method` | enum | cash / visa / mastercard / instapay / vodafone / bank |
| `status` | enum | paid / partial / pending / overdue |

### Table 5 — staff

| Column | Type | Notes |
|--------|------|-------|
| `staff_id` | string (PK) | |
| `name` | string | |
| `role` | enum | admin / receptionist / doctor / therapist |
| `phone` | string | |
| `email` | string | Login identifier |

Additional sheets (implicit): `Packages`, `Rooms`, `Notifications`, `Files` (Cloudinary URL index), `Sessions_Modalities` (join), `Goals`.

---

## 7. REST API

Base URL: `https://api.kinetic.eg/api`

All non-auth endpoints require `Authorization: Bearer <JWT>`.

### 7.1 Authentication

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/login` | Exchange credentials for JWT |
| POST | `/api/auth/logout` | Invalidate refresh token |

### 7.2 Patients

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/patients` | List (role-scoped, paginated) |
| POST | `/api/patients` | Create |
| PUT | `/api/patients/:id` | Update |
| DELETE | `/api/patients/:id` | Soft-delete |

### 7.3 Appointments (Bookings)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/bookings` | List (filterable by date/therapist/status) |
| POST | `/api/bookings` | Create (validates business rules) |
| PUT | `/api/bookings/:id` | Reschedule / update status |
| DELETE | `/api/bookings/:id` | Cancel |

### 7.4 Sessions

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/sessions` | List (role-scoped) |
| POST | `/api/sessions` | Start / record session |
| PUT | `/api/sessions/:id` | Update pain, notes, sign-off |

### 7.5 Payments

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/invoices` | List |
| POST | `/api/invoices` | Create invoice |

### 7.6 Reports

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/reports/dashboard` | Dashboard KPIs |
| GET | `/api/reports/patients` | Patient analytics |

### 7.7 Response Envelope (all endpoints)

```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "meta": { "page": 1, "total": 42 }
}
```

Error envelope:

```json
{
  "success": false,
  "data": null,
  "error": { "code": "VALIDATION_ERROR", "message": "..." }
}
```

---

## 8. Security

| Control | Implementation |
|---------|----------------|
| **JWT authentication** | HS256, short-lived access token + rotating refresh token |
| **Role permissions** | Middleware inspects JWT role claim against route allowlist |
| **HTTPS** | Enforced end-to-end (Vercel + Supabase managed TLS) |
| **Environment variables** | Public keys (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) exposed to the client; secrets (`SUPABASE_SERVICE_ROLE`, `CLOUDINARY_KEY`, `TWILIO_TOKEN`) live only in Supabase Edge Function / Vercel env vars — never in the repo |
| **Row Level Security** | RLS enabled on every table; policies key off `auth.jwt() ->> 'role'` (see `supabase-schema.sql`) |
| **Rate limiting** | Supabase built-in per-project throttling; Edge Functions add per-user limits for sensitive mutations |
| **Security headers** | Vercel middleware applies CSP, HSTS, X-Frame-Options, etc. |
| **CORS** | Supabase allowlist of origins (`kinetic.eg`, portal domain, admin domain) |
| **Password hashing** | Handled by Supabase Auth (bcrypt / scrypt) — no bespoke crypto in app code |
| **Input validation** | Zod schemas at the client boundary + Postgres `check` constraints for hard invariants |
| **API key protection** | `service_role` key never leaves the server; only `anon` key ships to the browser |
| **Audit log** | `audit_events` table populated by Postgres triggers on sensitive tables (delete, refund, role change) |

---

## 9. Cross-Cutting Concerns

### 9.1 Toast Notifications
Global toast on the frontend for success / error / warning; auto-dismiss after 2.4 s.

### 9.2 Navigation & Routing
Client-side route stored in `localStorage`; restored on reload. Sidebar shows only routes allowed for the current role. Unknown routes render a 404 fallback.

### 9.3 Voice Input
Web Speech API for clinical notes in sessions. Dictation button appends transcript to notes textarea. Manual editing remains available.

### 9.4 Internationalisation
UI language: Arabic (RTL). Font stack: IBM Plex Sans Arabic (primary), Reem Kufi (display), Amiri (serif), Geist Mono (monospace). Optional English toggle for public site.

---

## 10. Design System

| Token | Value |
|-------|-------|
| Primary blue | `#7BBDE8` |
| Dark blue | `#3A7FB5` / `#1E4A6E` |
| Green (success) | `#3FA984` |
| Amber (warning) | `#D49044` |
| Red (danger) | `#D8665A` |
| Violet (accent) | `#7E6BD3` |
| Base radius | 8 / 12 / 18 / 28 px |

**Components:** `StatCard`, `AreaChart`, `BarChart`, `DonutChart`, `Sparkline`, `Modal`, `Field`, `Page`, `Sidebar`, `Topbar`, `ApptBadge`, `PayBadge`, `BookingFlow`, `ConcurrentSessions`, `PatientPortal`.

**CSS classes:** `.card`, `.btn`, `.btn-blue`, `.btn-secondary`, `.btn-ghost`, `.badge`, `.b-green`, `.b-blue`, `.b-amber`, `.b-red`, `.b-grey`, `.b-violet`, `.seg`, `.tbl`, `.input`, `.muted`, `.mono`, `.h1`–`.h3`, `.crumb`, `.av`, `.grid-stats`, `.grid-3`, `.grid-4`.

---

## 11. Technical Architecture

| Concern | Approach |
|---------|----------|
| Public site | React (Vercel, SSG) |
| App runtime | React 18 (Babel Standalone CDN) — MVP; migrate to Vite build for production |
| Styling | Inline styles + global CSS in `index.html` |
| State | React `useState` / `useEffect`; optional TanStack Query for server cache |
| Backend | Supabase — PostgreSQL + Auth + Storage + auto REST/Realtime; Edge Functions (Deno) for custom logic |
| Database | Supabase (PostgreSQL) accessed via `@supabase/supabase-js` v2 SDK |
| Media | Supabase Storage or Cloudinary (signed uploads) |
| Charts | Custom SVG (AreaChart, BarChart, DonutChart, Sparkline) |
| Responsive sizing | `ResizeObserver` via `useContainerWidth()` hook |
| Messaging | WhatsApp Business API (primary) / Twilio (fallback) / SMS / Email |
| File loading order (MVP) | `core.jsx` → `ui.jsx` → `screens1.jsx` → `roles.jsx` → `multisession.jsx` → `screens2.jsx` |

---

## 12. Deployment

| Tier | Provider | Notes |
|------|----------|-------|
| **Frontend** | **Vercel** | Auto-deploy on `main` branch push |
| **Database + Auth + Storage + API** | **Supabase** | Managed PostgreSQL, auto REST/Realtime, JWT auth |
| **Custom server logic** | **Supabase Edge Functions** | Webhooks, scheduled jobs, privileged mutations |
| **Media storage** | **Supabase Storage** / **Cloudinary** | Signed uploads, transformations |
| **Messaging** | WhatsApp Business API / Twilio | Invoked from Edge Functions |
| **DNS** | Cloudflare | Proxied `kinetic.eg` |

**CI/CD**
- GitHub Actions: lint, unit tests, RLS policy tests on PR.
- Vercel preview URL per PR for frontend.
- Supabase migrations applied via the Supabase CLI on merge to `main`.

**Environments**
- `dev` — separate Supabase project + Cloudinary folder.
- `staging` — mirror of prod Supabase schema, seeded from anonymised prod data.
- `prod` — live.

---

## 13. Seed Data (Demo State)

| Entity | Count |
|--------|-------|
| Patients | 8 |
| Appointments (today) | 10 (8 booked, 2 available) |
| Therapists | 4 (Karim, Lena, Mona, Adel) |
| Doctors | 3 (Yasmin, Mohand, Tarek) |
| Packages | 6 (5 active, 1 archived) |
| Invoices | 8 |
| WhatsApp campaigns | 5 |
| Session history records | 7 |

---

## 14. Open Items & Future Scope

| Item | Priority | Notes |
|------|----------|-------|
| Real WhatsApp Business API integration | High | Currently prototype UI |
| Migrate frontend to Vite/Next.js build | High | Remove Babel Standalone dependency |
| Multi-branch support | Medium | Add `branch_id` column to core tables + RLS policies scoped per branch |
| Native mobile / PWA | Medium | Responsive web first |
| Insurance / takaful billing | Medium | — |
| AI-assisted diagnosis coding | Low | Placeholder "smart suggestion" panel exists |
| Dark mode | Low | CSS variables partially prepared |
| Offline support (Service Worker) | Low | — |
| Self-hosted Supabase | Low (post-MVP) | Move off the managed tier once volume justifies it |
