// Production build: precompiles src/*.jsx so the browser no longer ships
// Babel Standalone (3 MB) and transpiles ~900 KB of JSX on every visit.
//
//   npm run build   →   dist/index.html, dist/app.<hash>.js,
//                       dist/import.<hash>.js, dist/lang-en.<hash>.js,
//                       dist/assets/
//   BUILD_OUT=<dir> npm run build   →   the same into <dir> (parallel test
//                       stacks each build their own copy, scripts/dev-stack.sh)
//
// The files are classic scripts that share globals (no import/export), so
// they are concatenated in the exact order index.html lists them and
// transformed — not bundled. src/import.jsx (the ?import=1 page) and
// src/platform.jsx (the Super Admin panel) become separate chunks that the
// app loads only on their route / context (screens3.jsx, tenant.jsx). The English
// dictionaries (src/lang/en-*.jsx) become dist/lang-en.<hash>.js, which the
// language boot script in index.html loads ahead of the app only when the
// interface is in English (src/i18n.jsx), so Arabic users never download it.
// index.html stays the dev entry point (`npm run dev`, Babel in-browser).
import { transform } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { i18nHash } from "./i18n-hash.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.BUILD_OUT ? path.resolve(process.env.BUILD_OUT) : path.join(ROOT, "dist");
const IMPORT_PAGE = "src/import.jsx";
// The Super Admin panel: only admin.<base> / ?platform=1 needs it (task 3.12).
const PLATFORM_PAGE = "src/platform.jsx";

// Production React builds. SRI hashes are sha384 of the npm package files,
// which unpkg serves byte-for-byte (same method reproduces the hashes of
// the development builds already in index.html).
const REACT_PROD = {
  "react.development.js": {
    file: "react.production.min.js",
    integrity: "sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z",
  },
  "react-dom.development.js": {
    file: "react-dom.production.min.js",
    integrity: "sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1",
  },
};

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

// Replace exactly one match, so an edit to index.html that the build no
// longer understands fails loudly instead of producing a broken page.
function replaceOnce(html, re, replacement, what) {
  const matches = html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!matches || matches.length !== 1) fail(`expected exactly one ${what} in index.html, found ${matches ? matches.length : 0}`);
  return html.replace(re, replacement);
}

async function compile(files, name) {
  const source = files.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
  const { code } = await transform(source, {
    loader: "jsx",
    minify: true,
    target: "es2017",
    legalComments: "none",
    sourcefile: name,
  });
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
  const out = `${name}.${hash}.js`;
  fs.writeFileSync(path.join(DIST, out), code);
  return { out, bytes: Buffer.byteLength(code) };
}

// The English dictionaries are keyed by the Arabic text (readable in
// src/lang/). Shipped, each key becomes its hash (src/i18n.jsx looks it up
// the same way), which keeps the chunk small: the Arabic text is already in
// the app bundle at every tt() call. Two keys with one hash fail the build.
async function compileDictionary(files, name) {
  // One sandbox per file, so the same Arabic text translated differently in
  // two files fails the build instead of the later file silently winning
  // (a word that needs two translations uses ttc() and a context key).
  const dict = {};
  const from = {};
  for (const f of files) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
    for (const [ar, en] of Object.entries(sandbox.window.I18N_EN || {})) {
      if (ar in dict && dict[ar] !== en) fail(`${name}: ${JSON.stringify(ar)} is ${JSON.stringify(dict[ar])} in ${from[ar]} but ${JSON.stringify(en)} in ${f}`);
      dict[ar] = en;
      from[ar] = f;
    }
  }
  const hashed = {};
  const owner = {};
  for (const [ar, en] of Object.entries(dict)) {
    if (typeof en !== "string") fail(`${name}: the English for ${JSON.stringify(ar)} is not a string`);
    const h = i18nHash(ar);
    if (owner[h] !== undefined && owner[h] !== ar) fail(`${name}: hash collision between ${JSON.stringify(owner[h])} and ${JSON.stringify(ar)}`);
    owner[h] = ar;
    hashed[h] = en;
  }
  const code = `window.I18N_EN_H=${JSON.stringify(hashed)};`;
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
  const out = `${name}.${hash}.js`;
  fs.writeFileSync(path.join(DIST, out), code);
  return { out, bytes: Buffer.byteLength(code), keys: Object.keys(hashed).length };
}

