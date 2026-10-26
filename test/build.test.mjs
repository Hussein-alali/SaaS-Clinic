// scripts/build.mjs: the chunks loaded on demand (import, platform) are
// classic scripts like the app bundle, minified on their own. Their
// top-level names (esbuild's helpers among them: `we`, `N`, `F`...) would
// land in the one global scope and overwrite the app bundle's. On 25 Oct
// 2026 the platform chunk's `we` (hasOwnProperty) replaced the app's
// (getOwnPropertyDescriptors) and every platform page crashed in I.Eye. So
// each chunk loaded on demand is one function scope and exports only
// through window.*.
//
//   npm test        (node --test test/*.test.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let out;
before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "clinicsys-build-test-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], {
    encoding: "utf8", env: { ...process.env, BUILD_OUT: out }, timeout: 120000,
  });
  assert.equal(r.status, 0, r.stderr);
});
after(() => fs.rmSync(out, { recursive: true, force: true }));

const chunk = (name) => {
  const file = fs.readdirSync(out).find((f) => new RegExp(`^${name}\\.[0-9a-f]{10}\\.js$`).test(f));
  assert.ok(file, `${name} chunk`);
  return fs.readFileSync(path.join(out, file), "utf8");
};

test("the chunks loaded on demand are one function scope each: no top-level name reaches the shared globals", () => {
  for (const name of ["import", "platform"]) {
    const code = chunk(name).trim();
    assert.match(code, /^\(\(\)=>\{[\s\S]*\}\)\(\);?$/, `${name}: wrapped in one arrow IIFE`);
    // Run it with every global it touches stubbed: it may add window.* exports, nothing else.
    const touched = new Set();
    const stub = new Proxy(function () {}, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
      apply: () => stub,
      construct: () => stub,
    });
    const g = {};
    const ctx = vm.createContext(g);
    g.window = g;
    const before = new Set(Object.getOwnPropertyNames(g));
    for (const k of ["React", "ReactDOM", "document", "tt", "ttx", "ttc", "fmtDate", "fmtMoney", "fmtNumber", "IS_RTL", "I", "Icon", "localStorage", "location", "navigator"]) {
      g[k] = stub;
      touched.add(k);
    }
    try { vm.runInContext(code, ctx, { filename: `${name}.js` }); } catch (_) { /* a stub cannot run everything; names declared first */ }
    const added = Object.getOwnPropertyNames(g).filter((k) => !before.has(k) && !touched.has(k));
    const allowed = { import: ["HistoricalImportPage", "ImportAuthGate"], platform: ["PlatformApp"] }[name];
    assert.deepEqual(added.filter((k) => !allowed.includes(k)), [], `${name}: globals besides its window.* exports`);
  }
});

test("the app bundle still shares its globals (classic scripts in index.html order) and the dictionary chunk is data", () => {
  assert.doesNotMatch(chunk("app").trim(), /^\(\(\)=>\{/, "the app bundle is not wrapped: the chunks read its globals");
  assert.match(chunk("lang-en"), /^window\.I18N_EN_H=\{/);
});

// Security audit (25 Oct 2026, CWE-79): dist/index.html carries a
// Content-Security-Policy. Script runs only from this site, from the exact
// CDN files the app loads (each with SRI) and from the inline boot scripts
// by hash: an injected <script> or event handler would not run.
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\s*\/?>/;
const sha256 = (text) => "'sha256-" + createHash("sha256").update(text).digest("base64") + "'";

test("dist/index.html: a CSP meta before any script; inline boot scripts allowed by hash only", () => {
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const m = CSP_META.exec(html);
  assert.ok(m, "CSP meta tag");
  assert.ok(m.index < html.indexOf("<script"), "the policy applies before the first script");
  const directives = Object.fromEntries(m[1].split(";").map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));
  const script = directives["script-src"];
  assert.ok(script, "script-src");
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "https:", "data:", "https://unpkg.com", "https://cdn.jsdelivr.net"]) {
    assert.equal(script.includes(bad), false, `script-src must not allow ${bad}`);
  }
  // The parser turns CRLF into LF before the browser hashes a script's text.
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((s) => sha256(s[1].replace(/\r\n?/g, "\n")));
  assert.ok(inline.length >= 3, "the language and chunk boot scripts");
  for (const h of inline) assert.ok(script.includes(h), `inline script ${h} allowed`);
  assert.deepEqual(script.filter((s) => s.startsWith("'sha256-")).sort(), [...new Set(inline)].sort(), "no stale hashes");
  for (const [, src] of html.matchAll(/<script src="(https:[^"]+)"/g)) assert.ok(script.includes(src), `${src} allowed`);
  assert.ok(script.includes("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"), "the Excel library (loaded on demand)");
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'self'"]);
  assert.deepEqual(directives["form-action"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["'self'"]);
  assert.deepEqual(directives["default-src"], ["'self'"]);
});

test("every CDN script carries SRI: index.html tags and the Excel library loaded on demand", () => {
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  for (const [tag] of html.matchAll(/<script src="https:[^>]+>/g)) assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/, tag);
  const app = chunk("app");
  assert.ok(app.includes('"https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"'), "Excel library URL");
  assert.ok(app.includes('"sha384-OUW9euuUyxyHcAhTqbhI+Iyb8LMssXt/cpz0yXhs9UWG2/R/uaWdakx/4cfww7Vb"'), "Excel library SRI");
});
