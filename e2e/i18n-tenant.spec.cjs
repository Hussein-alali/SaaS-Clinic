// The entry screens in English (docs/06 task 3.29; docs/03 S01-S06): clinic
// status pages S06, the clinic sign-in S02 (its form is src/ui.jsx; its
// messages, notice and language corner are src/tenant.jsx / supabase.jsx),
// the main-site sign-in S01 and clinic picker S04, invitation acceptance
// S03, password reset and the ?import=1 page; the bilingual e-mails
// (X-Lang first); switching the language from an entry screen.
//
// Every screen drawn by src/tenant.jsx must have no Arabic left in its
// interface (untranslatedUi) and none in its page text either (bodyArabic,
// which also reads paragraphs), apart from data: clinic names and the
// names this spec creates. On S02 and the ?import=1 page only the runs that
// come from this area's sources count (pageLeftovers): the form of S02 and
// the sign-in of ?import=1 are AuthScreen (src/ui.jsx), checked by
// e2e/i18n-shell.spec.cjs.
const fs = require("fs");
const path = require("path");
const { test, expect, PASSWORD, readOutbox, untranslatedUi, missingKeys } = require("./fixtures.cjs");

const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const DENTAL = "عيادة الأسنان التجريبية";
const DATA = [PHYSIO, DENTAL];
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// This area's sources (code, not comments): a leftover Arabic run counts
// on the shared screens only when it comes from one of them.
const AREA_SOURCES = ["tenant.jsx", "supabase.jsx", "apiclient.jsx", "import.jsx"]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).join("\n")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const inAreaSources = (run) => {
  const esc = run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^؀-ۿ])" + esc + "([^؀-ۿ]|$)").test(AREA_SOURCES);
};

// Arabic runs anywhere in the page text (not only the controls
// untranslatedUi reads), the language switch and `allow` (data) aside.
async function bodyArabic(page, allow = []) {
  const runs = await page.evaluate(() => {
    const AR = /[؀-ۿ][؀-ۿ\s،؛؟«»\-–—.:]*[؀-ۿ]|[؀-ۿ]/g;
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("[data-lang-switch], script, style, datalist").forEach((el) => el.remove());
    return (clone.innerText || clone.textContent || "").match(AR) || [];
  });
  return [...new Set(runs.map((r) => r.trim()))].filter((r) => r && !allow.some((a) => a.includes(r) || r.includes(a)));
}

// The strict checks of a screen drawn entirely by this area.
async function expectNoArabic(page, allow = []) {
  expect(await missingKeys(page), "tt() keys without English").toEqual([]);
  expect(await untranslatedUi(page, allow), "Arabic left in the interface").toEqual([]);
  expect(await bodyArabic(page, allow), "Arabic left in the page text").toEqual([]);
}

// The checks of a shared screen: only this area's leftovers and keys.
async function expectNoAreaArabic(page, allow = []) {
  expect((await missingKeys(page)).filter((k) => AREA_SOURCES.includes(JSON.stringify(k))), "tt() keys without English").toEqual([]);
  expect((await untranslatedUi(page, allow)).filter(inAreaSources), "Arabic left in the interface").toEqual([]);
}

async function expectEnglish(page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
}

// The language switch: visible, names the other language, 44px target.
async function expectSwitch(page, other = "ar") {
  const sw = page.locator(`[data-lang-switch=${other}]`);
  await expect(sw).toBeVisible();
  await expect(sw).toHaveText(other === "ar" ? "العربية" : "English");
  const box = await sw.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  return { sw, box };
}

// An API client signed in as `email` (its own cookie jar); `lang` is sent
// as X-Lang like the browser client does.
async function apiAs(playwright, baseURL, email, { platform = false, org = null, lang = null } = {}) {
  const headers = { "X-Requested-With": "clinicsys" };
  if (platform) headers["X-Platform"] = "1";
  if (org) headers["X-Org-Slug"] = org;
  if (lang) headers["X-Lang"] = lang;
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  const r = await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(r.status(), `API login ${email}`).toBe(200);
  return ctx;
}

async function orgIdOf(superAdmin, slug) {
  const r = await superAdmin.get(`/api/platform/organizations?q=${encodeURIComponent(slug)}`);
  expect(r.status()).toBe(200);
  const org = (await r.json()).data.find((o) => o.slug === slug);
  expect(org, `organization ${slug}`).toBeTruthy();
  return org.id;
}