let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const eol = html.includes("\r\n") ? "\r\n" : "\n";

// Script order is taken from index.html itself so the two never drift.
const scripts = [...html.matchAll(/<script type="text\/babel" src="([^"]+)"><\/script>/g)].map(m => m[1]);
if (!scripts.length) fail("no <script type=\"text/babel\"> tags found in index.html");
if (!scripts.includes(IMPORT_PAGE)) fail(`${IMPORT_PAGE} is no longer listed in index.html — update scripts/build.mjs`);
if (!scripts.includes(PLATFORM_PAGE)) fail(`${PLATFORM_PAGE} is no longer listed in index.html — update scripts/build.mjs`);
const isLangEn = s => /^src\/lang\/en-[\w-]+\.jsx$/.test(s);
const langEnFiles = scripts.filter(isLangEn);
if (!langEnFiles.length) fail("no src/lang/en-*.jsx dictionaries listed in index.html");
const appFiles = scripts.filter(s => s !== IMPORT_PAGE && s !== PLATFORM_PAGE && !isLangEn(s));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const app = await compile(appFiles, "app");
const importPage = await compile([IMPORT_PAGE], "import");
const platformPage = await compile([PLATFORM_PAGE], "platform");
const langEn = await compileDictionary(langEnFiles, "lang-en");

for (const [dev, prod] of Object.entries(REACT_PROD)) {
  html = replaceOnce(
    html,
    new RegExp(`(<script src="https://unpkg\\.com/[^"]+/umd/)${dev.replace(/\./g, "\\.")}" integrity="[^"]+"`),
    `$1${prod.file}" integrity="${prod.integrity}"`,
    `${dev} script tag`,
  );
}
html = replaceOnce(html, /<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]+"[^>]*><\/script>\r?\n/, "", "Babel Standalone script tag");
// The language boot script reads KINETIC_LANG_EN to load the dictionary.
html = replaceOnce(html, /<!-- i18n:lang-chunk -->/, `<script>window.KINETIC_LANG_EN = "${langEn.out}";</script>`, "i18n:lang-chunk marker");

// Swap the whole block of text/babel tags (and the comment inside it) for
// the compiled bundle. The chunk map tells screens2.jsx where the
// ?import=1 page lives.
const firstTag = html.indexOf('<script type="text/babel"');
const lastTag = html.lastIndexOf('<script type="text/babel"');
const blockEnd = html.indexOf("</script>", lastTag) + "</script>".length;
const indent = html.slice(html.lastIndexOf("\n", firstTag) + 1, firstTag);
html = html.slice(0, firstTag)
  + `<script>window.KINETIC_CHUNKS = { importPage: "${importPage.out}", platform: "${platformPage.out}" };</script>${eol}`
  + `${indent}<script src="${app.out}"></script>`
  + html.slice(blockEnd);
if (html.includes("text/babel")) fail("a text/babel script survived the build");

fs.writeFileSync(path.join(DIST, "index.html"), html);
fs.cpSync(path.join(ROOT, "assets"), path.join(DIST, "assets"), { recursive: true });

const kb = n => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/${app.out}  ${kb(app.bytes)}  (${appFiles.join(", ")})`);
console.log(`dist/${importPage.out}  ${kb(importPage.bytes)}  (${IMPORT_PAGE}, loaded only on ?import=1)`);
console.log(`dist/${platformPage.out}  ${kb(platformPage.bytes)}  (${PLATFORM_PAGE}, loaded only in the platform context)`);
console.log(`dist/${langEn.out}  ${kb(langEn.bytes)}  (${langEn.keys} English texts from ${langEnFiles.length} dictionaries, loaded only in English)`);
console.log(`${path.relative(ROOT, DIST) || "."}/index.html, assets/`);
