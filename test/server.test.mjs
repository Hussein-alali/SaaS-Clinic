// server.js (npm start / npm run dev): when it serves the repository root
// (--dev, or no dist/ yet) it used to answer every file in it, among them
// seed-admin.sql and DEPLOY.md (the initial admin password), .git/ and
// api/.env (security audit, 25 Oct 2026, CWE-538). It serves the app's own
// files only now: index.html, src/ and assets/; dotfiles never.
//
//   npm test        (node --test test/*.test.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let child;
let port;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
// The raw path is sent as is (no URL normalization by the client).
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ["server.js", "--dev"], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server.js did not start")), 10000);
    child.stdout.on("data", (d) => { if (/serving/.test(String(d))) { clearTimeout(timer); resolve(); } });
    child.on("exit", (code) => reject(new Error(`server.js exited with ${code}`)));
  });
});
after(() => { if (child) child.kill("SIGTERM"); });

test("--dev serves index.html, src/ and assets/", async () => {
  for (const p of ["/", "/index.html", "/src/core.jsx", "/src/lang/en-shell.jsx", "/assets/body-diagram.jpeg"]) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test("--dev never serves the repository's other files or dotfiles", async () => {
  const refused = [
    "/seed-admin.sql", "/DEPLOY.md", "/Supabase_All_In_One.sql", "/package.json", "/server.js", "/server.log",
    "/.git/config", "/.gitignore", "/api/.env", "/api/src/config.js", "/db/seed/dev.sql", "/docs/PROGRESS.md",
    "/src/.hidden", "/assets/../seed-admin.sql", "/src/..%2fseed-admin.sql", "/%2e%2e/etc/passwd",
  ];
  for (const p of refused) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 403 || r.status === 400, `${p}: ${r.status}`);
    assert.equal(/password|PASSWORD|\[core\]/.test(r.body), false, `${p} leaked content`);
  }
});
