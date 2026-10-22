// Super Admin panel (plan task 3.6; docs/03-App-Flow.md A01-A07, J1).
//
//   E2E_DB_PORT=56202 E2E_API_PORT=3202 npx playwright test -c e2e/playwright.config.cjs e2e/platform.spec.cjs
//
// MOUNTING: the panel is window.PlatformApp (src/platform.jsx). The boot
// router (src/screens2.jsx App → TenantPlatformGate in src/tenant.jsx)
// renders it in the platform context (?platform=1 / admin.<base>), and the
// tests normally go through it. mountFallback() is a guard for runs where
// the router does not render the panel: when nothing on the page carries
// [data-platform-app] shortly after load, it renders PlatformApp itself into
// a new <div> (hiding #root) and adds a "platform-mount-fallback" annotation
// to the test. The journeys task (3.9) can delete mountFallback() once the
// router is final and keep only the page.goto().
//
// The tests share one clinic created through the wizard, so they run in
// order (serial). Every name is unique per run, so the spec also works
// against a running stack (E2E_BASE_URL) without a database reset.
const { test, expect, PASSWORD, readOutbox, lastLinkTo } = require("./fixtures.cjs");

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const SLUG = `e2e-${RUN}`;
const CLINIC = `عيادة اختبار المنصة ${RUN}`;
const OWNER = `owner-${RUN}@e2e.test`;
const PLAN_CODE = `e2e-${RUN}`;
let clinicId = null;

async function mountFallback(page) {
  const routed = await page.locator("[data-platform-app]").first()
    .waitFor({ state: "attached", timeout: 2500 }).then(() => true, () => false);
  if (routed) return;
  test.info().annotations.push({ type: "platform-mount-fallback", description: "PlatformApp mounted by the spec, not by the boot router" });
  await page.evaluate(() => {
    if (document.querySelector("[data-platform-app]")) return;
    const root = document.getElementById("root");
    if (root) root.style.display = "none";
    const el = document.createElement("div");
    el.id = "platform-root";
    document.body.appendChild(el);
    window.ReactDOM.createRoot(el).render(window.React.createElement(window.PlatformApp));
  });
}

// Opens the panel at /?platform=1[#hash] (always a full page load: going to
// the current URL, or to another #hash of it, would only be an in-page
// navigation) and waits for its session check.
async function openPanel(page, hash = "") {
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto("/?platform=1" + hash);
  await page.waitForFunction(() => typeof window.PlatformApp === "function");
  await mountFallback(page);
  await expect(page.locator("[data-platform-app]")).not.toHaveAttribute("data-auth", "checking");
}

async function login(page, email, password = PASSWORD) {
  await expect(page.locator("[data-platform-app][data-auth=anon]")).toBeVisible();
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}

async function loginSuper(page, hash = "") {
  await openPanel(page, hash);
  if (await page.locator("[data-platform-app][data-auth=anon]").count()) await login(page, "super@clinicsys.test");
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
}

// The newest toast with this text (an older identical one may still be on screen).
const toast = (page, text) => page.locator(".pa-toast", { hasText: text }).last();
const sw = (page, name) => page.getByRole("switch", { name, exact: true });
const slugMsg = (page) => page.locator(".pa-slug-msg");

test("the panel sends X-Platform: 1; a wrong password gets one generic message", async ({ page }) => {
  const platformHeaders = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) platformHeaders.push([new URL(r.url()).pathname, r.headers()["x-platform"]]);
  });
  await openPanel(page);
  await login(page, "super@clinicsys.test", "wrong-password");
  await expect(page.getByRole("alert").filter({ hasText: "بيانات الدخول غير صحيحة" })).toBeVisible();
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("data-auth", "anon");
  const panelCalls = platformHeaders.filter(([p]) => p === "/api/auth/session" || p === "/api/auth/login");
  expect(panelCalls.length).toBeGreaterThan(0);
  for (const [p, h] of panelCalls) expect(h, p).toBe("1");
  expect(await page.evaluate(() => sessionStorage.getItem("clinicsys.platform"))).toBe("1");
});

