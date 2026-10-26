// scripts/deploy.sh and scripts/rollback.sh (docs/06 S2; runbook in docs/08):
// releases in APP_HOME/releases/<stamp>-<id>, APP_HOME/current a symlink
// switched atomically, a health check after the restart, an automatic
// switch back when the new release is unhealthy, the 5 newest kept.
//
// The test runs the real scripts with fake commands (no npm, no database):
// the health server answers 200 unless the release `current` points to has
// "bad" in its name.
//
//   npm test        (node --test test/*.test.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = path.join(ROOT, "scripts", "deploy.sh");
const ROLLBACK = path.join(ROOT, "scripts", "rollback.sh");
const PACKAGE = path.join(ROOT, "scripts", "package-release.sh");

let tmp, appHome, server, healthUrl, src;
const log = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clinicsys-deploy-test-"));
  appHome = path.join(tmp, "app");
  src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "api"), { recursive: true });
  fs.mkdirSync(path.join(src, "db"), { recursive: true });
  fs.writeFileSync(path.join(src, "api", "app.js"), "// fake");
  // Answers like /api/health: 503 for a release named "bad"; for one named
  // "stale" the previous process keeps answering (its release name).
  let lastGood = null;
  // ?home=<APP_HOME> for a test with its own app folder.
  server = http.createServer((req, res) => {
    const home = new URL(req.url, "http://x").searchParams.get("home") || appHome;
    let current = "";
    try { current = fs.readlinkSync(path.join(home, "current")); } catch {}
    const name = path.basename(current);
    const ok = !/bad/.test(name);
    if (ok && !/stale/.test(name)) lastGood = name;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, release: /stale/.test(name) ? lastGood : name }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  healthUrl = `http://127.0.0.1:${server.address().port}/api/health`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Async on purpose: the health server lives in this process, and spawnSync
// would block it while the script polls it.
function sh(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      env: {
        ...process.env,
        APP_HOME: appHome, HEALTH_URL: healthUrl, HEALTH_TIMEOUT: "3", HEALTH_INTERVAL: "0.2",
        SKIP_INSTALL: "1", MIGRATE_CMD: "true", BACKUP_CMD: "true",
        RESTART_CMD: `echo restart >> ${JSON.stringify(path.join(tmp, "restarts.log"))}`,
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => {
      log.push(`${path.basename(script)} ${args.join(" ")} → ${status}\n${out}`);
      resolve({ status, out });
    });
  });
}
const current = () => path.basename(fs.readlinkSync(path.join(appHome, "current")));
const releases = () => fs.readdirSync(path.join(appHome, "releases")).sort();
let n = 0;
const deploy = (id, env = {}) => sh(DEPLOY, [src], { RELEASE_ID: id, DEPLOY_STAMP: `20261025T1200${String(n++).padStart(2, "0")}Z`, ...env });

test("deploy A, then B: current follows, both kept, the app restarted each time", async () => {
  assert.equal((await deploy("a")).status, 0, log.at(-1));
  assert.equal(current(), "20261025T120000Z-a");
  assert.equal((await deploy("b")).status, 0, log.at(-1));
  assert.equal(current(), "20261025T120001Z-b");
  assert.deepEqual(releases(), ["20261025T120000Z-a", "20261025T120001Z-b"]);
  assert.equal(fs.readFileSync(path.join(tmp, "restarts.log"), "utf8").trim().split("\n").length, 2);
  assert.ok(fs.existsSync(path.join(appHome, "current", "api", "app.js")));
  assert.equal(fs.readFileSync(path.join(appHome, "current", "RELEASE"), "utf8").trim(), "20261025T120001Z-b");
});

test("an unhealthy release is switched back automatically: exit 2, B serves again", async () => {
  const r = await deploy("bad-c");
  assert.equal(r.status, 2, log.at(-1));
  assert.equal(current(), "20261025T120001Z-b");
  assert.ok(fs.existsSync(path.join(appHome, "releases", "20261025T120002Z-bad-c", ".failed")));
});

test("a failed backup or migration stops the deploy before the switch", async () => {
  assert.equal((await deploy("d", { BACKUP_CMD: "false" })).status, 1);
  assert.equal(current(), "20261025T120001Z-b");
  assert.equal((await deploy("e", { MIGRATE_CMD: "false" })).status, 1);
  assert.equal(current(), "20261025T120001Z-b");
  assert.ok(!releases().some((r) => /-(d|e)$/.test(r)), "no half-installed release left");
});

test("rollback goes to the previous healthy release, or to a named one", async () => {
  assert.equal((await sh(ROLLBACK, [])).status, 0, log.at(-1));
  assert.equal(current(), "20261025T120000Z-a", "skips the failed bad-c");
  assert.equal((await sh(ROLLBACK, ["20261025T120001Z-b"])).status, 0, log.at(-1));
  assert.equal(current(), "20261025T120001Z-b");
  assert.equal((await sh(ROLLBACK, ["nope"])).status, 1);
});

test("only the 5 newest releases are kept (never the current one)", async () => {
  for (const id of ["f", "g", "h", "i", "j", "k"]) assert.equal((await deploy(id)).status, 0, log.at(-1));
  assert.equal(releases().length, 5);
  assert.ok(releases().includes(current()));
});

test("first deploy (no running release): the new release takes the backup, before its migrations", async () => {
  const home = path.join(tmp, "fresh-app"), fresh = path.join(tmp, "fresh-src"), trail = path.join(tmp, "fresh.log");
  fs.cpSync(src, fresh, { recursive: true });
  fs.mkdirSync(path.join(fresh, "scripts"));
  fs.writeFileSync(path.join(fresh, "scripts", "backup.sh"), `#!/usr/bin/env bash\necho "backup $*" >> ${JSON.stringify(trail)}\n`, { mode: 0o755 });
  const r = await sh(DEPLOY, [fresh], {
    APP_HOME: home, HEALTH_URL: `${healthUrl}?home=${encodeURIComponent(home)}`,
    RELEASE_ID: "first", BACKUP_CMD: "", MIGRATE_CMD: `echo migrate >> ${JSON.stringify(trail)}`,
  });
  assert.equal(r.status, 0, log.at(-1));
  assert.deepEqual(fs.readFileSync(trail, "utf8").trim().split("\n"), ["backup --db-only", "migrate"]);
});

test("package-release.sh builds a tarball that deploys", async () => {
  const out = path.join(tmp, "release.tar.gz");
  const p = spawnSync("bash", [PACKAGE, out], { encoding: "utf8", timeout: 120000, env: { ...process.env, BUILD_OUT: undefined } });
  assert.equal(p.status, 0, p.stderr);
  const list = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split("\n");
  for (const f of ["./api/app.js", "./db/migrate.js", "./scripts/backup.sh", "./dist/index.html"]) assert.ok(list.includes(f), f);
  assert.ok(!list.some((f) => /node_modules|\/e2e\/|\/test\//.test(f)), "no node_modules or tests");
  const r = await sh(DEPLOY, [out], { RELEASE_ID: "pkg", DEPLOY_STAMP: "20261025T130000Z" });
  assert.equal(r.status, 0, log.at(-1));
  assert.ok(fs.existsSync(path.join(appHome, "current", "dist", "index.html")));
});

test("a release the health check does not see running (the old process still answers) is switched back too", async () => {
  assert.equal((await deploy("good")).status, 0, log.at(-1));
  const before = current();
  const r = await deploy("stale");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /answers release .*good.*, not .*stale/);
  assert.equal(current(), before);
});
