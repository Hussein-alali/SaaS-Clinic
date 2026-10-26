// Unit tests for src/clinical.jsx (0018_clinical_records; owner request
// 26 Oct 2026): the clinic's diagnosis form, the pain points stored as
// coordinates only ([[x, y], ...] in percent of the body picture), the
// physio form ↔ assessments row mapping, and what ClinicalAPI sends to the
// API (/api/data through src/apiclient.jsx) or keeps in demo mode.
//
//   npm test        (node --test test/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = transformSync(["src/i18n.jsx", "src/apiclient.jsx", "src/clinical.jsx"]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n"), { loader: "jsx", target: "es2017" }).code;

const plain = (v) => JSON.parse(JSON.stringify(v));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function boot({ api = true, org = null, role = null, respond } = {}) {
  const requests = [];
  const store = new Map();
  const events = new EventTarget();
  const win = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, URLSearchParams, FormData, Blob, Response, TextEncoder, TextDecoder, Event,
    CustomEvent: class extends Event { constructor(t, i = {}) { super(t); this.detail = i.detail; } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    location: { search: "", hostname: "localhost", origin: "http://localhost:3000", pathname: "/", href: "http://localhost:3000/" },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    crypto: webcrypto,
    fetch: async (url, init = {}) => {
      const req = { url: String(url), method: init.method || "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
      requests.push(req);
      return (respond || (() => json(200, { data: [], count: null })))(req);
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  if (org) win.TENANT_ORG = org;
  if (role) win.TENANT_ROLE = role;
  if (api) win.SB = win.supabase.createClient("http://localhost", "anon");
  return { win, requests, store };
}

test("clinicForm(): the clinic's diagnosis_form, else its specialty, else physiotherapy (demo, single clinic)", () => {
  assert.equal(boot({ org: { diagnosis_form: "dental", specialty_code: "physio" } }).win.clinicForm(), "dental");
  assert.equal(boot({ org: { diagnosis_form: "bogus", specialty_code: "dental" } }).win.clinicForm(), "dental");
  assert.equal(boot({ org: { specialty_code: "derma" } }).win.clinicForm(), "general", "a new specialty without a form: general");
  assert.equal(boot().win.clinicForm(), "physio");
});

test("clinical access: admin, doctor and therapist read; admin and doctor prescribe; the receptionist neither", () => {
  for (const [role, read, rx] of [["admin", true, true], ["doctor", true, true], ["therapist", true, false], ["receptionist", false, false], ["staff", false, false]]) {
    const { win } = boot({ role });
    assert.equal(win.canReadClinical(), read, role);
    assert.equal(win.canPrescribe(), rx, role);
  }
});

test("pain points are stored as [[x, y]] only: rounded to one decimal, clamped to 0–100, at most 200; the view follows from x", () => {
  const { win } = boot();
  assert.deepEqual(plain(win.encodeMarkers([{ view: "front", x: 12.345, y: 99.99 }, { x: 150, y: -3 }, [5, 6], { x: "a", y: 1 }, null])),
    [[12.3, 100], [100, 0], [5, 6]]);
  assert.equal(win.encodeMarkers(Array.from({ length: 250 }, () => [1, 1])).length, 200);
  assert.deepEqual(plain(win.decodeMarkers([[10, 50], [30, 50], [60, 50], [90, 50]]).map((m) => m.view)), ["left", "back", "front", "right"]);
  assert.deepEqual(plain(win.decodeMarkers("not points")), []);
});

test("the physio form becomes one assessments row with its fields in data and the points as coordinates", () => {
  const { win } = boot();
  const form = {
    ...win.PHYSIO_EMPTY, diagnosis: "  انزلاق غضروفي  ", thll: { on: true, mode: "Bilat" },
    modalities: { "Laser": true, "TENS / FS / IF": true, "Massage Gun": false }, exercises: "Bridging",
    markers: [{ view: "back", x: 37.24, y: 44.61 }, { view: "front", x: 62.7, y: 46 }],
  };
  const row = plain(win.physioRowFromForm(form, { patientId: "P-1", therapistId: "ST-1", therapistName: "أخصائي", id: null }));
  assert.deepEqual(Object.keys(row).sort(), ["clinician_id", "clinician_name", "data", "diagnosis", "kind", "markers", "patient_id"]);
  assert.equal(row.kind, "physio");
  assert.equal(row.diagnosis, "انزلاق غضروفي");
  assert.deepEqual(row.markers, [[37.2, 44.6], [62.7, 46]], "no view, no picture: two numbers per point");
  assert.deepEqual(row.data.modalities, ["Laser", "TENS / FS / IF"]);
  assert.deepEqual(row.data.thll, { on: true, mode: "Bilat" });
  assert.equal(row.data.exercises, "Bridging");
  assert.equal("markers" in row.data || "diagnosis" in row.data, false);
  assert.equal(plain(win.physioRowFromForm(form, { patientId: "P-1", id: "ASM-1" })).assessment_id, "ASM-1");

  const back = plain(win.physioFormFromRow(row));
  assert.equal(back.diagnosis, "انزلاق غضروفي");
  assert.deepEqual(back.modalities, { "Laser": true, "TENS / FS / IF": true });
  assert.deepEqual(back.markers, [{ x: 37.2, y: 44.6, view: "back" }, { x: 62.7, y: 46, view: "front" }]);
  assert.equal(back.exercises, "Bridging");
  assert.equal(back.nGlide, false, "missing fields keep the empty form's values");
});

test("ClinicalAPI.list asks for one patient's rows, newest first; save never sends the author or the clinic", async () => {
  const { win, requests } = boot({
    respond: (req) => json(200, { data: req.body.action === "select" ? [] : { ...req.body.values, assessment_id: "ASM-9" }, count: null }),
  });
  await win.ClinicalAPI.list("assessments", "P-1");
  assert.deepEqual(plain(requests[0].body), {
    table: "assessments", action: "select", columns: "*",
    filters: [{ column: "patient_id", op: "eq", value: "P-1" }],
    order: [{ column: "visit_date", ascending: false }, { column: "created_at", ascending: false }],
    range: { from: 0, to: 499 },
  });
  const saved = await win.ClinicalAPI.save("assessments", {
    patient_id: "P-1", kind: "physio", markers: [[1, 2]], author_uid: "u-forged", author_name: "x", organization_id: "o-other", created_at: "2001-01-01",
  });
  assert.equal(saved.assessment_id, "ASM-9");
  const ins = requests.at(-1).body;
  assert.equal(ins.action, "insert");
  assert.deepEqual(plain(ins.values), { patient_id: "P-1", kind: "physio", markers: [[1, 2]] });
  await win.ClinicalAPI.save("assessments", { assessment_id: "ASM-9", diagnosis: "x" });
  const upd = requests.at(-1).body;
  assert.equal(upd.action, "update");
  assert.deepEqual(plain(upd.filters), [{ column: "assessment_id", op: "eq", value: "ASM-9" }]);
  assert.deepEqual(plain(upd.values), { assessment_id: "ASM-9", diagnosis: "x" });
});

test("ClinicalAPI: a refusal is said in the page language; a delete that matched nothing says who may delete", async () => {
  const { win } = boot({
    respond: (req) => (req.body.action === "delete"
      ? json(200, { data: [], count: null })
      : json(403, { error: { message: "The module dental.chart is not enabled for this clinic", code: "module_disabled" } })),
  });
  await assert.rejects(win.ClinicalAPI.list("dental_findings", "P-1"), /هذه الوحدة غير مفعّلة لعيادتك/);
  await assert.rejects(win.ClinicalAPI.remove("assessments", "ASM-1", "P-1"), /يحذفه كاتبه أو الطبيب أو المدير/);
});

test("demo mode (no API): ClinicalAPI keeps the rows in this browser, newest first, and signals the change", async () => {
  const { win, requests, store } = boot({ api: false });
  const seen = [];
  win.addEventListener("kinetic:clinical-updated", (e) => seen.push(e.detail));
  const a = await win.ClinicalAPI.save("dental_findings", { patient_id: "P-1", tooth: 26, condition: "caries", status: "existing", surfaces: ["O"] });
  assert.match(a.finding_id, /^DF-/);
  await win.ClinicalAPI.save("dental_findings", { patient_id: "P-2", tooth: 11, condition: "missing", status: "existing" });
  const rows = await win.ClinicalAPI.list("dental_findings", "P-1");
  assert.deepEqual(plain(rows.map((r) => r.tooth)), [26]);
  await win.ClinicalAPI.save("dental_findings", { finding_id: a.finding_id, status: "done" });
  assert.equal((await win.ClinicalAPI.list("dental_findings", "P-1"))[0].status, "done");
  await win.ClinicalAPI.remove("dental_findings", a.finding_id, "P-1");
  assert.deepEqual(plain(await win.ClinicalAPI.list("dental_findings", "P-1")), []);
  assert.equal(requests.length, 0, "no request in demo mode");
  assert.ok(store.has("kinetic.clinical.v1"));
  assert.deepEqual(plain(seen.map((d) => d.patientId)), ["P-1", "P-2", "P-1", "P-1"]);
});