// The newest e-mail to `to` among those sent after `after` e-mails, once
// it carries a link matching `re` (the API may send after answering).
async function waitForMail(to, re, after) {
  for (let i = 0; i < 75; i++) {
    const mail = readOutbox().slice(after).reverse().find((m) => m.to === to && re.test(String(m.text)));
    if (mail) return mail;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no e-mail to ${to}`);
}
const firstLink = (mail) => String(mail.text).match(/https?:\/\/[^\s"'<>]+/)[0];

// Both languages in one e-mail, `first` first (docs/02 "اللغات").
function expectBilingual(mail, first) {
  const [en, ar] = [/^(Invitation to join|Reset your password)/, /^(دعوة للانضمام إلى|إعادة تعيين كلمة المرور)/];
  expect(mail.subject).toMatch(first === "en" ? en : ar);
  expect(mail.subject).toMatch(/ \/ .+ — ClinicSystem EG$/);
  const arAt = String(mail.text).search(/[؀-ۿ]/);
  const enAt = String(mail.text).search(/You (have been invited|asked to reset)/);
  expect(arAt).toBeGreaterThanOrEqual(0);
  expect(enAt).toBeGreaterThanOrEqual(0);
  expect(first === "en" ? enAt < arAt : arAt < enAt, `${first} first in the text`).toBe(true);
  const sections = [...String(mail.html).matchAll(/<div dir="(rtl|ltr)" lang="(ar|en)"/g)].map((m) => m[2] + ":" + m[1]);
  expect(sections).toEqual(first === "en" ? ["en:ltr", "ar:rtl"] : ["ar:rtl", "en:ltr"]);
}

// A new account that is a member of `slug` only (clinic admin invitation
// accepted through the API), so a test may change it freely.
async function newMember(playwright, baseURL, slug, role, branchId, prefix) {
  const email = `${prefix}-${uniq()}@e2e.test`;
  const admin = await apiAs(playwright, baseURL, `admin@${slug}.test`, { org: slug });
  const mark = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email, role, branch_ids: [branchId] } });
  expect(inv.status(), await inv.text()).toBe(201);
  const token = new URL(firstLink(await waitForMail(email, /\?invite=/, mark))).searchParams.get("invite");
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys" } });
  const acc = await anon.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { data: { name: `حساب ${prefix}`, password: PASSWORD } });
  expect(acc.status(), await acc.text()).toBe(200);
  return email;
}

// Makes `email` an active member of `slug` too, unless it already is.
async function ensureMemberOf(playwright, baseURL, email, slug, role, branchIds) {
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const id = await orgIdOf(sa, slug);
  const before = readOutbox().length;
  const inv = await sa.post(`/api/platform/organizations/${id}/invitations`, { data: { email, role, branch_ids: branchIds } });
  const body = await inv.json();
  if (inv.status() === 409 && body.error.code === "already_member") return;
  expect(inv.status(), JSON.stringify(body)).toBe(201);
  const token = new URL(firstLink(await waitForMail(email, /\?invite=/, before))).searchParams.get("invite");
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys" } });
  const acc = await anon.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { data: { password: PASSWORD } });
  expect(acc.status(), await acc.text()).toBe(200);
}

async function rootLogin(page, email, password = PASSWORD) {
  await page.locator("#root-email").fill(email);
  await page.locator("#root-password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// ── S06: status pages ───────────────────────────────────────────────────
test("S06 in English: unknown, pending and suspended clinic pages", async ({ page, playwright, baseURL }) => {
  await page.goto("/?org=no-such-clinic&lang=en");
  await expectEnglish(page);
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "not-found");
  await expect(page.getByRole("heading", { name: "No clinic at this address" })).toBeVisible();
  await expect(page.getByText("Check that the address is typed exactly as you received it, or go back to the main site.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Main site" })).toBeVisible();
  await expect(page).toHaveTitle("No clinic at this address — ClinicSystem EG");
  // The switch sits in the top end corner (right in English).
  const { box } = await expectSwitch(page);
  expect(box.y).toBeLessThan(30);
  expect(box.x + box.width).toBeGreaterThan(page.viewportSize().width - 30);
  await expectNoArabic(page);

  // A clinic waiting for its first admin.
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const slug = `e2e-en-${uniq()}`;
  const created = await sa.post("/api/platform/organizations", {
    data: { name: "عيادة الاختبار الإنجليزي", slug, specialty_code: "physio", admin_email: `owner-${uniq()}@e2e.test` },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto(`/?org=${slug}`); // English is remembered without ?lang=
  await expectEnglish(page);
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "pending");
  await expect(page.getByRole("heading", { name: "Clinic awaiting activation" })).toBeVisible();
  await expectNoArabic(page);

  const id = await orgIdOf(sa, "demo-dental");
  const off = await sa.post(`/api/platform/organizations/${id}/status`, { data: { status: "suspended", reason: "e2e" } });
  expect(off.status()).toBe(200);
  try {
    await page.goto("/?org=demo-dental");
    await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "suspended");
    await expect(page.getByRole("heading", { name: "Clinic suspended" })).toBeVisible();
    await expect(page.getByText("This clinic is currently suspended. Contact the platform team.")).toBeVisible();
    await expect(page.locator("#login-email")).toHaveCount(0);
    await expectNoArabic(page);
  } finally {
    expect((await sa.post(`/api/platform/organizations/${id}/status`, { data: { status: "active" } })).status()).toBe(200);
  }

  // No connection: the error page and its retry.
  await page.route("**/api/orgs/resolve*", (route) => route.abort("failed"));
  await page.goto("/?org=demo-physio");
  await expect(page.getByRole("heading", { name: "Couldn't reach the server" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectNoArabic(page);
  await page.unroute("**/api/orgs/resolve*");
});

// ── S02: the clinic sign-in ─────────────────────────────────────────────
test("S02 in English: language corner, Tab order (3.22), validation and wrong-password messages", async ({ page }) => {
  await page.goto("/?org=demo-physio&lang=en");
  await expectEnglish(page);
  await expect(page.locator("#login-email")).toBeVisible();
  await expect(page.locator("label[for=login-password]")).toHaveText("Password");
  const { box } = await expectSwitch(page);
  expect(box.y).toBeLessThan(30);

  // e-mail → password → (show password) → … → «Forgot password?» → sign in.
  await page.locator("#login-email").focus();
  const order = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (el.id) return el.id;
      if (el.type === "submit") return "submit";
      if (el.classList.contains("auth-link")) return "forgot";
      return el.type || el.tagName;
    }));
  }
  expect(order[0]).toBe("login-password");
  expect(order.indexOf("forgot")).toBeGreaterThan(0);
  expect(order.indexOf("submit")).toBeGreaterThan(order.indexOf("forgot"));

  // Local checks, then the API's answer (src/supabase.jsx __AUTH_ERRORS).
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".tenant-notice")).toHaveText("Enter a valid email address");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".tenant-notice")).toHaveText("Enter your password");
  await page.locator("#login-password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".tenant-notice")).toHaveText("Wrong email or password");
  await expectNoAreaArabic(page, DATA);

  // An account of another clinic: the membership refusal (tenantLoginVerdict).
  await page.goto("/?org=demo-dental");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".tenant-notice")).toHaveText("You don't have an active membership in this clinic. If your membership was deactivated, contact the clinic admin.");
  await expectNoAreaArabic(page, DATA);
});

// ── S01 + S04: the main site and the clinic picker ──────────────────────
test("S01 + S04 in English: main-site sign-in, its errors, the picker of a member of two clinics", async ({ page, playwright, baseURL }) => {
  const email = "receptionist2@demo-physio.test";
  await ensureMemberOf(playwright, baseURL, email, "demo-dental", "receptionist", ["br-demo-dental-1"]);
  await page.goto("/?lang=en");
  await expectEnglish(page);
  await expect(page).toHaveTitle("ClinicSystem EG — Clinic management system");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("Access by invitation from the clinic admin only")).toBeVisible();
  await expect(page.getByText("Your whole clinic, in one place.")).toBeVisible();
  await expectSwitch(page);
  await expectNoArabic(page);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#root-email-error")).toHaveText("Enter a valid email address");
  await expect(page.locator("#root-password-error")).toHaveText("Enter your password");
  await rootLogin(page, email, "not-the-password");
  await expect(page.locator(".tenant-notice")).toHaveText("Wrong email or password");
  await expectNoArabic(page);

  await rootLogin(page, email);
  await expect(page.getByRole("heading", { name: "Choose a clinic" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your clinics" })).toBeVisible();
  const cards = page.locator(".tenant-clinic-card");
  await expect(cards).toHaveCount(2);
  const dental = cards.filter({ hasText: DENTAL });
  await expect(dental).toContainText("Dentistry");
  await expect(dental).toContainText("Receptionist");
  await expect(cards.filter({ hasText: PHYSIO })).toContainText("Physiotherapy");
  // «Open» points to the end of the line: → in English.
  await expect(dental.locator("svg path").last()).toHaveAttribute("d", /^M5 12h14/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expectNoArabic(page, DATA);
  await dental.click();
  await page.waitForURL(/\/\?org=demo-dental(#\/[a-z]+)?$/);
  await expectEnglish(page);
});

test("S06 no-clinic in English: a Super Admin on the main site", async ({ page }) => {
  await page.goto("/?lang=en");
  await rootLogin(page, "super@clinicsys.test");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "no-clinic");
  await expect(page.getByText("You're a Super Admin: you can open the platform panel.")).toBeVisible();
  await expect(page.getByText("Account: super@clinicsys.test")).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform panel" })).toBeVisible();
  await expectNoArabic(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#root-email")).toBeVisible();
});

// ── S03: invitations, and their bilingual e-mail ────────────────────────
test("S03 in English: a new account accepts an invitation; the e-mail is bilingual, the inviter's language first", async ({ page, playwright, baseURL }) => {
  const en = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio", lang: "en" });
  const ar = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio" });
  const email = `en-therapist-${uniq()}@e2e.test`;
  const other = `ar-therapist-${uniq()}@e2e.test`;
  const before = readOutbox().length;
  const inv = await en.post("/api/org/invitations", { data: { email, role: "therapist", branch_ids: ["br-demo-physio-1"] } });
  expect(inv.status(), await inv.text()).toBe(201);
  const inv2 = await ar.post("/api/org/invitations", { data: { email: other, role: "therapist", branch_ids: ["br-demo-physio-1"] } });
  expect(inv2.status(), await inv2.text()).toBe(201);
  const mail = await waitForMail(email, /\?invite=/, before);
  expectBilingual(mail, "en");
  expect(mail.text).toContain(" as Therapist.");
  expectBilingual(await waitForMail(other, /\?invite=/, before), "ar");
  expect((await ar.delete(`/api/org/invitations/${(await inv2.json()).invitation.id}`)).status()).toBe(204);

  await page.goto(firstLink(mail) + "&lang=en");
  await expectEnglish(page);
  await expect(page.getByRole("heading", { name: "Accept invitation" })).toBeVisible();
  await expect(page).toHaveTitle(`Invitation to join ${PHYSIO} — ClinicSystem EG`);
  const summary = page.locator(".tenant-invite-summary");
  await expect(summary).toContainText("Clinic");
  await expect(summary).toContainText("Role");
  await expect(summary).toContainText("Therapist");
  await expect(summary).toContainText(email);
  await expectSwitch(page);
  await expectNoArabic(page, DATA);

  const submit = page.getByRole("button", { name: "Activate account and sign in" });
  await submit.click();
  await expect(page.locator("#invite-name-error")).toHaveText("Enter your full name");
  await expect(page.locator("#invite-password-error")).toHaveText("Password must be at least 6 characters");
  await page.locator("#invite-name").fill("Invited Therapist");
  await page.locator("#invite-password").fill("Secret123");
  await page.locator("#invite-confirm").fill("Secret124");
  await submit.click();
  await expect(page.locator("#invite-confirm-error")).toHaveText("The passwords don't match");
  await expectNoArabic(page, DATA);
  await page.locator("#invite-confirm").fill("Secret123");
  await submit.click();
  await page.waitForURL(/\/\?org=demo-physio(#\/[a-z]+)?$/);
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await expectEnglish(page);

  // Used once: the status page in English.
  await page.goto(firstLink(mail));
  await expect(page.getByRole("heading", { name: "This invitation has already been used" })).toBeVisible();
  await expectNoArabic(page);
  // Same address as the e-mail's link (demo-physio.localhost in development:
  // another origin than localhost, with its own saved language).
  await page.goto(new URL(firstLink(mail)).origin + "/?invite=" + "x".repeat(43));
  await expect(page.getByRole("heading", { name: "Invalid invitation link" })).toBeVisible();
  await expectNoArabic(page);
});

test("S03 in English: an existing account joins with its own password", async ({ page, playwright, baseURL }) => {
  const email = await newMember(playwright, baseURL, "demo-dental", "doctor", "br-demo-dental-1", "en-doctor");
  const admin = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio", lang: "en" });
  const before = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email, role: "doctor", branch_ids: ["br-demo-physio-1"] } });
  expect(inv.status(), await inv.text()).toBe(201);
  await page.goto(firstLink(await waitForMail(email, /\?invite=/, before)) + "&lang=en");
  await expect(page.locator("form[data-mode=existing]")).toBeVisible();
  await expect(page.getByText("You already have an account with this email.")).toBeVisible();
  await expect(page.locator("label[for=invite-password]")).toContainText("Your account password");
  await page.locator("#invite-password").fill("wrong-password");
  await page.getByRole("button", { name: "Accept and sign in" }).click();
  await expect(page.locator("#invite-password-error")).toHaveText("Wrong password for this account");
  await expectNoArabic(page, DATA);
});

// ── Password reset ──────────────────────────────────────────────────────
test("password reset in English: request, bilingual e-mail (English first), new password, success message", async ({ page, playwright, baseURL }) => {
  const email = await newMember(playwright, baseURL, "demo-dental", "therapist", "br-demo-dental-1", "en-reset");
  await page.goto("/?lang=en");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await page.locator("#forgot-email").fill("not an e-mail");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.locator("#forgot-email-error")).toHaveText("Enter a valid email address");
  // «Back» points back: ← in English.
  await expect(page.getByRole("button", { name: "Back to sign in" }).locator("svg path").last()).toHaveAttribute("d", /^M19 12H5/);
  await expectNoArabic(page);

  const before = readOutbox().length;
  await page.locator("#forgot-email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.locator(".tenant-notice")).toContainText("If this email address is registered");
  await expectNoArabic(page);
  const mail = await waitForMail(email, /\?reset=/, before);
  expectBilingual(mail, "en");

  await page.goto(firstLink(mail));
  await expectEnglish(page);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await expect(page).toHaveTitle("New password — ClinicSystem EG");
  await expectSwitch(page);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator("#reset-password-error")).toHaveText("Password must be at least 6 characters");
  await page.locator("#reset-password").fill("NewPass123");
  await page.locator("#reset-confirm").fill("NewPass12");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator("#reset-confirm-error")).toHaveText("The passwords don't match");
  await expectNoArabic(page);
  await page.locator("#reset-confirm").fill("NewPass123");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator(".tenant-notice")).toHaveText("Your password was changed. Sign in with the new password.");
  await expectNoArabic(page);

  // The link works once.
  await page.goto(firstLink(mail));
  await page.locator("#reset-password").fill("Another123");
  await page.locator("#reset-confirm").fill("Another123");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator(".tenant-notice")).toContainText("The reset link is invalid or has expired");
  await expectNoArabic(page);
});

// ── ?import=1 ───────────────────────────────────────────────────────────
test("?import=1 in English after its own sign-in", async ({ page }) => {
  await page.goto("/?org=demo-physio&import=1&lang=en");
  await page.locator("#login-email").fill("receptionist@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Historical patient entry")).toBeVisible();
  await expectEnglish(page);
  await expect(page.getByRole("button", { name: "Save and continue" })).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Name is required")).toBeVisible();
  await expect(page.getByText("Phone number is required")).toBeVisible();
  await expectSwitch(page);
  await expectNoAreaArabic(page, DATA);
  expect(await bodyArabic(page, DATA)).toEqual([]);
});

// ── Switching the language from an entry screen ─────────────────────────
test("language switch: from Arabic to English on the main site, kept on the next pages, and back", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  const { box } = await expectSwitch(page, "en");
  // Top end corner: the left in Arabic.
  expect(box.x).toBeLessThan(30);
  expect(box.y).toBeLessThan(30);
  await page.locator("[data-lang-switch=en]").click();
  await expectEnglish(page);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("clinicsys.lang"))).toBe("en");

  // Kept on other entry screens, with no ?lang= in the address.
  await page.goto("/?org=no-such-clinic");
  await expectEnglish(page);
  await expect(page.getByRole("heading", { name: "No clinic at this address" })).toBeVisible();
  await page.goto("/?org=demo-physio");
  await expectEnglish(page);
  await expect(page.locator("label[for=login-password]")).toHaveText("Password");

  // And back to Arabic from the clinic sign-in; ?lang= is dropped.
  await page.goto("/?org=demo-physio&lang=en");
  await page.locator("[data-lang-switch=ar]").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(new URL(page.url()).searchParams.get("lang")).toBeNull();
  await page.goto("/?org=no-such-clinic");
  await expect(page.getByRole("heading", { name: "لا توجد عيادة بهذا الرابط" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("clinicsys.lang"))).toBe("ar");
});

test("phones (390×844): the switch is a 44px target on the brand bar and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ["/?lang=en", "/?org=no-such-clinic", "/?org=demo-physio", "/?invite=" + "x".repeat(43), "/?lang=ar"]) {
    await page.goto(url);
    await expect(page.locator("main, .tenant-status").first()).toBeVisible();
    const sw = page.locator("[data-lang-switch]");
    await expect(sw).toBeVisible();
    const box = await sw.boundingBox();
    expect(box.height, url).toBeGreaterThanOrEqual(44);
    expect(box.y, url).toBeLessThan(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), url).toBeLessThanOrEqual(390);
  }
});
