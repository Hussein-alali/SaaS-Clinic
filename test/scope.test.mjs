// Unit tests for the caseload filters of src/roles.jsx (scopePatients,
// scopeAppts): a doctor sees the patients and bookings linked to them by
// doctor_id or by name; a therapist by therapist_id or by name. UX filters
// only (RLS is the real rule), but an empty list hides the patient file.
//
//   npm test        (node --test test/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = transformSync(["src/i18n.jsx", "src/roles.jsx"]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n"), { loader: "jsx", target: "es2017" }).code;

function boot(me, data) {
  const win = {
    console: { log() {}, info() {}, warn() {}, error() {} }, URL, URLSearchParams,
    location: { search: "", hostname: "localhost", origin: "http://localhost", pathname: "/", href: "http://localhost/" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  win.ME = me;
  win.DATA = data;
  return win;
}
const ids = (rows) => [...rows].map((r) => r.id);

test("a doctor's patients and bookings: by doctor_id (their account's doctor row) or by name", () => {
  const data = {
    doctors: [{ id: "DR-1", name: "د. سارة", auth_uid: "u-doc" }, { id: "DR-2", name: "د. علي", auth_uid: "u-other" }],
    therapists: [],
    patients: [
      { id: "P-1", doctor_id: "DR-1", dr: "—" },
      { id: "P-2", doctor_id: "DR-2", dr: "—" },
      { id: "P-3", doctor_id: null, dr: "سارة أحمد" },
    ],
    appts: [{ id: "B-1", doctor_id: "DR-1", dr: "" }, { id: "B-2", doctor_id: "DR-2", dr: "د. علي" }],
  };
  // The account's staff name differs from the doctors row's name: the
  // doctors row of this account (auth_uid) still counts.
  const win = boot({ id: "u-doc", name: "سارة أحمد", match: "سارة أحمد", scope: "doctor" }, data);
  assert.deepEqual(ids(win.scopePatients(data.patients)), ["P-1", "P-3"]);
  assert.deepEqual(ids(win.scopeAppts(data.appts)), ["B-1"]);
});

test("a doctor without a doctors row sees what carries their name; admin and reception see everything", () => {
  const data = { doctors: [], therapists: [], patients: [{ id: "P-1", doctor_id: "DR-1", dr: "د. سارة" }, { id: "P-2", doctor_id: "DR-2", dr: "د. علي" }], appts: [] };
  assert.deepEqual(ids(boot({ id: "u", name: "د. سارة", match: "د. سارة", scope: "doctor" }, data).scopePatients(data.patients)), ["P-1"]);
  for (const scope of ["all", "reception"]) {
    assert.deepEqual(ids(boot({ id: "u", name: "x", scope }, data).scopePatients(data.patients)), ["P-1", "P-2"], scope);
  }
});
