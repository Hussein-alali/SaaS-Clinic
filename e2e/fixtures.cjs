// Shared test fixtures: every browser context gets the CDN routes from
// scripts/pw-cdn.cjs, and every page fails the test on an uncaught page
// error. Import `test` and `expect` from here instead of @playwright/test.
//
// Seed accounts (db/seed/dev.sql), password Dev@12345:
//   super@clinicsys.test                         Super Admin
//   <role>@demo-physio.test, <role>@demo-dental.test
//     role: admin | receptionist | doctor | therapist
//   receptionist2@<slug>.test                    both branches
// E-mails sent by the API (invitations, resets) are JSON files in
// api/.outbox-<E2E_API_PORT>/ — see readOutbox().
const fs = require("fs");
const path = require("path");
const base = require("@playwright/test");
const { routeCdn } = require("../scripts/pw-cdn.cjs");

const PASSWORD = "Dev@12345";

const test = base.test.extend({
  context: async ({ context }, use) => {
    await routeCdn(context);
    await use(context);
  },
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(page);
    base.expect(errors, "uncaught page errors").toEqual([]);
  },
});

function outboxDir() {
  return path.resolve(__dirname, "..", "api", `.outbox-${process.env.E2E_API_PORT || 3200}`);
}

// All e-mails sent so far, oldest first, as parsed JSON objects.
function readOutbox() {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return [];
  // A mail the API is still writing can be truncated JSON; skip it — the
  // caller polls (expect.poll) until the full file is there.
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
    .filter(Boolean);
}

// First URL in the newest e-mail sent to `to` (e.g. an invitation link).
function lastLinkTo(to) {
  const mail = readOutbox().reverse().find((m) => JSON.stringify(m.to || "").includes(to));
  if (!mail) return null;
  const m = String(mail.text || mail.html || "").match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

module.exports = { test, expect: base.expect, PASSWORD, readOutbox, lastLinkTo };
