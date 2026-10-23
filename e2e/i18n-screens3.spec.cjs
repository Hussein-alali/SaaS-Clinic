// English interface of src/screens3.jsx (dictionary src/lang/en-screens3.jsx;
// docs/06 task 3.29) and the owner decisions in that file: the «no
// permission» page (3.11), the shared Segmented / CardTable (3.24, 3.20)
// and the demo patient portal in both languages (3.25).
//
//   E2E_DB_PORT=57400 E2E_API_PORT=3940 npx playwright test -c e2e/playwright.config.cjs e2e/i18n-screens3.spec.cjs
//
// Screens: the first-use checklist, branches C07, settings C08 (clinic
// details, branding, departments and team with their dialogs), staff and
// invitations C06 with all their dialogs, a custom section and NotFound,
// the top bar's language switch, the 403 page, the demo patient portal
// and its booking flow, and the guest booking from the demo sign-in.
// Most of it runs on a clinic of its own (created through /api/platform),
// so the first-use checklist shows and invitations do not touch the
// seeded clinics.
//
// Other agents translate the rest of the app at the same time, so the
// checks look at this file's text only: a leftover Arabic run counts when
// the sources of src/screens3.jsx contain it as whole words, and a missing
// key counts when it is a literal of this file. Arabic that is data is
// allowed (seed rows, the new clinic's main branch «الفرع الرئيسي»).
// I18N_SHOTS=<dir> also saves a screenshot of every screen there.
const fs = require("fs");
const path = require("path");
const { test, expect, PASSWORD, readOutbox, untranslatedUi, missingKeys } = require("./fixtures.cjs");

test.describe.configure({ mode: "serial" });

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "screens3.jsx"), "utf8");
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const SLUG = `en3-${RUN}`;
const ADMIN = `en3-admin-${RUN}@e2e.test`;
const INVITEE = `en3-invite-${RUN}@e2e.test`;
const CREATED = `en3-user-${RUN}@e2e.test`;
const DATA = ["الفرع الرئيسي"];

// ── helpers ─────────────────────────────────────────────────────────────
function inSource(run) {
  const esc = run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^؀-ۿ])" + esc + "([^؀-ۿ]|$)").test(SRC);
}
async function shot(page, name) {
  if (!process.env.I18N_SHOTS) return;
  const vp = page.viewportSize();
  await page.screenshot({ path: path.join(process.env.I18N_SHOTS, `screens3-en-${vp.width}-${name}.png`), fullPage: true });
}
// The page is English, left-to-right, and this file left no Arabic in it.
async function expectEnglish(page, name, allow = []) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  const missing = (await missingKeys(page)).filter((k) => SRC.includes(JSON.stringify(k)));
  expect(missing, `missing English keys on ${name}`).toEqual([]);
  const left = (await untranslatedUi(page, DATA.concat(allow))).filter(inSource);
  expect(left, `Arabic left on ${name}`).toEqual([]);
  await shot(page, name);
}
const noHorizontalScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);

