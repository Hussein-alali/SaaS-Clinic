// English interface of the Super Admin panel (src/platform.jsx, dictionary
// src/lang/en-platform.jsx; docs/06 task 3.29).
//
//   E2E_DB_PORT=57500 E2E_API_PORT=3950 npx playwright test -c e2e/playwright.config.cjs e2e/i18n-platform.spec.cjs
//
// Every screen of the panel is opened with ?lang=en: the page must be
// <html lang=en dir=ltr>, no tt() key may miss its English text
// (missingKeys) and no Arabic may be left in the interface
// (untranslatedUi). Arabic that is data is allowed: the seed and catalog
// rows (module names have only name_ar), and the names of the clinics and
// plans other specs created in this run (dataNames below).
// I18N_SHOTS=<dir> also saves a screenshot of every screen there.
const path = require("path");
const { test, expect, PASSWORD, untranslatedUi, missingKeys } = require("./fixtures.cjs");

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const SLUG = `en-${RUN}`;
const CLINIC = `English Test Clinic ${RUN}`;
const OWNER = `en-owner-${RUN}@e2e.test`;
const PLAN_CODE = `en-${RUN}`;
let clinicId = null;

async function openPanel(page, hash = "", lang = "en") {
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto(`/?platform=1${lang ? "&lang=" + lang : ""}${hash}`);
  await expect(page.locator("[data-platform-app]")).toBeAttached();
  await expect(page.locator("[data-platform-app]")).not.toHaveAttribute("data-auth", "checking");
}

async function signIn(page, email, password = PASSWORD) {
  await expect(page.locator("[data-platform-app][data-auth=anon]")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function loginSuper(page, hash = "") {
  await openPanel(page, hash);
  if (await page.locator("[data-platform-app][data-auth=anon]").count()) await signIn(page, "super@clinicsys.test");
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
}

// Names entered as data (clinics, plans, suspension reasons) by any spec of
// this run, so their Arabic is not counted as untranslated interface.
async function dataNames(page) {
  return page.evaluate(async () => {
    const api = window.ClinicApi;
    const out = [];
    const orgs = await api.request("GET", "/platform/organizations?limit=200");
    ((orgs.data && orgs.data.data) || []).forEach((o) => out.push(o.name, o.status_reason));
    const plans = await api.request("GET", "/platform/plans");
    (plans.data || []).forEach((p) => out.push(p.name));
    return out.filter(Boolean);
  });
}

async function shot(page, name) {
  if (!process.env.I18N_SHOTS) return;
  const vp = page.viewportSize();
  await page.screenshot({ path: path.join(process.env.I18N_SHOTS, `platform-en-${vp.width}-${name}.png`), fullPage: true });
}

// The page is English and left-to-right, with nothing left in Arabic.
async function expectEnglish(page, name, allow = []) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("lang", "en");
  expect(await missingKeys(page), `missing English keys on ${name}`).toEqual([]);
  const data = await dataNames(page).catch(() => []);
  expect(await untranslatedUi(page, allow.concat(data)), `Arabic left on ${name}`).toEqual([]);
  await shot(page, name);
}

const toast = (page, text) => page.locator(".pa-toast", { hasText: text }).last();
const sw = (page, name) => page.getByRole("switch", { name, exact: true });
const slugMsg = (page) => page.locator(".pa-slug-msg");

test("sign-in screen: English labels, validation, wrong password, 'not authorized', session error", async ({ page }) => {
  await openPanel(page);
  await expect(page.getByRole("heading", { name: "Sign in to the platform panel" })).toBeVisible();
  await expect(page).toHaveTitle("Platform panel — ClinicSystem EG");
  await expect(page.locator("[data-lang-switch=ar]")).toHaveText("العربية");
  await expectEnglish(page, "login");
  // Empty form → field errors.
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  await expect(page.getByText("Enter your password")).toBeVisible();
  await expectEnglish(page, "login-errors");
  // Wrong password → one generic message.
  await signIn(page, "super@clinicsys.test", "wrong-password");
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect email or password" })).toBeVisible();
  await expectEnglish(page, "login-wrong");
  // A clinic admin is not a Super Admin.
  await signIn(page, "admin@demo-physio.test");
  await expect(page.getByRole("heading", { name: "You don't have access to the platform panel" })).toBeVisible();
  await expect(page.locator("[data-not-authorized]")).toContainText("You're signed in as admin@demo-physio.test");
  await expectEnglish(page, "not-authorized");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("data-auth", "anon");
  // The session check fails → error screen with a retry.
  await page.route("**/api/auth/session", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "x" } } }));
  await openPanel(page);
  await expect(page.getByRole("heading", { name: "Couldn't check your session" })).toBeVisible();
  await expectEnglish(page, "session-error");
  await page.unroute("**/api/auth/session");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("data-auth", "anon");
});

