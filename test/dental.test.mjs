// Unit tests for src/dental.jsx: the tooth chart's state from the findings
// (0018_clinical_records dental_findings: one row per tooth event, the
// latest row of each condition counts) and the FDI layout.
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
const code = transformSync(["src/i18n.jsx", "src/dental.jsx"]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n"), { loader: "jsx", target: "es2017" }).code;

const plain = (v) => JSON.parse(JSON.stringify(v));
function boot() {
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
  return win;
}
let n = 0;
const f = (tooth, condition, status, recorded_on, extra = {}) =>
  ({ finding_id: `DF-${++n}`, tooth, condition, status, recorded_on, created_at: `${recorded_on}T10:00:00.000Z`, surfaces: [], ...extra });

test("the seeded chart (the owner's picture): categories and the codes on each tooth", () => {
  const win = boot();
  const chart = plain(win.chartOf([
    f(16, "filling", "existing", "2026-08-27"), f(14, "caries", "existing", "2026-10-23"),
    f(11, "veneer", "planned", "2026-10-23"), f(21, "crown", "existing", "2026-08-27"),
    f(24, "filling", "existing", "2026-08-27"), f(26, "root_canal", "done", "2026-10-19"),
    f(26, "crown", "planned", "2026-10-23"), f(36, "caries", "existing", "2026-10-23"),
    f(37, "filling", "existing", "2026-08-27"), f(45, "watch", "existing", "2026-10-23"),
    f(46, "implant", "existing", "2026-08-27"), f(48, "missing", "existing", "2026-08-27"),
  ]));
  const got = Object.fromEntries(Object.entries(chart).map(([t, s]) => [t, [s.category, s.label]]));
  assert.deepEqual(got, {
    11: ["planned", "V"], 14: ["attention", "C"], 16: ["restored", "F"], 21: ["restored", "Cr"],
    24: ["restored", "F"], 26: ["planned", "RCT Cr"], 36: ["attention", "C"], 37: ["restored", "F"],
    45: ["attention", "W"], 46: ["restored", "Imp"], 48: ["missing", "M"],
  });
  assert.equal(chart[13], undefined, "a tooth without findings has no state");
});

test("caries stays «needs attention» while the filling is only planned, and is resolved once the filling is done", () => {
  const win = boot();
  const found = f(36, "caries", "existing", "2026-10-01");
  const planned = f(36, "filling", "planned", "2026-10-01", { created_at: "2026-10-01T10:05:00.000Z" });
  let st = plain(win.toothState([found, planned]));
  assert.equal(st.category, "attention", "attention comes before planned");
  assert.equal(st.label, "C F");

  st = plain(win.toothState([found, planned, f(36, "filling", "done", "2026-10-20")]));
  assert.equal(st.category, "restored");
  assert.equal(st.label, "F", "the treated caries is no longer shown");
  assert.deepEqual(st.current.map((x) => [x.condition, x.status]), [["filling", "done"]]);

  // Marked done on its own (e.g. remineralised): resolved too.
  assert.equal(win.toothState([found, f(36, "caries", "done", "2026-10-21")]).category, null);
});

test("a restoration recorded before the caries does not resolve it (same day: by created_at)", () => {
  const win = boot();
  const old = f(16, "filling", "existing", "2026-01-01");
  const caries = f(16, "caries", "existing", "2026-10-01");
  assert.equal(win.toothState([old, caries]).category, "attention");
  const sameDayBefore = f(16, "filling", "done", "2026-10-01", { created_at: "2026-10-01T09:00:00.000Z" });
  assert.equal(win.toothState([sameDayBefore, caries]).category, "attention");
  const sameDayAfter = f(16, "filling", "done", "2026-10-01", { created_at: "2026-10-01T11:00:00.000Z" });
  assert.equal(win.toothState([sameDayAfter, caries]).category, "restored");
});

test("the latest row of a condition counts: a planned crown that was done is no longer planned", () => {
  const win = boot();
  const st = plain(win.toothState([f(26, "crown", "planned", "2026-09-10"), f(26, "crown", "done", "2026-10-02")]));
  assert.equal(st.category, "restored");
  assert.deepEqual(st.current.map((x) => x.status), ["done"]);
});

test("missing and extracted teeth are «missing»; a planned extraction is planned", () => {
  const win = boot();
  assert.equal(win.toothState([f(48, "missing", "existing", "2026-01-01")]).category, "missing");
  assert.equal(win.toothState([f(38, "extraction", "planned", "2026-01-01")]).category, "planned");
  assert.equal(win.toothState([f(38, "extraction", "planned", "2026-01-01"), f(38, "extraction", "done", "2026-02-01")]).category, "missing");
  assert.equal(win.toothState([f(17, "caries", "existing", "2026-01-01"), f(17, "missing", "existing", "2026-01-01")]).category, "missing",
    "missing comes first");
});

test("FDI layout: 32 adult and 20 child teeth, each once, as the database accepts them", () => {
  const win = boot();
  const valid = (t) => [1, 2, 3, 4].includes(Math.floor(t / 10)) ? t % 10 >= 1 && t % 10 <= 8
    : [5, 6, 7, 8].includes(Math.floor(t / 10)) && t % 10 >= 1 && t % 10 <= 5;
  for (const [name, count] of [["adult", 32], ["child", 20]]) {
    const all = [...win.DENTAL_LAYOUT[name].upper, ...win.DENTAL_LAYOUT[name].lower];
    assert.equal(new Set(all).size, count, name);
    assert.ok(all.every(valid), name);
  }
  // Facing the patient: the patient's right (quadrants 1 and 4) on the left.
  assert.deepEqual(plain(win.DENTAL_LAYOUT.adult.upper.slice(0, 8)), [18, 17, 16, 15, 14, 13, 12, 11]);
  assert.deepEqual(plain(win.DENTAL_LAYOUT.adult.lower.slice(8)), [31, 32, 33, 34, 35, 36, 37, 38]);
});