async function apiAs(playwright, baseURL, email, { platform = false } = {}) {
  const headers = { "X-Requested-With": "clinicsys" };
  if (platform) headers["X-Platform"] = "1";
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  const r = await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(r.status(), `API login ${email}`).toBe(200);
  return ctx;
}
async function waitForInvite(to, after) {
  let link = null;
  await expect.poll(() => {
    const mails = readOutbox().slice(after).filter((m) => JSON.stringify(m.to || "").includes(to));
    const links = mails.map((m) => (String(m.text || m.html || "").match(/https?:\/\/[^\s"'<>]+/) || [])[0]).filter((l) => l && /\?invite=/.test(l));
    link = links.length ? links[links.length - 1] : null;
    return !!link;
  }, { message: `invitation e-mail to ${to}`, timeout: 15_000 }).toBe(true);
  return link;
}

async function signIn(page, email, url) {
  await page.goto(url);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("#login-password").press("Enter");
  await expect(page.locator("#clinic-main")).toBeVisible();
}
const openSettingsTab = async (page, tab) => {
  await page.locator('aside.sidebar [data-route="settings"]').click();
  await page.locator(`[data-settings-tab="${tab}"]`).click();
};
const dialog = (page) => page.getByRole("dialog");
// A toast (src/ui.jsx Toast: role status, or alert for an error).
const toast = (page, text) => page.locator("[role=status], [role=alert]").filter({ hasText: text });
async function closeDialog(page, button = "Cancel") {
  await dialog(page).getByRole("button", { name: button, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

// ── a clinic of this spec's own ─────────────────────────────────────────
test.beforeAll(async ({ playwright, baseURL }) => {
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const plan = await sa.post("/api/platform/plans", { data: { code: `en3-${RUN}`, name: `English plan ${RUN}`, max_branches: null, max_users: null } });
  expect(plan.status(), await plan.text()).toBe(201);
  const mark = readOutbox().length;
  const created = await sa.post("/api/platform/organizations", {
    data: { name: `English clinic ${RUN}`, slug: SLUG, specialty_code: "physio", plan_id: (await plan.json()).id, admin_email: ADMIN },
  });
  expect(created.status(), await created.text()).toBe(201);
  const token = new URL(await waitForInvite(ADMIN, mark)).searchParams.get("invite");
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys" } });
  const r = await anon.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { data: { name: "Clinic Owner", password: PASSWORD } });
  expect(r.status(), await r.text()).toBe(200);
});

const clinicUrl = (hash = "") => `/?org=${SLUG}&lang=en${hash}`;

// ── first use, branches, settings ───────────────────────────────────────
test("the first-use checklist and branches C07 in English (weekday names, deactivate dialog)", async ({ page }) => {
  await signIn(page, ADMIN, clinicUrl());
  const box = page.locator("[data-onboarding]");
  await expect(box).toHaveAttribute("data-onboarding", "open");
  await expect(box.getByRole("heading", { name: "Get started" })).toBeVisible();
  await expect(box.locator("[data-onboarding-progress]")).toContainText(/\d of \d done/);
  await expect(box.locator('[data-step="branch"]')).toContainText("Complete the first branch’s details");
  await expectEnglish(page, "onboarding");
  await box.getByRole("button", { name: "Later" }).click();
  await expect(box).toHaveAttribute("data-onboarding", "folded");
  await expectEnglish(page, "onboarding-folded");
  await box.getByRole("button", { name: "Continue setup" }).click();
  await expect(box).toHaveAttribute("data-onboarding", "open");

  // A second branch with hours, so a card shows weekday names and can be deactivated.
  await page.evaluate(() => window.addBranch({ name: "Nile branch", address: "1 Nile Street", phone: "0100000000", rooms: 3,
    working_hours: { sun: ["09:00", "17:00"], mon: ["09:00", "17:00"], fri: ["10:00", "14:00"] } }));
  await page.locator('aside.sidebar [data-route="branches"]').click();
  await expect(page.getByRole("heading", { name: "Branches", level: 1 })).toBeVisible();
  await expect(page.getByTestId("branch-counter")).toHaveText(/Active branches:\s*2/);
  const nile = page.locator("[data-branch-card]").filter({ hasText: "Nile branch" });
  await expect(nile.locator(".branch-card-hours")).toContainText("Sunday, Monday: 09:00–17:00");
  await expect(nile.locator(".branch-card-hours")).toContainText("Friday: 10:00–14:00");
  await expect(nile.locator(".branch-card-hours")).toContainText("Other days: closed");
  await expect(nile).toContainText("Rooms: 3");
  await expectEnglish(page, "branches");
  await nile.getByRole("button", { name: "Deactivate Nile branch" }).click();
  await expect(dialog(page)).toContainText("Nile branch will leave the branch list");
  await expect(dialog(page).getByRole("button", { name: "Deactivate branch" })).toBeVisible();
  await expectEnglish(page, "branch-deactivate");
  await closeDialog(page, "Back");
  await nile.getByRole("button", { name: "Edit Nile branch" }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("settings C08 in English: clinic details, branding, departments and team with their dialogs", async ({ page }) => {
  await signIn(page, ADMIN, clinicUrl());
  await openSettingsTab(page, "clinic");
  await expect(page.getByRole("tablist", { name: "Settings sections" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Clinic details" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Session length (minutes)")).toBeVisible();
  await expect(page.locator("option", { hasText: "Egyptian pound (EGP)" })).toHaveCount(1);
  await expectEnglish(page, "settings-clinic");

  await page.locator('[data-settings-tab="branding"]').click();
  await expect(page.getByRole("button", { name: "Upload logo" })).toBeVisible();
  await expectEnglish(page, "settings-branding");

  await page.locator('[data-settings-tab="depts"]').click();
  for (const h of ["Departments", "Doctors", "Therapists", "Receptionists"]) await expect(page.getByText(h, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No departments yet")).toBeVisible();
  await expectEnglish(page, "settings-depts");
  // Each roster's «add» dialog.
  for (const [button, title] of [["Add department", "New department"], ["Add doctor", "New doctor"], ["Add therapist", "New therapist"], ["Add receptionist", "New receptionist"]]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(dialog(page)).toContainText(title);
    if (button !== "Add department") await expect(dialog(page)).toContainText(/No unlinked accounts with this role yet|Choose a linked account/);
    await expectEnglish(page, "dialog-" + button.replace(/ /g, "-").toLowerCase());
    await closeDialog(page);
  }
  // A department, so its row and the doctor dialog's department list show.
  await page.getByRole("button", { name: "Add department", exact: true }).click();
  await dialog(page).getByLabel("Name in Arabic").fill("Rehab");
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Department added")).toBeVisible();
  await expect(page.locator("table").first()).toContainText("Rehab");
  await expectEnglish(page, "settings-depts-row");
});

test("staff and invitations C06 in English: counter, filter, invite, create user and every member dialog", async ({ page }) => {
  await signIn(page, ADMIN, clinicUrl());
  await openSettingsTab(page, "users");
  await expect(page.getByTestId("users-counter")).toContainText(/Users: 1/);
  await expect(page.locator(".members-table tbody tr[data-member]").first()).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter invitations" })).toBeVisible();
  await expectEnglish(page, "staff");

  // Invite (the e-mail status badge class stays invite-sending / invite-unsent).
  await page.getByRole("button", { name: "Invite staff member" }).click();
  await expect(dialog(page)).toContainText("valid for 7 days");
  await dialog(page).getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog(page)).toContainText("Enter the email address");
  await expectEnglish(page, "dialog-invite");
  await dialog(page).locator("#staff-invite-email").fill(INVITEE);
  await dialog(page).getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(toast(page, /Invitation (sent to|created)/)).toBeVisible();
  const inv = page.locator(`tr[data-invite="${INVITEE}"]`);
  await expect(inv).toContainText("Pending");
  await expect(inv).toContainText("Receptionist");
  await page.getByRole("button", { name: /All invitations/ }).click();
  await expect(page.getByRole("button", { name: /All invitations/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Awaiting acceptance/ }).click();
  await expectEnglish(page, "staff-invited", [INVITEE]);
  await inv.getByRole("button", { name: `Revoke the invitation to ${INVITEE}` }).click();
  await expect(dialog(page)).toContainText("will stop working");
  await expectEnglish(page, "dialog-revoke");
  await closeDialog(page, "Back");

  // Create a user, then every dialog of that member's row menu.
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(dialog(page)).toContainText("Create a new user");
  await expectEnglish(page, "dialog-create-user");
  await dialog(page).getByLabel("Full name").fill("Mona Ali");
  await dialog(page).getByLabel("Email", { exact: true }).fill(CREATED);
  await dialog(page).getByLabel("Password", { exact: true }).fill(PASSWORD);
  await dialog(page).getByRole("button", { name: "Create account" }).click();
  await expect(dialog(page)).toHaveCount(0);
  const row = page.locator(`tr[data-member="${CREATED}"]`);
  await expect(row).toContainText("Receptionist");
  await expect(row).toContainText("Active");
  const menu = async (item) => {
    await row.getByRole("button", { name: "More" }).click();
    await page.locator(".row-menu-pop").getByRole("button", { name: item, exact: true }).click();
    await expect(dialog(page)).toBeVisible();
  };
  await menu("Edit role and branches");
  await expect(dialog(page)).toContainText("Edit Mona Ali");
  await dialog(page).locator("#member-role").selectOption("doctor");
  await expect(dialog(page)).toContainText("Changing the role ends");
  await expectEnglish(page, "dialog-edit-member", ["Mona Ali"]);
  await closeDialog(page);
  await menu("Edit name");
  await expectEnglish(page, "dialog-edit-name");
  await closeDialog(page);
  await menu("Reset password");
  await expect(dialog(page)).toContainText("Reset password — Mona Ali");
  const pw = dialog(page).locator("input[type=password]");
  await pw.nth(0).fill("Abc@12345");
  await pw.nth(1).fill("Abc@12345");
  await expectEnglish(page, "dialog-reset");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page)).toContainText("Confirm the reset");
  await expectEnglish(page, "dialog-reset-confirm");
  // Cancel goes back to the password step; Esc closes it.
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toContainText("Reset password — Mona Ali");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await menu("Deactivate account");
  await expect(dialog(page)).toContainText("will be blocked from the clinic");
  await expectEnglish(page, "dialog-deactivate");
  await closeDialog(page, "Back");

  // My own account.
  await page.getByRole("button", { name: "Edit my name" }).first().click();
  await expect(dialog(page)).toContainText("Edit my profile");
  await closeDialog(page);
  await page.getByRole("button", { name: "Change password" }).first().click();
  await expect(dialog(page)).toContainText("New password");
  await expectEnglish(page, "dialog-change-password");
  await closeDialog(page);
});

test("phones (390×844): rosters and staff tables are cards, nothing scrolls sideways, the switch is compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN, clinicUrl());
  await expect(page.locator("[data-lang-switch=ar]")).toHaveText("ع");
  await page.locator(".mobile-menu-btn").click();
  await page.locator('aside.sidebar [data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  const cell = page.locator(`tr[data-member="${CREATED}"] td`).nth(1);
  await expect(cell).toHaveAttribute("data-label", "Role");
  await noHorizontalScroll(page);
  await expectEnglish(page, "staff-phone", ["Mona Ali"]);
  await page.locator('[data-settings-tab="depts"]').click();
  await noHorizontalScroll(page);
  await expectEnglish(page, "depts-phone");
  await page.locator(".mobile-menu-btn").click();
  await page.locator('aside.sidebar [data-route="branches"]').click();
  await noHorizontalScroll(page);
  await expectEnglish(page, "branches-phone");
});

test("NotFound and the top bar's language switch: to Arabic and back", async ({ page }) => {
  await signIn(page, ADMIN, clinicUrl("#/custom:missing"));
  await expect(page.getByRole("heading", { name: "This page is taking a recovery day." })).toBeVisible();
  await expectEnglish(page, "notfound");
  await page.getByRole("button", { name: "Back to the dashboard" }).click();

  const sw = page.locator(".topbar [data-lang-switch]");
  await expect(sw).toHaveAttribute("data-lang-switch", "ar");
  await expect(sw).toHaveAccessibleName("التبديل إلى العربية");
  await sw.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("#clinic-main")).toBeVisible();
  await expect(page.locator(".topbar")).toContainText("متصل");
  await expect(page).not.toHaveURL(/lang=/);
  await page.locator(".topbar [data-lang-switch=en]").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".topbar")).toContainText("Online");
  await expectEnglish(page, "dashboard-again");
});

// ── task 3.11: a page the role may not open ─────────────────────────────
test("3.11 a receptionist opening #/settings or #/branches gets «no permission», the address stays, the button goes home (Arabic)", async ({ page }) => {
  await signIn(page, "receptionist@demo-physio.test", "/?org=demo-physio#/settings");
  const alert = page.getByRole("alert").filter({ hasText: "ليست لديك صلاحية لهذه الصفحة" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("heading", { name: "ليست لديك صلاحية لهذه الصفحة" })).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator("[data-settings-tab]")).toHaveCount(0);
  // The sidebar marks nothing (the page is not one of its items).
  await expect(page.locator('aside.sidebar [data-route="dashboard"].active')).toHaveCount(0);
  await alert.getByRole("button", { name: "العودة إلى لوحة الاستقبال" }).click();
  await expect(page).toHaveURL(/#\/dashboard$/);
  await expect(page.getByRole("alert").filter({ hasText: "ليست لديك صلاحية لهذه الصفحة" })).toHaveCount(0);
  // Back returns to the refused page, which says so again.
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { name: "ليست لديك صلاحية لهذه الصفحة" })).toBeVisible();
  // Something that is not a page at all still goes to the home page.
  await page.goto("/?org=demo-physio#/nothing-here");
  await expect(page.locator("#clinic-main")).toBeVisible();
  await expect(page).toHaveURL(/#\/dashboard$/);
});

test("3.11 in English: a therapist opening #/payments", async ({ page }) => {
  await signIn(page, "therapist@demo-physio.test", "/?org=demo-physio&lang=en#/payments");
  await expect(page.getByRole("heading", { name: "You don’t have permission for this page" })).toBeVisible();
  await expect(page.locator("[data-no-permission]")).toHaveAttribute("role", "alert");
  await expect(page.locator("[data-no-permission]")).toContainText("isn’t available to your role");
  await expect(page).toHaveURL(/#\/payments$/);
  await expectEnglish(page, "no-permission");
  await page.getByRole("button", { name: /^Back to / }).click();
  await expect(page).toHaveURL(/#\/dashboard$/);
});

// ── the demo patient portal (owner decision 3.25) ───────────────────────
const asPatient = (page) => page.addInitScript(() => {
  localStorage.setItem("kinetic.user", JSON.stringify({ name: "Demo Patient", role: "مريض", email: "patient@demo.test" }));
});

test("the demo patient portal in English: every page, the booking flow, the switch", async ({ page }) => {
  await asPatient(page);
  await page.goto("/?demo=1&lang=en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello Demo");
  await expect(page.locator("header")).toContainText("Patient portal");
  await expectEnglish(page, "portal-home");
  for (const [nav, heading] of [["My visits", "My visits"], ["Treatment plan", "Your treatment plan"], ["Messages", "Messages"], ["Invoices", "Invoices"]]) {
    await page.locator("nav.pt-nav").getByRole("button", { name: nav, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expectEnglish(page, "portal-" + nav.replace(/ /g, "-").toLowerCase());
  }
  await page.getByRole("button", { name: "My account" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "My profile" })).toBeVisible();
  await expect(page.getByText("Date of birth")).toBeVisible();
  await expectEnglish(page, "portal-profile");
  await page.getByRole("button", { name: "Edit details" }).click();
  await expectEnglish(page, "portal-profile-edit");
  await closeDialog(page);

  // Booking: reason → therapist → day and time → review.
  await page.locator("nav.pt-nav").getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: /Book a visit/ }).first().click();
  const flow = page.getByRole("dialog", { name: "Book a visit" });
  await expect(flow).toContainText("Step 1 of 4");
  await expectEnglish(page, "booking-1");
  await flow.getByRole("button", { name: /A new problem/ }).click();
  await expect(flow).toContainText("Who would you like to see?");
  await expectEnglish(page, "booking-2");
  await flow.getByRole("button", { name: /Any therapist/ }).click();
  await expect(flow).toContainText("What time suits you?");
  // Pick the first open day and time (the day tiles use the locale's short names).
  const days = flow.locator(".quarter-sm button:not([disabled])");
  await days.last().click();
  await flow.locator("button.mono:not([disabled])").first().click();
  await expectEnglish(page, "booking-3");
  await flow.getByRole("button", { name: "Continue" }).click();
  await expect(flow).toContainText("Does this look right?");
  await expect(flow).toContainText("Any therapist");
  await expect(flow).toContainText("EGP 850");
  await expectEnglish(page, "booking-4");
  await flow.getByRole("button", { name: "Back" }).click();
  await page.keyboard.press("Escape");
  await expect(flow).toHaveCount(0);

  // The portal's own language switch.
  await page.locator("header [data-lang-switch=ar]").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("header")).toContainText("بوابة المريض");
  await expect(page.locator("nav.pt-nav")).toContainText("الرسائل");
});

test("the demo patient portal in Arabic has no English copy left", async ({ page }) => {
  await asPatient(page);
  await page.goto("/?demo=1&lang=ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const LATIN = /\b(?:next|min|Sessions?|messages|therapist|points|weeks|trend|last|details|file|birth|appointments|Your|with|Kinetic)\b/;
  const english = async () => page.evaluate((src) => {
    const re = new RegExp(src);
    return [...document.querySelectorAll("main, header, nav, [role=dialog]")]
      .map((el) => el.innerText).join("\n").split("\n").filter((l) => re.test(l) && !/^Kinetic$/.test(l.trim()));
  }, LATIN.source);
  expect(await english()).toEqual([]);
  for (const nav of ["زياراتي", "خطة العلاج", "الرسائل", "الفواتير"]) {
    await page.locator("nav.pt-nav").getByRole("button", { name: nav, exact: true }).click();
    expect(await english(), nav).toEqual([]);
  }
  await page.getByRole("button", { name: "حسابي" }).first().click();
  expect(await english(), "حسابي").toEqual([]);
});

test("the guest booking from the demo sign-in, in English", async ({ page }) => {
  await page.goto("/?demo=1&lang=en");
  await page.getByRole("button", { name: /Are you a patient\? Book a visit/ }).click();
  await expect(page.getByText("Let’s get you moving again.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Are you a current patient?" })).toBeVisible();
  await expectEnglish(page, "guest-1");
  await page.getByRole("button", { name: /Sports injury/ }).click();
  await expect(page.getByText("Choose who you would like to see.")).toBeVisible();
  await expectEnglish(page, "guest-2");
  await page.getByRole("button", { name: /Any therapist/ }).click();
  await expect(page.getByText("Choose a day")).toBeVisible();
  await page.locator(".quarter-sm button:not([disabled])").last().click();
  await page.locator("button.mono:not([disabled])").first().click();
  await expectEnglish(page, "guest-3");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Full name").fill("Aya Hassan");
  await page.getByLabel("Mobile (WhatsApp)").fill("+20 100 000 0000");
  await expectEnglish(page, "guest-4");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Ready to confirm.")).toBeVisible();
  await expect(page.getByText("EGP 850 — paid at the clinic")).toBeVisible();
  await expectEnglish(page, "guest-5");
  await page.getByRole("button", { name: "Close" }).click();
});
