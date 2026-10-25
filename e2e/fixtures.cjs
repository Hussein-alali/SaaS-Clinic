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

// ── English interface checks (src/i18n.jsx, docs/06 task 3.29) ──────
// Arabic text that is DATA, not interface: every quoted Arabic literal of
// the seed and of the migrations' seed rows (template library, treatment
// methods...), plus what a test passes in `allow` (names it created).
let seedArabic = null;
function seedCorpus() {
  if (seedArabic) return seedArabic;
  const root = path.join(__dirname, "..");
  const files = [path.join(root, "db", "seed", "dev.sql"), path.join(root, "api", "test", "fixtures", "extras.sql")]
    .concat(fs.readdirSync(path.join(root, "db", "migrations")).map((f) => path.join(root, "db", "migrations", f)));
  seedArabic = files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  // ... and what the Arabic specs type in (names, addresses): .fill("…")
  // arguments and `const x = \`…\`` templates, with ${…} parts removed.
  // They run before the English specs on the same data. (Not getByRole
  // names: those are interface text and must stay detectable.)
  const specs = fs.readdirSync(__dirname).filter((f) => f.endsWith(".spec.cjs") && !f.startsWith("i18n-"));
  const LIT = /(?:\.fill\(|\bconst \w+ = )(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  for (const f of specs) {
    for (const m of fs.readFileSync(path.join(__dirname, f), "utf8").matchAll(LIT)) {
      if (/[\u0600-\u06FF]/.test(m[2])) seedArabic += "\n" + m[2].replace(/\$\{[^}]*\}/g, "\n");
    }
  }
  return seedArabic;
}

// Arabic runs left in the interface of the current page: text of buttons,
// labels, headings, table heads, tabs, menus, badges, options, toasts and
// dialogs' titles, plus placeholder / aria-label / title attributes. A run
// that also appears in the seed data (or in `allow`) is data and is skipped.
async function untranslatedUi(page, allow = []) {
  const found = await page.evaluate(() => {
    const AR = /[\u0600-\u06FF][\u0600-\u06FF\s،؛؟«»\-–—.:]*[\u0600-\u06FF]|[\u0600-\u06FF]/g;
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const out = new Set();
    const SEL = "button, label, h1, h2, h3, h4, th, legend, [role=tab], [role=menuitem], [role=option], nav a, .badge, option, [role=status], [role=alert], .toast, [role=dialog] [id$=-title]";
    for (const el of document.querySelectorAll(SEL)) {
      if (!visible(el) && el.tagName !== "OPTION") continue;
      if (el.closest("[data-lang-switch]")) continue;
      // Avatars (.av) and other decorative parts (aria-hidden) show the
      // initials of a name: data, not interface.
      const DECOR = ".av, [aria-hidden=true]";
      if (el.closest(DECOR)) continue;
      let text = el.innerText || el.textContent || "";
      if (el.querySelector(DECOR)) {
        const copy = el.cloneNode(true);
        copy.querySelectorAll(DECOR).forEach((a) => a.remove());
        text = copy.textContent || "";
      }
      for (const m of text.match(AR) || []) out.add(m.trim());
    }
    for (const el of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
      if (el.closest("[data-lang-switch]")) continue;
      for (const a of ["placeholder", "aria-label", "title"]) {
        const v = el.getAttribute(a);
        if (v) for (const m of v.match(AR) || []) out.add(m.trim());
      }
    }
    return [...out].filter(Boolean);
  });
  const corpus = seedCorpus();
  return found.filter((run) => !corpus.includes(run) && !allow.some((a) => a.includes(run) || run.includes(a)));
}

// Strings that went through tt() without an English translation.
async function missingKeys(page) {
  return page.evaluate(() => [...(window.I18N_MISSING || [])]);
}

module.exports = { test, expect: base.expect, PASSWORD, readOutbox, lastLinkTo, untranslatedUi, missingKeys };