test("a clinic admin who is not a Super Admin sees 'not authorized' and can log out", async ({ page }) => {
  await openPanel(page);
  await login(page, "admin@demo-physio.test");
  await expect(page.getByRole("heading", { name: "ليست لديك صلاحية لوحة المنصة" })).toBeVisible();
  await expect(page.locator("[data-not-authorized]")).toContainText("admin@demo-physio.test");
  await expect(page.getByRole("navigation", { name: "أقسام المنصة" })).toHaveCount(0);
  // The API agrees: platform routes refuse this account.
  const res = await page.evaluate(() => window.ClinicApi.request("GET", "/platform/stats"));
  expect(res.status).toBe(403);
  expect(res.error.code).toBe("not_super_admin");
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("data-auth", "anon");
  const after = await page.evaluate(() => window.ClinicApi.request("GET", "/auth/session"));
  expect(after.status).toBe(401);
});

test("Super Admin signs in: A01 stats and recent audit rows", async ({ page }) => {
  await loginSuper(page);
  await expect(page.getByRole("heading", { name: "مؤشرات المنصة" })).toBeVisible();
  for (const key of ["active", "suspended", "pending_activation", "pending_invitations", "retention_overdue"]) {
    await expect(page.locator(`[data-stat=${key}]`)).toBeVisible();
    await expect(page.locator(`[data-stat=${key}]`)).toHaveAttribute("aria-label", /: \d+$/);
  }
  const stats = await page.evaluate(() => window.ClinicApi.request("GET", "/platform/stats"));
  await expect(page.locator("[data-stat=active]")).toHaveAttribute("aria-label", `عيادات نشطة: ${stats.data.organizations.active}`);
  await expect(page.locator("table[data-audit] tbody tr[data-action]").first()).toBeVisible();
  // The session survives a reload (cookie), no second login.
  await openPanel(page);
  await expect(page.locator("[data-platform-app]")).toHaveAttribute("data-auth", "ready");
});

