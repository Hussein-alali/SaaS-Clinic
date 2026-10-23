// Playwright helper: serve the CDN scripts that index.html / dist load from
// local npm copies. In this sandbox unpkg.com and cdn.jsdelivr.net are not
// reachable from Chromium, but the npm registry is, so the exact same
// package versions are fetched once with `npm pack` and cached.
//
//   const { routeCdn } = require('../scripts/pw-cdn.cjs');
//   const context = await browser.newContext();
//   await routeCdn(context);
//
// Google Fonts are answered with empty CSS so pages do not wait on them.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CACHE = process.env.PW_CDN_CACHE || "/tmp/clinicsys-cdn-cache";

const PACKAGES = {
  "react@18.3.1": "react-18.3.1",
  "react-dom@18.3.1": "react-dom-18.3.1",
  "@babel/standalone@7.29.0": "babel-standalone-7.29.0",
  "xlsx-js-style@1.2.0": "xlsx-js-style-1.2.0",
};

function ensurePackages() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [spec, dir] of Object.entries(PACKAGES)) {
    const target = path.join(CACHE, dir);
    if (fs.existsSync(path.join(target, "package", "package.json"))) continue;
    const tgz = execFileSync("npm", ["pack", spec, "--silent"], { cwd: CACHE, encoding: "utf8" }).trim().split("\n").pop();
    fs.mkdirSync(target, { recursive: true });
    execFileSync("tar", ["xzf", path.join(CACHE, tgz), "-C", target]);
  }
}

// https://unpkg.com/<pkg>@<ver>/<file> or https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<file>
function localFile(url) {
  const m = url.match(/^https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/((?:@[^/]+\/)?[^/@]+@[^/]+)\/(.+)$/);
  if (!m) return null;
  const dir = PACKAGES[m[1]];
  if (!dir) return null;
  const file = path.join(CACHE, dir, "package", m[2].split("?")[0]);
  return fs.existsSync(file) ? file : null;
}

async function routeCdn(context) {
  ensurePackages();
  await context.route(/^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//, (route) => {
    const file = localFile(route.request().url());
    if (!file) return route.fulfill({ status: 404, body: "not cached: " + route.request().url() });
    return route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      headers: { "access-control-allow-origin": "*" },
      body: fs.readFileSync(file),
    });
  });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }));
}

module.exports = { routeCdn, ensurePackages };
