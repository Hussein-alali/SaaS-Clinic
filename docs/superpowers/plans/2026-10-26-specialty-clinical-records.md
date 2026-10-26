# Specialty clinical records (patient file + diagnosis per department) Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking. One commit per task; every commit updates the six docs + `docs/PROGRESS.md` (CLAUDE.md).

**Goal:** The patient file and the diagnosis (التشخيص) follow the clinic's department: physiotherapy keeps its screens and gets its pain map (body image + saved points) in the patient file; dentistry gets the tooth-chart patient file of the owner's picture (FDI chart, tooth panel with surfaces and history, treatment, visit notes, prescriptions, appointments, billing); every other department gets a simple general file and diagnosis. The Super Admin chooses which diagnosis form each specialty uses.

**Owner decisions (26 Oct 2026):** the form is chosen per specialty by the Super Admin (new specialties default to general); clinical records are read and written by admin, doctor and therapist only (receptionists see personal data, appointments and billing); prescriptions for dental and general, not physio; each saved diagnosis is a new dated record (history), the patient file shows the latest and earlier ones can be selected.

**Architecture:** One table for every diagnosis (`assessments`, `kind` physio|dental|general) with the form's fields in `data jsonb` and the pain points as coordinates only (`markers jsonb` = `[{v, x, y}]`, percentages with one decimal on `assets/body-diagram.jpeg`; no image is stored). Dental chart = events in `dental_findings` (FDI tooth, surfaces, condition, status existing|planned|done); the chart and each tooth's history are computed from them. `prescriptions` with `items jsonb`. All three: FORCE RLS + `tenant_isolation`, not branch-scoped (a patient's clinical record is one across branches, like `patients`), FK `(organization_id, patient_id)` → `patients` on delete cascade, author stamped by a trigger from the session. `specialties.diagnosis_form` decides the form; `/api/orgs/current` returns it. Modules: `dental.chart`, `general.visits`, `general.prescriptions` become active (prescriptions also in dental's defaults).

**Tech Stack:** PostgreSQL ≥ 13 (no extensions), Express 5, React 18 classic scripts (new files in `index.html`), node:test, Playwright.

## Global Constraints

- Migration `0018_clinical_records.sql`, expand only. JSON validated in SQL (`valid_body_markers`, `valid_rx_items`), sizes bounded.
- No per-row queries; patient clinical rows are read on demand when the file opens (not at startup, docs/06 S9), with `organization_id` in every list (S9 rule).
- Every UI text through `tt()` with English in `src/lang/en-clinical.jsx`; numbers Latin; the tooth chart and the body image are never mirrored in RTL (anatomical orientation).
- Security rules of `docs/09` §8: no inline handlers, no outside requests, server-known values (author, organization) never taken from the client.
- Demo mode (`?demo=1`) keeps working without `/api` (localStorage fallback).

---

### Task 1: Database + API

**Files:** `db/migrations/0018_clinical_records.sql`, `db/test/clinical.test.js`; `api/src/modules.js`, `api/src/tenant.js` (`diagnosis_form`), `api/src/routes/platform.js` (`PATCH /api/platform/specialties/:code`), `api/test/clinical.test.js`; `db/test/isolation.test.js` / `baseline.test.js` lists if needed.

- [ ] Tests first: roles (receptionist reads nothing; therapist writes assessments and findings, not prescriptions; doctor writes all; delete admin/doctor or the author), other clinic invisible, author forged → replaced, markers/items/tooth/surfaces/condition validation, kind must match the clinic's form, module off → `403 module_disabled`, `diagnosis_form` in `/api/orgs/current`, Super Admin PATCH audited, clinic admin refused.
- [ ] Implement; DB + API suites green; commit.

### Task 2: Shared client layer + physio

**Files:** `src/clinical.jsx` (ClinicalAPI with demo fallback, `clinicForm()`, marker encode/decode, `BodyMap`), `src/lang/en-clinical.jsx`, `index.html`; `src/screens2.jsx` (PhysioSessionForm saves to `assessments`, imports a device draft), `src/screens1.jsx` (patient file dispatch + physio «التشخيص» tab).

- [ ] Client tests: encode/decode, save sends coordinates only, legacy draft import.
- [ ] e2e: a therapist marks three points and saves → another account opens the patient → the same three points on the image.

### Task 3: Dental patient file and chart

**Files:** `src/dental.jsx`, `src/lang/en-clinical.jsx`.

- [ ] Header (file no., age, phone, WhatsApp reminders, medical alerts), actions (visit note, prescription, appointment, edit), tabs Overview · Tooth chart · Treatment · Billing · Visit notes · Prescriptions · Appointments; chart adult/child, legend, tooth panel (surfaces, Existing/Planned/Done, conditions), history, dictation.
- [ ] e2e on demo-dental, Arabic and English.

### Task 4: General file + diagnosis + prescriptions; the «التشخيص» route

**Files:** `src/general.jsx`, `src/roles.jsx`, `src/screens3.jsx` (route), dictionaries.

- [ ] General diagnosis (complaint, examination, diagnosis, plan, follow-up), general patient file, prescription form + print, «التشخيص» page for dental/general.

### Task 5: Super Admin

**Files:** `src/platform.jsx` (A05 form per specialty, wizard/A04 show the form).

- [ ] e2e: change a specialty's form → audited → the clinic's file follows.

### Task 6: Docs, full verification

- [ ] Six docs + PROGRESS; client, DB + API, e2e; size budget.