test("the admin.<base> host is the platform context without ?platform=1", async ({ page, baseURL }) => {
  const base = new URL(baseURL);
  test.skip(base.hostname !== "localhost", "needs a localhost stack (admin.localhost resolves to it)");
  const origin = `${base.protocol}//admin.localhost:${base.port}`;
  await page.goto(origin + "/");
  await page.waitForFunction(() => typeof window.PlatformApp === "function");
  await mountFallback(page);
  await login(page, "super@clinicsys.test");
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
  await expect(page.getByRole("heading", { name: "مؤشرات المنصة" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("clinicsys.platform"))).toBeNull();
  // The server answers platform routes from the Host alone (no X-Platform needed).
  const direct = await page.evaluate(() => fetch("/api/platform/stats", { credentials: "include" }).then((r) => r.status));
  expect(direct).toBe(200);
  // Clinic addresses use this host's base domain: <slug>.localhost.
  await page.goto(origin + "/#/clinics/new");
  await expect(page.locator(".pa-slug-suffix")).toHaveText(".localhost");
  const physio = await page.evaluate(() => window.ClinicApi.request("GET", "/platform/organizations?q=demo-physio"));
  await page.goto(origin + `/#/clinics/${physio.data.data[0].id}`);
  await expect(page.getByRole("tabpanel")).toContainText(`${base.protocol}//demo-physio.localhost:${base.port}/`);
});

test("phones: the menu is a drawer and tables become cards (no horizontal page scroll)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginSuper(page, "#/clinics");
  const row = page.locator("tr[data-slug=demo-physio]");
  await expect(row).toBeVisible();
  await expect(row.locator("td[data-label='الحالة']")).toContainText("نشطة");
  await expect(page.locator("table.pa-tbl thead").first()).toHaveCSS("position", "absolute");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const nav = page.getByRole("navigation", { name: "أقسام المنصة" });
  await expect(nav).not.toBeInViewport();
  await page.getByRole("button", { name: "القائمة" }).click();
  await expect(nav).toBeInViewport();
  await nav.getByRole("link", { name: "الخطط" }).click();
  await expect(page.getByRole("heading", { name: "الخطط", level: 1 })).toBeVisible();
  await expect(nav).not.toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("A02 list: search, status filter, paging info, open a clinic and go back", async ({ page }) => {
  await loginSuper(page, "#/clinics");
  await expect(page.getByRole("heading", { name: "العيادات", exact: true })).toBeVisible();
  await expect(page.locator("tr[data-slug=demo-physio]")).toBeVisible();
  await page.getByLabel("بحث بالاسم أو الرابط").fill("dental");
  await expect(page.locator("tr[data-slug=demo-dental]")).toBeVisible();
  await expect(page.locator("tr[data-slug=demo-physio]")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/clinics\?q=dental/);
  await page.getByLabel("بحث بالاسم أو الرابط").fill("");
  await expect(page).not.toHaveURL(/q=dental/);
  await page.getByLabel("التخصص", { exact: true }).selectOption("dental");
  await expect(page).toHaveURL(/#\/clinics\?specialty=dental/);
  await expect(page.locator("tr[data-slug=demo-dental]")).toBeVisible();
  await expect(page.locator("tr[data-slug=demo-physio]")).toHaveCount(0);
  await page.getByLabel("التخصص", { exact: true }).selectOption("");
  // Status filter: every row has the chosen status.
  await page.getByLabel("الحالة", { exact: true }).selectOption("active");
  await expect(page).toHaveURL(/#\/clinics\?status=active/);
  await expect(page.locator("tr[data-slug=demo-physio]")).toBeVisible();
  const statuses = await page.locator("tbody tr[data-slug] td:nth-child(3) .badge").allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  for (const t of statuses) expect(t).toBe("نشطة");
  // Nothing matches → empty state with a way out.
  await page.getByLabel("بحث بالاسم أو الرابط").fill(`no-such-clinic-${RUN}`);
  await expect(page.getByText("لا نتائج مطابقة")).toBeVisible();
  await page.getByRole("button", { name: "مسح التصفية" }).first().click();
  await expect(page).toHaveURL(/#\/clinics$/);
  await expect(page.locator("tr[data-slug=demo-physio]")).toBeVisible();
  await expect(page.locator(".pa-pager")).toContainText("من");
  await page.locator("tr[data-slug=demo-physio] a").click();
  await expect(page.locator("[data-clinic-name]")).toHaveText("عيادة العلاج الطبيعي التجريبية");
  await page.goBack();
  await expect(page.locator("tr[data-slug=demo-physio]")).toBeVisible();
});

test("A03 wizard: slug checks (taken, reserved, invalid), modules, plan, invitation e-mail", async ({ page }) => {
  await loginSuper(page, "#/clinics");
  await page.getByRole("link", { name: "إنشاء عيادة" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();

  // Step 1: next without data → field errors.
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByText("اكتب اسم العيادة (من 2 إلى 120 حرفًا)")).toBeVisible();
  await page.getByLabel("اسم العيادة").fill(CLINIC);

  const slug = page.getByLabel("رابط العيادة");
  await expect(slug).toHaveAttribute("dir", "ltr");
  await expect(page.locator(".pa-slug-suffix")).toHaveText(".clinicsyseg.com");
  // Taken: answered by GET /api/platform/slug-available after the 400 ms debounce.
  const takenCheck = page.waitForResponse((r) => r.url().includes("/api/platform/slug-available?slug=demo-physio"));
  await slug.fill("demo-physio");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "checking");
  expect((await (await takenCheck).json())).toEqual({ available: false, reason: "taken" });
  await expect(slugMsg(page)).toHaveAttribute("data-state", "taken");
  await expect(slugMsg(page)).toContainText("مستخدم");
  // Reserved (typed in capitals: the field lower-cases it).
  await slug.fill("ADMIN");
  await expect(slug).toHaveValue("admin");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "reserved");
  await expect(slugMsg(page)).toContainText("محجوز");
  // Invalid format: refused locally, no request.
  await slug.fill("-bad-");
  await expect(slugMsg(page)).toHaveAttribute("data-state", "invalid");
  await expect(slugMsg(page)).toContainText("غير صالح");
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();
  await slug.fill(SLUG);
  await expect(slugMsg(page)).toHaveAttribute("data-state", "available");
  await expect(slugMsg(page)).toContainText("متاح");
  await page.getByRole("button", { name: "التالي" }).click();

  // Step 2: physio preselected with its default modules.
  await expect(page.getByRole("heading", { name: /الخطوة 2 من 4/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /العلاج الطبيعي/ })).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "جلسات العلاج الطبيعي")).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "مخطط الأسنان")).toBeDisabled(); // planned module
  // Dependency hint: a base module other modules need cannot be turned off.
  await sw(page, "المرضى").click();
  await expect(page.getByRole("alert").filter({ hasText: "لا يمكن تعطيل «المرضى»" })).toBeVisible();
  await expect(sw(page, "المرضى")).toHaveAttribute("aria-checked", "true");
  // Another specialty preselects its own defaults (dental modules are planned → core only).
  await page.getByRole("radio", { name: /طب الأسنان/ }).click();
  await expect(sw(page, "جلسات العلاج الطبيعي")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("radio", { name: /العلاج الطبيعي/ }).click();
  await expect(sw(page, "جلسات العلاج الطبيعي")).toHaveAttribute("aria-checked", "true");
  // Enabling a module whose dependency is off → error with a fix.
  await sw(page, "قوالب خطط العلاج").click();
  await sw(page, "خطط العلاج").click();
  await expect(sw(page, "خطط العلاج")).toHaveAttribute("aria-checked", "false");
  await sw(page, "قوالب خطط العلاج").click();
  await expect(page.getByRole("alert").filter({ hasText: "لا يمكن تفعيل «قوالب خطط العلاج» قبل تفعيل: «خطط العلاج»" })).toBeVisible();
  await page.getByRole("button", { name: "فعّلها كلها معًا" }).click();
  await expect(sw(page, "خطط العلاج")).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "قوالب خطط العلاج")).toHaveAttribute("aria-checked", "true");
  // Leave templates off for the new clinic (checked again in A04).
  await sw(page, "قوالب خطط العلاج").click();
  await expect(sw(page, "قوالب خطط العلاج")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "التالي" }).click();

  // Step 3: plan (default preselected), status shown as pending.
  await expect(page.getByRole("heading", { name: /الخطوة 3 من 4/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /الخطة الافتراضية/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".pa-wizard-body")).toContainText("بانتظار التفعيل");
  await page.getByRole("button", { name: "التالي" }).click();

  // Step 4: e-mail + summary.
  await expect(page.getByRole("heading", { name: /الخطوة 4 من 4/ })).toBeVisible();
  await page.getByLabel("بريد أول مدير للعيادة").fill("not-an-email");
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();
  await expect(page.getByText("أدخل بريدًا إلكترونيًا صالحًا لأول مدير")).toBeVisible();
  await page.getByLabel("بريد أول مدير للعيادة").fill(OWNER);
  const summary = page.locator(".pa-summary");
  await expect(summary).toContainText(CLINIC);
  await expect(summary).toContainText(`${SLUG}.clinicsyseg.com`);
  await expect(summary).toContainText("جلسات العلاج الطبيعي");
  await expect(summary).not.toContainText("قوالب خطط العلاج");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/platform/organizations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();
  const body = await (await created).json();
  expect(body.organization.status).toBe("pending_activation");
  expect(body.modules.filter((m) => m.enabled).map((m) => m.code)).not.toContain("physio.templates");
  clinicId = body.organization.id;

  // Success summary: link, status, invitation sent.
  const done = page.locator("[data-wizard-done]");
  await expect(done.getByRole("heading", { name: `أُنشئت العيادة «${CLINIC}»` })).toBeVisible();
  await expect(done).toContainText(`https://${SLUG}.clinicsyseg.com/`);
  await expect(done.locator(".badge", { hasText: "بانتظار التفعيل" })).toBeVisible();
  await expect(done.locator("[data-invite-sent]")).toContainText(OWNER);
  await expect(toast(page, "أُنشئت العيادة")).toBeVisible();

  // The invitation e-mail is in the outbox with a working link for this clinic.
  await expect.poll(() => readOutbox().filter((m) => JSON.stringify(m.to).includes(OWNER)).length).toBe(1);
  const link = lastLinkTo(OWNER);
  expect(link).toContain("?invite=");
  expect(link).toContain(`org=${SLUG}`);
  const mail = readOutbox().find((m) => JSON.stringify(m.to).includes(OWNER));
  expect(mail.subject).toContain(CLINIC);

  // No partial clinic for the refused slugs (AT-02).
  const taken = await page.evaluate(() => window.ClinicApi.request("GET", "/platform/organizations?q=demo-physio"));
  expect(taken.data.count).toBe(1);

  await done.getByRole("link", { name: "فتح صفحة العيادة" }).click();
  await expect(page.locator("[data-clinic-name]")).toHaveText(CLINIC);
  await expect(page.locator(".page-head .badge", { hasText: "بانتظار التفعيل" })).toBeVisible();
});