test("the language switch on the sign-in screen and in the panel header", async ({ page }) => {
  // Arabic by default; the login screen offers English.
  await openPanel(page, "", null);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "دخول لوحة المنصة" })).toBeVisible();
  await page.locator("[data-lang-switch=en]").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Sign in to the platform panel" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("clinicsys.lang"))).toBe("en");
  await signIn(page, "super@clinicsys.test");
  await expect(page.getByRole("heading", { name: "Platform overview" })).toBeVisible();
  // Header switch → Arabic, same screen, no second sign-in.
  await page.locator("header [data-lang-switch=ar]").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "مؤشرات المنصة" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("lang")).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("clinicsys.lang"))).toBe("ar");
  // … and back to English.
  await page.locator("header [data-lang-switch=en]").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Platform overview" })).toBeVisible();
});

test("A01 overview and the panel shell", async ({ page }) => {
  await loginSuper(page);
  await expect(page.getByRole("heading", { name: "Platform overview" })).toBeVisible();
  const stats = await page.evaluate(() => window.ClinicApi.request("GET", "/platform/stats"));
  await expect(page.locator("[data-stat=active]")).toHaveAttribute("aria-label", `Active clinics: ${stats.data.organizations.active}`);
  await expect(page.locator("table[data-audit] tbody tr[data-action]").first()).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Platform sections" });
  for (const name of ["Overview", "Clinics", "Specialties and modules", "Plans", "Audit log"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  // LTR: the sidebar is on the left of the content.
  const side = await page.locator("aside.pa-sidebar").boundingBox();
  const main = await page.locator("#pa-main").boundingBox();
  expect(side.x).toBeLessThan(main.x);
  await expectEnglish(page, "a01");
  // Unknown route.
  await openPanel(page, "#/nowhere");
  await expect(page.getByText("Page not found").first()).toBeVisible();
  await expectEnglish(page, "notfound");
});

test("A02 clinics: list, filters, no results, phone cards", async ({ page }) => {
  await loginSuper(page, "#/clinics");
  await expect(page.getByRole("heading", { name: "Clinics", exact: true })).toBeVisible();
  const row = page.locator("tr[data-slug=demo-physio]");
  await expect(row).toBeVisible();
  await expect(row.locator(".badge", { hasText: "Physiotherapy" })).toBeVisible();
  await expect(row).toContainText("Active");
  await page.getByLabel("Status").selectOption("active");
  await expect(page.locator(".page-head")).toContainText("Matching clinics:");
  await expectEnglish(page, "a02");
  await page.getByLabel("Search by name or address").fill("no-such-clinic-xyz");
  await expect(page.getByText("No matching clinics")).toBeVisible();
  await expectEnglish(page, "a02-empty");

  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel(page, "#/clinics");
  await expect(row.locator("td[data-label='Status']")).toContainText("Active");
  await expect(page.locator("table.pa-tbl thead").first()).toHaveCSS("position", "absolute");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator("header [data-lang-switch=ar]")).toHaveText("ع");
  const nav = page.getByRole("navigation", { name: "Platform sections" });
  await expect(nav).not.toBeInViewport();
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(nav).toBeInViewport();
  await expectEnglish(page, "a02-menu");
  await nav.getByRole("link", { name: "Plans" }).click();
  await expect(nav).not.toBeInViewport();
  await openPanel(page, "#/clinics");
  await expectEnglish(page, "a02");
});

test("A03 wizard in English: every step, validation errors, slug states, done screen", async ({ page }) => {
  await loginSuper(page, "#/clinics");
  await page.getByRole("link", { name: "Create clinic" }).first().click();
  await expect(page.getByRole("heading", { name: "Step 1 of 4: Details" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Enter the clinic name (2 to 120 characters)")).toBeVisible();
  await expect(page.getByText("Choose the clinic address")).toBeVisible();
  await expectEnglish(page, "a03-step1-errors");
  await page.getByLabel("Clinic name").fill(CLINIC);
  const slug = page.getByLabel("Clinic address");
  await slug.fill("demo-physio");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "taken");
  await expect(slugMsg(page)).toContainText("Taken — choose another address");
  await slug.fill("admin");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "reserved");
  await expect(slugMsg(page)).toContainText("Reserved by the system");
  await slug.fill("-bad-");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "invalid");
  await expect(slugMsg(page)).toContainText("Invalid: 3 to 32 characters");
  await expectEnglish(page, "a03-slug-invalid");
  await slug.fill(SLUG);
  await expect(slugMsg(page)).toHaveAttribute("data-state", "available");
  await expect(slugMsg(page)).toContainText("Available");
  await expectEnglish(page, "a03-step1");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2: specialties by their English names; module errors in English.
  await expect(page.getByRole("heading", { name: "Step 2 of 4: Specialty and features" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Physiotherapy/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Physiotherapy/ })).toContainText("default modules");
  await sw(page, "المرضى").click();
  await expect(page.getByRole("alert").filter({ hasText: "“المرضى” can't be disabled: enabled modules depend on it:" })).toBeVisible();
  await sw(page, "قوالب خطط العلاج").click();
  await sw(page, "خطط العلاج").click();
  await sw(page, "قوالب خطط العلاج").click();
  await expect(page.getByRole("alert").filter({ hasText: "“قوالب خطط العلاج” can't be enabled before: “خطط العلاج”" })).toBeVisible();
  await expectEnglish(page, "a03-step2-errors");
  await page.getByRole("button", { name: "Enable them all together" }).click();
  await page.getByRole("radio", { name: /Dentistry/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "The default modules of “Dentistry” are selected" })).toBeVisible();
  await page.getByRole("radio", { name: /Physiotherapy/ }).click();
  await page.getByRole("button", { name: "Default modules" }).click();
  await expect(page.getByText("The specialty's default modules are restored.")).toBeVisible();
  await expectEnglish(page, "a03-step2");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3: plan limits, status note.
  await expect(page.getByRole("heading", { name: "Step 3 of 4: Plan" })).toBeVisible();
  await expect(page.locator(".pa-wizard-body")).toContainText("Status when created: Pending activation");
  await expect(page.locator(".pa-limits").first()).toContainText("Users:");
  await expectEnglish(page, "a03-step3");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 4: e-mail error, summary, back button, cancel dialog.
  await expect(page.getByRole("heading", { name: "Step 4 of 4: First admin" })).toBeVisible();
  await page.getByLabel("Email of the clinic's first admin").fill("not-an-email");
  await page.getByRole("button", { name: "Create clinic" }).click();
  await expect(page.getByText("Enter a valid email address for the first admin")).toBeVisible();
  await page.getByLabel("Email of the clinic's first admin").fill(OWNER);
  const summary = page.locator(".pa-summary");
  await expect(summary).toContainText(CLINIC);
  await expect(summary).toContainText("Main branch (created automatically)");
  await expectEnglish(page, "a03-step4");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dlg).toContainText("No clinic will be created");
  await expectEnglish(page, "a03-cancel");
  await dlg.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByRole("heading", { name: "Step 3 of 4: Plan" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  const created = page.waitForResponse((r) => r.url().endsWith("/api/platform/organizations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create clinic" }).click();
  clinicId = (await (await created).json()).organization.id;
  const done = page.locator("[data-wizard-done]");
  await expect(done.getByRole("heading", { name: `Clinic “${CLINIC}” created` })).toBeVisible();
  await expect(done.locator("[data-invite-sent]")).toContainText(OWNER);
  await expect(done.locator("[data-invite-sent]")).toContainText("as “Clinic admin”");
  await expect(toast(page, "created")).toBeVisible();
  await expectEnglish(page, "a03-done");
});

test("A04 clinic detail: every tab, dialogs and invitation badges in English", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, `#/clinics/${clinicId}`);
  await expect(page.locator("[data-clinic-name]")).toHaveText(CLINIC);
  await expect(page.locator("#pa-main .crumb")).toContainText("Clinics");
  await expect(page.getByRole("status").filter({ hasText: "Pending activation: the clinic becomes active" })).toBeVisible();
  // General: info + specialty change confirmation.
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("Active members");
  await expectEnglish(page, "a04-general");
  await page.getByLabel("Specialty").selectOption("dental");
  await page.getByRole("button", { name: "Save changes" }).click();
  const spec = page.getByRole("dialog", { name: "Change the specialty?" });
  await expect(spec).toContainText("From “Physiotherapy” to “Dentistry”.");
  await expectEnglish(page, "a04-specialty-dialog");
  await spec.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  // Tabs: the arrow that points the reading way (right in English) moves on.
  await page.getByRole("tab", { name: "General" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Features" })).toHaveAttribute("aria-selected", "true");

  // Features: dependency error and the disable dialog.
  await sw(page, "خطط العلاج").click();
  await expect(page.getByRole("alert").filter({ hasText: "enabled modules depend on it" })).toBeVisible();
  await expectEnglish(page, "a04-modules");
  await sw(page, "قوالب خطط العلاج").click();
  const off = page.getByRole("dialog", { name: "Disable “قوالب خطط العلاج”?" });
  await expect(off).toContainText("its data is kept");
  await expectEnglish(page, "a04-modules-dialog");
  await off.getByRole("button", { name: "Back" }).click();

  await page.getByRole("tab", { name: "Branches" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Active branches:");
  await expectEnglish(page, "a04-branches");

  // Members and invitations: the invite dialog and its validation.
  await page.getByRole("tab", { name: "Members and invitations" }).click();
  await expect(page.locator("[data-seats]")).toContainText("Seats:");
  await expect(page.locator(`tr[data-invite="${OWNER}"]`)).toContainText("Pending");
  await page.getByRole("button", { name: "Invite user" }).click();
  const inv = page.getByRole("dialog", { name: `Invite a user to “${CLINIC}”` });
  await inv.getByLabel("Email").fill("bad");
  await inv.getByLabel("Role").selectOption("receptionist");
  await inv.getByRole("checkbox").first().uncheck();
  await inv.getByRole("button", { name: "Send invitation" }).click();
  await expect(inv.getByText("Enter a valid email address")).toBeVisible();
  await expect(inv.getByText("Choose at least one branch for this role")).toBeVisible();
  await expectEnglish(page, "a04-invite-dialog");
  await inv.getByRole("button", { name: "Back" }).click();
  const revoke = page.locator(`tr[data-invite="${OWNER}"]`).getByRole("button", { name: `Revoke the invitation to ${OWNER}` });
  await revoke.click();
  await expect(page.getByRole("dialog", { name: "Revoke the invitation?" })).toContainText("won't be able to use the invitation link");
  await expectEnglish(page, "a04-revoke-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  // The invitation e-mail state badges (email_status, task 3.15).
  for (const [status, badge] of [["failed", "Email not sent"], ["pending", "Email sending"]]) {
    await page.route(`**/api/platform/organizations/${clinicId}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const invitations = (body.invitations || []).map((i) => (i.email === OWNER ? { ...i, email_status: status } : i));
      await route.fulfill({ response: res, json: { ...body, invitations } });
    });
    await page.reload();
    await expect(page.locator(`tr[data-invite="${OWNER}"] [data-email-status="${status}"]`)).toHaveText(badge);
    await expectEnglish(page, "a04-members-" + status);
    await page.unroute(`**/api/platform/organizations/${clinicId}`);
  }

  // Subscription: date error, then dates shown by the shared formatter.
  await page.getByRole("tab", { name: "Subscription" }).click();
  await page.getByLabel("Subscription status").selectOption("trial");
  await page.getByLabel("Period start").fill("2026-10-01");
  await page.getByLabel("Period end").fill("2026-09-01");
  await page.getByRole("button", { name: "Save subscription" }).click();
  await expect(page.getByText("The end date is before the start date")).toBeVisible();
  await expectEnglish(page, "a04-subscription-error");
  await page.getByLabel("Period end").fill("2026-12-31");
  await page.getByRole("button", { name: "Save subscription" }).click();
  await expect(toast(page, "Subscription saved")).toBeVisible();
  await expect(page.locator("[data-sub-status]")).toHaveText("Trial");
  await expect(page.locator("[data-sub-period]")).toHaveText("From 1 October 2026 to 31 December 2026");
  await expectEnglish(page, "a04-subscription");

  // The clinic's log and an action's details.
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.locator("table[data-audit] tbody tr[data-action='subscription.set']").first()).toContainText("Change subscription");
  await expectEnglish(page, "a04-log");
  await page.locator("table[data-audit] tbody tr[data-action='subscription.set']").first().getByRole("button", { name: "Show the action's details" }).click();
  await expect(page.getByRole("dialog", { name: "Change subscription" })).toContainText("Table");
  await expectEnglish(page, "a04-log-details");
});

test("A04 status in English: activate, the suspend dialog (reason required), retention, reactivate", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, `#/clinics/${clinicId}`);
  await page.getByRole("button", { name: "Activate manually" }).click();
  const act = page.getByRole("dialog", { name: `Activate “${CLINIC}” manually?` });
  await expectEnglish(page, "a04-activate-dialog");
  await act.getByRole("button", { name: "Activate manually" }).click();
  await expect(toast(page, "The clinic is active now")).toBeVisible();

  await page.getByRole("button", { name: "Suspend clinic" }).click();
  const dlg = page.getByRole("dialog", { name: `Suspend “${CLINIC}”?` });
  await expect(dlg).toContainText("Its data is kept for 6 months");
  await dlg.getByRole("button", { name: "Suspend clinic" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("Enter the reason for suspending");
  await expectEnglish(page, "a04-suspend-dialog");
  await dlg.getByLabel("Reason for suspending").fill("Late payment — English test");
  await dlg.getByRole("button", { name: "Suspend clinic" }).click();
  await expect(toast(page, "Clinic suspended — its data is kept until")).toBeVisible();
  const detail = await page.evaluate((id) => window.ClinicApi.request("GET", `/platform/organizations/${id}`), clinicId);
  const until = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(detail.data.organization.retention_until));
  await expect(page.locator("[data-retention]")).toContainText(`its data is kept until ${until}`);
  await expect(page.getByRole("alert").filter({ hasText: "Reason: Late payment — English test" })).toBeVisible();
  await expectEnglish(page, "a04-suspended");
  // Invitations are blocked while suspended.
  await page.getByRole("tab", { name: "Members and invitations" }).click();
  await expect(page.getByRole("button", { name: "Invite user" })).toBeDisabled();
  await expect(page.getByRole("tabpanel")).toContainText("The clinic is suspended — invitations can't be sent or resent.");
  await expectEnglish(page, "a04-suspended-members");
  // A02 shows the retention date.
  await openPanel(page, "#/clinics?status=suspended");
  await expect(page.locator(`tr[data-slug="${SLUG}"] [data-retention-until]`)).toHaveText(`Kept until ${until}`);
  await expectEnglish(page, "a02-suspended");
  // Close dialog, then reactivate.
  await openPanel(page, `#/clinics/${clinicId}`);
  await page.getByRole("button", { name: "Close permanently" }).click();
  await expect(page.getByRole("dialog", { name: `Close “${CLINIC}” permanently?` })).toContainText("A closed clinic can't be reopened.");
  await expectEnglish(page, "a04-close-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Reactivate" }).click();
  await expectEnglish(page, "a04-reactivate-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
  await expect(toast(page, "The clinic is active now")).toBeVisible();
});

test("A05 catalog, A06 plans (dialog and errors), A07 audit log in English", async ({ page }) => {
  await loginSuper(page, "#/catalog");
  await expect(page.getByRole("heading", { name: "Specialties and modules" })).toBeVisible();
  await expect(page.locator("table").first()).toContainText("Physiotherapy");
  await expect(page.locator("table").nth(1)).toContainText("Shared core");
  await expectEnglish(page, "a05");

  await openPanel(page, "#/plans");
  await expect(page.getByRole("heading", { name: "Plans", level: 1 })).toBeVisible();
  await expect(page.locator("tr[data-plan=default] [data-col=max_users]")).toHaveText("Unlimited");
  await expect(page.locator("tr[data-plan=default]")).toContainText("All modules");
  await expectEnglish(page, "a06");
  await page.getByRole("button", { name: "New plan" }).click();
  const dlg = page.getByRole("dialog", { name: "New plan" });
  await dlg.getByRole("radio", { name: /Selected specialty modules/ }).check();
  await dlg.getByLabel("Code").fill("Bad Code!");
  await dlg.getByRole("button", { name: "Create plan" }).click();
  await expect(dlg.getByText("Name is required (120 characters at most)")).toBeVisible();
  await expect(dlg.getByText("Lowercase Latin letters, digits and _ or - (40 characters at most)")).toBeVisible();
  await expectEnglish(page, "a06-dialog-errors");
  await dlg.getByLabel("Name").fill(`English plan ${RUN}`);
  await dlg.getByLabel("Code").fill(PLAN_CODE);
  await dlg.getByLabel("User limit").fill("5");
  await dlg.getByRole("button", { name: "Create plan" }).click();
  await expect(toast(page, `Plan “English plan ${RUN}” created`)).toBeVisible();
  await page.locator(`tr[data-plan="${PLAN_CODE}"]`).getByRole("button", { name: `Edit plan English plan ${RUN}` }).click();
  await expect(page.getByRole("dialog", { name: `Edit plan “English plan ${RUN}”` })).toContainText("Can't change after creation.");
  await expectEnglish(page, "a06-edit-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Save plan" }).click();
  await expect(toast(page, "No changes to save")).toBeVisible();

  await openPanel(page, "#/audit");
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  await expect(page.locator("table[data-audit] tbody tr[data-action='plan.create']").first()).toContainText("Create plan");
  await expect(page.locator("table[data-audit] tbody tr[data-action='plan.create']").first()).toContainText("Platform");
  await expectEnglish(page, "a07");
  await page.getByLabel("From date").fill("2026-12-31");
  await page.getByLabel("To date").fill("2026-01-01");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The start date is after the end date" })).toBeVisible();
  await expectEnglish(page, "a07-error");
  await page.getByLabel("From date").fill("");
  await page.getByLabel("To date").fill("");
  await page.getByLabel("Action type").fill("nothing.matches");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("No actions match the filters.")).toBeVisible();
  await expectEnglish(page, "a07-empty");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".pa-pager")).toContainText("Showing 1–");
});