test("A03 wizard: leaving with unsaved input asks first; creating a taken slug is refused", async ({ page }) => {
  await loginSuper(page, "#/clinics/new");
  await page.getByLabel("اسم العيادة").fill("عيادة لن تُنشأ");
  await page.getByRole("link", { name: "الخطط" }).click();
  const dlg = page.getByRole("dialog", { name: "تجاهل التغييرات؟" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "رجوع" }).click();
  await expect(page.getByLabel("اسم العيادة")).toHaveValue("عيادة لن تُنشأ");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await page.getByRole("dialog", { name: "تجاهل التغييرات؟" }).getByRole("button", { name: "تجاهل والخروج" }).click();
  await expect(page.getByRole("heading", { name: "العيادات", exact: true })).toBeVisible();
  // The API refuses a taken slug even if the client skipped the check (AT-02).
  const res = await page.evaluate((slug) => window.ClinicApi.request("POST", "/platform/organizations",
    { name: "نسخة", slug, specialty_code: "physio", admin_email: "x@e2e.test" }), SLUG);
  expect(res.status).toBe(409);
  expect(res.error.code).toBe("slug_taken");
});

test("A04 details: modules toggle with dependency errors, general edit, subscription", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, `#/clinics/${clinicId}/modules`);
  await expect(page.getByRole("tab", { name: "الميزات" })).toHaveAttribute("aria-selected", "true");
  const templates = sw(page, "قوالب خطط العلاج");
  await expect(templates).toHaveAttribute("aria-checked", "false");
  const put = page.waitForResponse((r) => r.url().endsWith(`/organizations/${clinicId}/modules`) && r.request().method() === "PUT");
  await templates.click();
  expect((await put).status()).toBe(200);
  await expect(toast(page, "تم الحفظ")).toBeVisible();
  await expect(templates).toHaveAttribute("aria-checked", "true");
  // A base module with an enabled dependent cannot be turned off: no request, reason shown.
  await sw(page, "خطط العلاج").click();
  await expect(page.getByRole("alert").filter({ hasText: "تعتمد عليها وحدات مفعّلة: «قوالب خطط العلاج»" })).toBeVisible();
  await expect(sw(page, "خطط العلاج")).toHaveAttribute("aria-checked", "true");
  // Turning a module off asks first (data is kept).
  await templates.click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("تبقى بياناتها محفوظة");
  await dlg.getByRole("button", { name: "تعطيل الوحدة" }).click();
  await expect(templates).toHaveAttribute("aria-checked", "false");
  // The server's own dependency check is shown in Arabic too.
  const dep = await page.evaluate((id) => window.ClinicApi.request("PUT", `/platform/organizations/${id}/modules`,
    { codes: ["physio.sessions"] }), clinicId);
  expect(dep.error.code).toBe("module_dependency");
  // Persisted: reload and read the switch again.
  await openPanel(page, `#/clinics/${clinicId}/modules`);
  await expect(sw(page, "قوالب خطط العلاج")).toHaveAttribute("aria-checked", "false");
  await expect(sw(page, "جلسات العلاج الطبيعي")).toHaveAttribute("aria-checked", "true");

  // General: rename.
  await page.getByRole("tab", { name: "عام" }).click();
  await page.getByLabel("الاسم").fill(CLINIC + " ✓");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await expect(toast(page, "تم حفظ التغييرات")).toBeVisible();
  await expect(page.locator("[data-clinic-name]")).toHaveText(CLINIC + " ✓");
  await page.getByLabel("الاسم").fill(CLINIC);
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await expect(page.locator("[data-clinic-name]")).toHaveText(CLINIC);

  // Branches and members are read-only lists.
  await page.getByRole("tab", { name: "الفروع" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("الفرع الرئيسي");

  // Subscription (manual).
  await page.getByRole("tab", { name: "الاشتراك" }).click();
  await page.getByLabel("حالة الاشتراك").selectOption("trial");
  await page.getByLabel("بداية الفترة").fill("2026-10-01");
  await page.getByLabel("نهاية الفترة").fill("2026-09-01");
  await page.getByRole("button", { name: "حفظ الاشتراك" }).click();
  await expect(page.getByText("تاريخ النهاية قبل تاريخ البداية")).toBeVisible();
  await page.getByLabel("نهاية الفترة").fill("2026-12-31");
  await page.getByLabel("ملاحظات").fill("فترة تجريبية — اختبار");
  await page.getByRole("button", { name: "حفظ الاشتراك" }).click();
  await expect(toast(page, "تم حفظ الاشتراك")).toBeVisible();
  await expect(page.locator("[data-sub-status]")).toHaveText("تجريبي");
  await expect(page.locator("[data-sub-period]")).toHaveText("من 2026-10-01 إلى 2026-12-31");
});

test("A04 invitations: list, resend, invite (branch required), revoke", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, `#/clinics/${clinicId}/members`);
  const ownerRow = page.locator(`tr[data-invite="${OWNER}"]`);
  await expect(ownerRow).toContainText("معلقة");
  await ownerRow.getByRole("button", { name: `إعادة إرسال الدعوة إلى ${OWNER}` }).click();
  await expect(toast(page, "أُعيد إرسال الدعوة")).toBeVisible();
  await expect.poll(() => readOutbox().filter((m) => JSON.stringify(m.to).includes(OWNER)).length).toBe(2);

  const staff = `reception-${RUN}@e2e.test`;
  await page.getByRole("button", { name: "دعوة مستخدم" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("البريد الإلكتروني").fill(staff);
  await dlg.getByLabel("الدور").selectOption("receptionist");
  await dlg.getByRole("checkbox", { name: "الفرع الرئيسي" }).uncheck();
  await dlg.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(dlg.getByText("اختر فرعًا واحدًا على الأقل لهذا الدور")).toBeVisible();
  await dlg.getByRole("checkbox", { name: "الفرع الرئيسي" }).check();
  await dlg.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(toast(page, "أُرسلت الدعوة إلى " + staff)).toBeVisible();
  const staffRow = page.locator(`tr[data-invite="${staff}"]`);
  await expect(staffRow).toContainText("معلقة");
  await expect(staffRow).toContainText("الفرع الرئيسي");
  // A second invitation for the same e-mail is refused with an Arabic reason.
  await page.getByRole("button", { name: "دعوة مستخدم" }).click();
  await page.getByRole("dialog").getByLabel("البريد الإلكتروني").fill(staff);
  await page.getByRole("dialog").getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.getByRole("dialog").getByText("توجد دعوة معلقة لهذا البريد")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "رجوع" }).click();

  await staffRow.getByRole("button", { name: `إلغاء الدعوة إلى ${staff}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "إلغاء الدعوة" }).click();
  await expect(toast(page, "أُلغيت الدعوة")).toBeVisible();
  await expect(staffRow).toContainText("ملغاة");
  await expect(staffRow.getByRole("button")).toHaveCount(0);
});

test("A04 status: activate, suspend with a required reason (retention shown), reactivate", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, `#/clinics/${clinicId}`);
  await expect(page.getByRole("button", { name: "إيقاف العيادة" })).toHaveCount(0); // pending → only activation
  await page.getByRole("button", { name: "تفعيل يدويًا" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "تفعيل يدويًا" }).click();
  await expect(toast(page, "العيادة نشطة الآن")).toBeVisible();
  await expect(page.locator(".page-head .badge", { hasText: "نشطة" })).toBeVisible();

  await page.getByRole("button", { name: "إيقاف العيادة" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("6 أشهر");
  await dlg.getByRole("button", { name: "إيقاف العيادة" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("اكتب سبب الإيقاف");
  // The API also refuses a suspension without a reason.
  const noReason = await page.evaluate((id) => window.ClinicApi.request("POST", `/platform/organizations/${id}/status`, { status: "suspended" }), clinicId);
  expect(noReason.error.code).toBe("reason_required");
  await dlg.getByLabel("سبب الإيقاف").fill("تأخر السداد — اختبار");
  await dlg.getByRole("button", { name: "إيقاف العيادة" }).click();
  await expect(toast(page, "أُوقفت العيادة")).toBeVisible();
  await expect(page.locator(".page-head .badge", { hasText: "موقوفة" })).toBeVisible();
  const detail = await page.evaluate((id) => window.ClinicApi.request("GET", `/platform/organizations/${id}`), clinicId);
  const until = new Date(detail.data.organization.retention_until);
  const pad = (n) => String(n).padStart(2, "0");
  const untilText = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;
  await expect(page.locator("[data-retention]")).toContainText(`البيانات محفوظة حتى ${untilText}`);
  await expect(page.getByRole("alert").filter({ hasText: "السبب: تأخر السداد — اختبار" })).toBeVisible();
  // A02 shows the retention date under the status of a suspended clinic.
  await openPanel(page, "#/clinics?status=suspended");
  await expect(page.locator(`tr[data-slug="${SLUG}"] [data-retention-until]`)).toHaveText(`محفوظة حتى ${untilText}`);
  await openPanel(page, `#/clinics/${clinicId}`);
  // Invitations cannot be sent for a suspended clinic.
  await page.getByRole("tab", { name: "الأعضاء والدعوات" }).click();
  await expect(page.getByRole("button", { name: "دعوة مستخدم" })).toBeDisabled();

  await page.getByRole("button", { name: "إعادة تفعيل" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "إعادة تفعيل" }).click();
  await expect(toast(page, "العيادة نشطة الآن")).toBeVisible();
  await expect(page.locator(".page-head .badge", { hasText: "نشطة" })).toBeVisible();
  await expect(page.locator("[data-retention]")).toHaveCount(0);
  const after = await page.evaluate((id) => window.ClinicApi.request("GET", `/platform/organizations/${id}`), clinicId);
  expect(after.data.organization.retention_until).toBeNull();
});

test("A05 catalog and A06 plans: create, duplicate code refused, edit limits (empty = unlimited)", async ({ page }) => {
  await loginSuper(page, "#/catalog");
  await expect(page.getByRole("heading", { name: "التخصصات والوحدات", level: 1 })).toBeVisible();
  await expect(page.getByRole("cell", { name: "physio.sessions" })).toBeVisible();

  await page.getByRole("link", { name: "الخطط" }).click();
  await expect(page.locator("tr[data-plan=default]")).toContainText("غير محدود");
  await page.getByRole("button", { name: "خطة جديدة" }).click();
  let dlg = page.getByRole("dialog");
  await dlg.getByLabel("الاسم").fill("خطة الاختبار");
  await dlg.getByLabel("الرمز").fill("Bad Code");
  await dlg.getByLabel("حد المستخدمين").fill("5");
  await dlg.getByLabel("حد الفروع").fill("2");
  await dlg.getByRole("radio", { name: /وحدات تخصصية محددة/ }).check();
  await dlg.getByRole("checkbox", { name: /جلسات العلاج الطبيعي/ }).check();
  await dlg.getByRole("button", { name: "إنشاء الخطة" }).click();
  await expect(dlg.getByText("أحرف لاتينية صغيرة وأرقام و _ أو -")).toBeVisible();
  await dlg.getByLabel("الرمز").fill("default");
  await dlg.getByRole("button", { name: "إنشاء الخطة" }).click();
  await expect(dlg.getByText("توجد خطة بالرمز نفسه")).toBeVisible();
  await dlg.getByLabel("الرمز").fill(PLAN_CODE);
  await dlg.getByRole("button", { name: "إنشاء الخطة" }).click();
  await expect(toast(page, "أُنشئت الخطة «خطة الاختبار»")).toBeVisible();
  const row = page.locator(`tr[data-plan="${PLAN_CODE}"]`);
  await expect(row.locator("[data-col=max_users]")).toHaveText("5");
  await expect(row.locator("[data-col=max_branches]")).toHaveText("2");
  await expect(row.locator("[data-col=max_storage_mb]")).toHaveText("غير محدود");
  await expect(row).toContainText("جلسات العلاج الطبيعي");

  await row.getByRole("button", { name: "تعديل الخطة خطة الاختبار" }).click();
  dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("الرمز")).toHaveAttribute("readonly", "");
  await dlg.getByLabel("حد المستخدمين").fill("10");
  await dlg.getByLabel("حد الفروع").fill("");
  await dlg.getByLabel("حد التخزين").fill("512");
  const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/api/platform/plans/"));
  await dlg.getByRole("button", { name: "حفظ الخطة" }).click();
  expect((await patch).postDataJSON()).toEqual({ max_users: 10, max_branches: null, max_storage_mb: 512 });
  await expect(toast(page, "تم حفظ الخطة «خطة الاختبار»")).toBeVisible();
  await expect(row.locator("[data-col=max_users]")).toHaveText("10");
  await expect(row.locator("[data-col=max_branches]")).toHaveText("غير محدود");
  await expect(row.locator("[data-col=max_storage_mb]")).toHaveText("512 MB");
});

test("A07 audit: filters by clinic, action, actor and date range show the panel's actions", async ({ page }) => {
  test.skip(!clinicId, "needs the clinic created by the wizard test");
  await loginSuper(page, "#/audit");
  const actions = () => page.locator("table[data-audit] tbody tr[data-action]").evaluateAll((rows) => rows.map((r) => r.dataset.action));
  await expect(page.locator("table[data-audit] tbody tr[data-action]").first()).toBeVisible();

  // Paging (25 rows a page): make sure there is a second page, then walk it.
  const total = await page.evaluate(async (code) => {
    const api = window.ClinicApi;
    const plan = (await api.request("GET", "/platform/plans")).data.find((p) => p.code === code);
    let count = (await api.request("GET", "/platform/audit?limit=1")).data.count;
    for (let i = 0; count <= 25; i++, count++) await api.request("PATCH", `/platform/plans/${plan.id}`, { max_users: 100 + i });
    return count;
  }, PLAN_CODE);
  const pages = Math.ceil(total / 25);
  await openPanel(page, "#/audit");
  const pager = page.getByRole("navigation", { name: "الصفحات" });
  await expect(pager).toContainText(`1 / ${pages}`);
  await expect(page.locator("table[data-audit] tbody tr[data-action]")).toHaveCount(25);
  const firstRow = await page.locator("table[data-audit] tbody tr[data-action]").first().innerText();
  await pager.getByRole("button", { name: "التالي" }).click();
  await expect(page).toHaveURL(/#\/audit\?page=2/);
  await expect(pager).toContainText(`2 / ${pages}`);
  await expect(pager).toContainText(`عرض 26–${Math.min(50, total)} من ${total}`);
  await expect(page.locator("table[data-audit] tbody tr[data-action]").first()).not.toHaveText(firstRow);
  await page.goBack();
  await expect(pager).toContainText(`1 / ${pages}`);

  await page.getByLabel("العيادة").selectOption(clinicId);
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect(page).toHaveURL(new RegExp(`#/audit\\?organization_id=${clinicId}`));
  await expect.poll(async () => new Set(await actions())).toEqual(new Set([
    "organization.create", "invitation.create", "organization.modules", "organization.update",
    "subscription.set", "invitation.resend", "invitation.revoke", "organization.status",
  ]));

  await page.getByLabel("نوع العملية").fill("organization.status");
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect.poll(actions).toEqual(["organization.status", "organization.status", "organization.status"]);
  await expect(page.locator(".pa-pager")).toContainText("من 3");

  await page.getByLabel("نوع العملية").fill("invitation.*");
  await page.getByLabel("المستخدم").fill("super@clinicsys.test");
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect.poll(async () => new Set(await actions())).toEqual(new Set(["invitation.create", "invitation.resend", "invitation.revoke"]));

  // Date range: today has the rows, tomorrow has none.
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  d.setDate(d.getDate() + 1);
  const tomorrow = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  await page.getByLabel("من تاريخ").fill(today);
  await page.getByLabel("إلى تاريخ").fill(today);
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect.poll(async () => (await actions()).length).toBe(4); // create (owner), resend, create (staff), revoke
  await page.getByLabel("من تاريخ").fill(tomorrow);
  await page.getByLabel("إلى تاريخ").fill(tomorrow);
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect(page.getByText("لا توجد عمليات مطابقة للتصفية.")).toBeVisible();
  await page.getByLabel("إلى تاريخ").fill(today);
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "تاريخ البداية بعد تاريخ النهاية" })).toBeVisible();

  // Plans live outside any clinic.
  await page.getByRole("button", { name: "مسح", exact: true }).click();
  await page.getByLabel("نوع العملية").fill("plan.*");
  await page.getByRole("button", { name: "تطبيق" }).click();
  await expect.poll(async () => (await actions()).filter((a) => a.startsWith("plan.")).length).toBeGreaterThanOrEqual(2);
  await expect(page.locator("table[data-audit] tbody tr[data-action='plan.update']").first()).toContainText("المنصة");
  // Details of a row with a payload.
  await page.locator("table[data-audit] tbody tr[data-action='plan.update']").first().getByRole("button", { name: "عرض تفاصيل العملية" }).click();
  await expect(page.getByRole("dialog").locator(".pa-json")).toContainText("max_users");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The clinic's own audit tab is pre-filtered.
  await openPanel(page, `#/clinics/${clinicId}/audit`);
  await expect(page.locator("table[data-audit] tbody tr[data-action='organization.create']")).toBeVisible();
  await expect(page.locator("table[data-audit] thead")).not.toContainText("العيادة");
});
