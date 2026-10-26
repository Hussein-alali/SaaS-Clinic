// Acceptance criteria AT-01..AT-16 of docs/01-PRD.md through the real
// screens (plan task 3.9): one test per criterion, named «AT-xx …».
//
// Every precondition that has a screen is set up through it (the Super
// Admin's wizard, plans, module switches and status actions; the clinic
// admin's branches and staff screens; S03 for invitations). The page's own
// API client (window.SB / window.ClinicApi — what the screens use) is
// called only to show what the server refuses beyond the screens (AT-05,
// AT-06, AT-07, AT-08, AT-09), and the e-mail outbox is read for links.
//
// AT-11 (production data migration) and AT-12 (slug change) have no screen
// and are skipped with the reason. The tests run in order (serial) and
// share the clinics they create; names are unique per run, so the spec runs
// again on the same database. Seeded clinics they change (modules, status)
// are put back, also when a test fails.
const { test, expect, PASSWORD, readOutbox } = require("./fixtures.cjs");
const { routeCdn } = require("../scripts/pw-cdn.cjs");

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const DENTAL = "عيادة الأسنان التجريبية";
const ORG_ID = { physio: "de000000-0000-4000-8000-0000000a0001", dental: "de000000-0000-4000-8000-0000000a0002" };
const SUPER = "super@clinicsys.test";

// C1: a physio clinic made in AT-01 (physio.templates left off), activated
// in AT-03 and used by AT-04/06/09. C2: a dental clinic on a two-branch plan
// (AT-14, AT-16).
const C1 = { name: `عيادة القبول ${RUN}`, slug: `at-${RUN}`, owner: `at-owner-${RUN}@e2e.test`, ownerPassword: "Accept#2026" };
const C2 = { name: `عيادة أسنان القبول ${RUN}`, slug: `atd-${RUN}`, owner: `atd-owner-${RUN}@e2e.test`, plan: `خطة فرعين ${RUN}`, planCode: `at2-${RUN}` };
const EXISTING = "receptionist@demo-dental.test"; // an existing account invited to C1 (AT-03/04)

const sidebar = (page) => page.locator("aside.sidebar");
const picker = (page) => page.locator("button.branch-switcher");
const paToast = (page, text) => page.locator(".pa-toast", { hasText: text }).last();
const sw = (page, name) => page.getByRole("switch", { name, exact: true });
// A day as the panel shows it (fmtDate in src/i18n.jsx, Arabic): «23 أبريل 2027».
const arDay = (d) => new Intl.DateTimeFormat("ar-EG-u-nu-latn", { day: "numeric", month: "long", year: "numeric" }).format(d);

// ── helpers ─────────────────────────────────────────────────────────────
async function waitForMailLink(to, re, after = 0) {
  let link = null;
  await expect.poll(() => {
    const links = readOutbox().slice(after)
      .filter((m) => JSON.stringify(m.to || "").includes(to))
      .map((m) => (String(m.text || m.html || "").match(/https?:\/\/[^\s"'<>]+/) || [null])[0])
      .filter((l) => l && re.test(l));
    link = links.length ? links[links.length - 1] : null;
    return !!link;
  }, { message: `e-mail with a link to ${to}`, timeout: 15_000 }).toBe(true);
  return link;
}

async function otherBrowser(browser, baseURL) {
  const context = await browser.newContext({ baseURL, locale: "ar-EG", viewport: { width: 1280, height: 800 } });
  await routeCdn(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return {
    page,
    async close() {
      await context.close();
      expect(errors, "uncaught page errors (second browser)").toEqual([]);
    },
  };
}

// The Super Admin panel at #hash (full page load), signed in.
async function panel(page, hash = "") {
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto("/?platform=1" + hash);
  const app = page.locator("[data-platform-app]");
  await expect(app).not.toHaveAttribute("data-auth", "checking");
  if (await page.locator("[data-platform-app][data-auth=anon]").count()) {
    await page.getByLabel("البريد الإلكتروني").fill(SUPER);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  }
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
}

// A03 up to step 4 (name, slug, specialty, plan, e-mail); returns without
// pressing «إنشاء العيادة».
async function wizardToLastStep(page, { name, slug, specialty = "العلاج الطبيعي", plan = null, email }) {
  await panel(page, "#/clinics/new");
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();
  await page.getByLabel("اسم العيادة").fill(name);
  await page.getByLabel("رابط العيادة").fill(slug);
  await expect(page.locator(".pa-slug-msg")).toHaveAttribute("data-state", "available");
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 2 من 4/ })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(specialty) }).click();
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 3 من 4/ })).toBeVisible();
  if (plan) await page.getByRole("radio", { name: new RegExp(plan) }).click();
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 4 من 4/ })).toBeVisible();
  await page.getByLabel("بريد أول مدير للعيادة").fill(email);
}

// S03, new account: name + password → the clinic's dashboard.
async function acceptAsNew(page, link, clinicName, name, password = PASSWORD) {
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "قبول الدعوة" })).toBeVisible();
  await page.locator("#invite-name").fill(name);
  await page.locator("#invite-password").fill(password);
  await page.locator("#invite-confirm").fill(password);
  await page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();
  await expect(sidebar(page)).toContainText(clinicName);
}

async function clinicLogin(page, email, password = PASSWORD) {
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}
async function rootLogin(page, email, password = PASSWORD) {
  await page.locator("#root-email").fill(email);
  await page.locator("#root-password").fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}
async function signOut(page) {
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#login-email, #root-email").first()).toBeVisible();
}

async function openUsers(page) {
  await sidebar(page).locator('[data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(page.locator(".members-table tbody tr[data-member]").first()).toBeVisible();
}
// branchIds: the ids to tick, or "all".
async function inviteInUi(page, email, role, branchIds) {
  await page.getByRole("button", { name: "دعوة موظف" }).click();
  await page.locator("#staff-invite-email").fill(email);
  await page.locator("#staff-invite-role").selectOption(role);
  for (const box of await page.locator('input[id^="staff-invite-branch-"]').all()) {
    const id = (await box.getAttribute("id")).replace("staff-invite-branch-", "");
    await box.setChecked(branchIds === "all" || branchIds.includes(id));
  }
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.locator(`tr[data-invite="${email}"]`)).toHaveAttribute("data-status", "pending");
}

// A Super Admin API client, ONLY to put a seeded clinic back after a failure.
async function restoreAs(playwright, baseURL, fn) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys", "X-Platform": "1" } });
  try {
    expect((await ctx.post("/api/auth/login", { data: { email: SUPER, password: PASSWORD } })).status()).toBe(200);
    await fn(ctx);
  } finally { await ctx.dispose(); }
}

// ── AT-01 ───────────────────────────────────────────────────────────────
test("AT-01 Super Admin creates a clinic with a name and an unused slug: it is saved and its link, specialty and chosen modules show in the panel", async ({ page }) => {
  await panel(page, "#/clinics/new");
  await page.getByLabel("اسم العيادة").fill(C1.name);
  await page.getByLabel("رابط العيادة").fill(C1.slug);
  await expect(page.locator(".pa-slug-msg")).toHaveAttribute("data-state", "available");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByRole("radio", { name: /العلاج الطبيعي/ }).click();
  // The chosen modules: the specialty's defaults without the templates.
  await sw(page, "قوالب خطط العلاج").click();
  await expect(sw(page, "قوالب خطط العلاج")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByLabel("بريد أول مدير للعيادة").fill(C1.owner);
  const mark = readOutbox().length;
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();
  const done = page.locator("[data-wizard-done]");
  await expect(done).toContainText(`${C1.slug}.clinicsyseg.com`);
  C1.invite = await waitForMailLink(C1.owner, /\?invite=/, mark);

  // Saved: after a full reload the list and the details show it.
  await panel(page, `#/clinics?q=${C1.slug}`);
  const row = page.locator(`tr[data-slug="${C1.slug}"]`);
  await expect(row).toContainText(C1.name);
  await expect(row).toContainText("بانتظار التفعيل");
  await row.getByRole("link").first().click();
  await expect(page.locator("[data-clinic-name]")).toHaveText(C1.name);
  C1.id = (page.url().match(/#\/clinics\/([0-9a-f-]{36})/) || [])[1];
  expect(C1.id).toBeTruthy();
  const general = page.getByRole("tabpanel");
  await expect(general).toContainText(`https://${C1.slug}.clinicsyseg.com/`);
  await expect(general).toContainText("العلاج الطبيعي");
  await page.getByRole("tab", { name: "الميزات" }).click();
  await expect(sw(page, "جلسات العلاج الطبيعي")).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "خطط العلاج")).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "الفواتير والمدفوعات")).toHaveAttribute("aria-checked", "true");
  await expect(sw(page, "قوالب خطط العلاج")).toHaveAttribute("aria-checked", "false");
});

// ── AT-02 ───────────────────────────────────────────────────────────────
test("AT-02 a slug that is already used is refused with a clear message and no second clinic is created", async ({ page, browser, baseURL }) => {
  // While typing: «مستخدم», and the wizard does not move on.
  await panel(page, "#/clinics/new");
  await page.getByLabel("اسم العيادة").fill("عيادة بالرابط نفسه");
  await page.getByLabel("رابط العيادة").fill("demo-physio");
  await expect(page.locator(".pa-slug-msg")).toHaveAttribute("data-state", "taken");
  await expect(page.locator(".pa-slug-msg")).toContainText("مستخدم");
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();

  // Taken between the check and «إنشاء»: another Super Admin creates the
  // same slug first; the server refuses the second one, the wizard says why.
  const slug = `at-race-${RUN}`;
  await wizardToLastStep(page, { name: "عيادة السباق ١", slug, email: `race1-${RUN}@e2e.test` });
  const other = await otherBrowser(browser, baseURL);
  await wizardToLastStep(other.page, { name: "عيادة السباق ٢", slug, email: `race2-${RUN}@e2e.test` });
  await other.page.getByRole("button", { name: "إنشاء العيادة" }).click();
  await expect(other.page.locator("[data-wizard-done]")).toBeVisible();
  await other.close();
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();
  await expect(page.getByText("هذا الرابط مستخدم لعيادة أخرى — اختر رابطًا آخر").first()).toBeVisible();
  await expect(page.locator("[data-wizard-done]")).toHaveCount(0);

  // One clinic with that slug, the first one.
  await panel(page, `#/clinics?q=${slug}`);
  await expect(page.locator(`tr[data-slug="${slug}"]`)).toHaveCount(1);
  await expect(page.locator(`tr[data-slug="${slug}"]`)).toContainText("عيادة السباق ٢");
  await panel(page, "#/clinics?q=demo-physio");
  await expect(page.locator("tr[data-slug]")).toHaveCount(1);
});


// ── AT-03 ───────────────────────────────────────────────────────────────
test("AT-03 an invited user who has not accepted cannot open the clinic's data until the invitation is accepted", async ({ page, browser, baseURL }) => {
  test.skip(!C1.invite, "needs the clinic of AT-01");
  // The first admin's clinic waits for them: no login form, no data.
  await page.goto(`/?org=${C1.slug}`);
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "pending");
  await expect(page.locator("#login-email")).toHaveCount(0);
  // Accepting (S03) activates the clinic and opens it.
  await acceptAsNew(page, C1.invite, C1.name, "مدير عيادة القبول", C1.ownerPassword);
  C1.active = true;

  // An existing account (a dental receptionist) invited by C1's admin (C06) …
  await openUsers(page);
  const mark = readOutbox().length;
  await inviteInUi(page, EXISTING, "receptionist", "all");
  const link = await waitForMailLink(EXISTING, /\?invite=/, mark);

  // … is refused at C1's address until it accepts: signed in, then signed out.
  const guest = await otherBrowser(browser, baseURL);
  const g = guest.page;
  await g.goto(`/?org=${C1.slug}`);
  await clinicLogin(g, EXISTING);
  await expect(g.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(g)).toHaveCount(0);
  // Signed in to its own clinic, C1's data is refused by the server too.
  await g.goto("/?org=demo-dental");
  await clinicLogin(g, EXISTING);
  await expect(sidebar(g)).toContainText(DENTAL);
  const refused = await g.evaluate((slug) => fetch("/api/data", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", "X-Requested-With": "clinicsys", "X-Org-Slug": slug },
    body: JSON.stringify({ table: "patients", action: "select" }),
  }).then(async (r) => [r.status, (await r.json()).error.code]), C1.slug);
  expect(refused).toEqual([403, "not_a_member"]);

  // After accepting with its own password, C1 opens.
  await g.goto(link);
  await expect(g.locator("form[data-mode=existing]")).toBeVisible();
  await g.locator("#invite-password").fill(PASSWORD);
  await g.getByRole("button", { name: "قبول الدعوة والدخول" }).click();
  await expect(sidebar(g)).toContainText(C1.name);
  await guest.close();
});

// ── AT-04 ───────────────────────────────────────────────────────────────
test("AT-04 login from the main site: one membership goes straight to the clinic; several show the clinic picker", async ({ page }) => {
  test.skip(!C1.active, "needs the clinic of AT-03");
  await page.goto("/");
  await rootLogin(page, C1.owner, C1.ownerPassword);
  await page.waitForURL(new RegExp(`\\?org=${C1.slug}(#/[a-z]+)?$`));
  await expect(sidebar(page)).toContainText(C1.name);
  await signOut(page);

  // The account that joined C1 in AT-03 is also in the dental clinic.
  await page.goto("/");
  await rootLogin(page, EXISTING);
  await expect(page.getByRole("heading", { name: "اختر العيادة" })).toBeVisible();
  const cards = page.locator(".tenant-clinic-card");
  expect(await cards.count()).toBeGreaterThanOrEqual(2);
  await expect(cards.filter({ hasText: C1.name })).toHaveCount(1);
  await expect(cards.filter({ hasText: C1.name })).toContainText("موظف استقبال");
  await expect(cards.filter({ hasText: DENTAL })).toHaveCount(1);
  await cards.filter({ hasText: C1.name }).click();
  await page.waitForURL(new RegExp(`\\?org=${C1.slug}(#/[a-z]+)?$`));
  await expect(sidebar(page)).toContainText(C1.name);
});

// ── AT-05 ───────────────────────────────────────────────────────────────
test("AT-05 a user of clinic A is refused clinic B: B's address, B's data and B's organization_id do not open it", async ({ page }) => {
  // B's address, signing in with an A account: refused and signed out.
  await page.goto("/?org=demo-dental");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(page.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(page)).toHaveCount(0);

  // Signed in to A, then B's address: «no membership», none of B's data.
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await page.goto("/?org=demo-dental");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "no-membership");
  await expect(page.getByText("مريض أول — DEN")).toHaveCount(0);
  const fromB = await page.evaluate(async () => {
    const r = await window.SB.from("patients").select("patient_id");
    return { data: r.data, code: r.error && r.error.code };
  });
  expect(fromB).toEqual({ data: null, code: "not_a_member" });

  // Back in A: B's organization_id in a request is refused or matches nothing.
  await page.goto("/?org=demo-physio");
  await expect(sidebar(page)).toContainText(PHYSIO);
  const res = await page.evaluate(async (orgB) => {
    const ins = await window.SB.from("patients").insert({ patient_id: "P-AT05-" + Date.now(), name: "تسلل", organization_id: orgB });
    const sel = await window.SB.from("patients").select("patient_id").eq("organization_id", orgB);
    const upd = await window.SB.from("patients").update({ notes: "تسلل" }).eq("patient_id", "P-DEN-01").select("patient_id");
    return { ins: ins.error && ins.error.code, sel: sel.data, upd: upd.data, updErr: upd.error };
  }, ORG_ID.dental);
  expect(res.ins).toBe("42501");
  expect(res.sel).toEqual([]);
  expect(res.updErr).toBeNull();
  expect(res.upd).toEqual([]);
});

// ── AT-06 ───────────────────────────────────────────────────────────────
test("AT-06 a member disabled during an open session is refused by the server on the next request, not only hidden by the screen", async ({ page, browser, baseURL }) => {
  test.skip(!C1.active, "needs the clinic of AT-03");
  await page.goto(`/?org=${C1.slug}`);
  await clinicLogin(page, C1.owner, C1.ownerPassword);
  await expect(sidebar(page)).toContainText(C1.name);
  await openUsers(page);
  // A receptionist account made by the admin («إنشاء مستخدم»).
  const email = `at06-${RUN}@e2e.test`;
  await page.getByRole("button", { name: "إنشاء مستخدم" }).click();
  await page.getByRole("textbox", { name: "الاسم الكامل" }).fill("استقبال عيادة القبول");
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await page.getByRole("combobox", { name: "الدور" }).selectOption("receptionist");
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page.getByText("تم إنشاء المستخدم")).toBeVisible();
  const row = page.locator(`tr[data-member="${email}"]`);
  await expect(row).toHaveAttribute("data-status", "active");
  C1.member = email;

  // The receptionist is at work in another browser.
  const rec = await otherBrowser(browser, baseURL);
  const r = rec.page;
  await r.goto(`/?org=${C1.slug}`);
  await clinicLogin(r, email);
  await expect(sidebar(r)).toContainText(C1.name);
  const current = () => r.evaluate(() => window.ClinicApi.request("GET", "/orgs/current").then((x) => x.status));
  expect(await current()).toBe(200);

  // The admin disables the account (C06 → «تعطيل الحساب»).
  await row.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "تعطيل الحساب" }).click();
  await page.getByRole("button", { name: "تعطيل", exact: true }).click();
  await expect(row).toHaveAttribute("data-status", "disabled");

  // The open screen still shows the clinic, but the server refuses the
  // very next requests — the clinic context and its data alike.
  await expect(sidebar(r)).toContainText(C1.name);
  expect(await current()).toBe(401);
  const read = await r.evaluate(async () => { const x = await window.SB.from("patients").select("patient_id"); return { data: x.data, failed: !!x.error }; });
  expect(read).toEqual({ data: null, failed: true });
  // The screen follows: the login with the reason; signing in again is refused.
  await r.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(r.locator("#login-email")).toBeVisible();
  await expect(r.locator(".tenant-notice")).toContainText("سجّل الدخول من جديد");
  await clinicLogin(r, email);
  await expect(r.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(r)).toHaveCount(0);
  // From the main site no clinic is left for this account (S06).
  await r.goto("/");
  await rootLogin(r, email);
  await expect(r.locator(".tenant-status")).toHaveAttribute("data-status", "no-clinic");
  await rec.close();
});

// ── AT-07 ───────────────────────────────────────────────────────────────
test("AT-07 the Super Admin turns billing off: the module leaves the clinic's screens, the API refuses its operations, and the data is kept", async ({ page, browser, baseURL, playwright }) => {
  const clinic = await otherBrowser(browser, baseURL);
  const c = clinic.page;
  await c.goto("/?org=demo-physio#/payments");
  await clinicLogin(c, "admin@demo-physio.test");
  await expect(c.locator("main")).toContainText("INV-PHY-B1-1");
  const invoices = () => c.evaluate(async () => {
    const r = await window.SB.from("invoices").select("invoice_id", { count: "exact" });
    return { count: r.count, code: r.error && r.error.code };
  });
  const before = await invoices();
  expect(before.count).toBeGreaterThan(0);

  let off = false;
  try {
    // A04 → «الميزات»: switching «الفواتير والمدفوعات» off asks first.
    await panel(page, `#/clinics/${ORG_ID.physio}/modules`);
    const billing = sw(page, "الفواتير والمدفوعات");
    await expect(billing).toHaveAttribute("aria-checked", "true");
    await billing.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("تبقى بياناتها محفوظة");
    await dlg.getByRole("button", { name: "تعطيل الوحدة" }).click();
    off = true;
    await expect(paToast(page, "تم الحفظ")).toBeVisible();
    await expect(billing).toHaveAttribute("aria-checked", "false");

    // The clinic: the pages are gone, a link to one explains why.
    await c.reload();
    await expect(c.getByRole("heading", { name: "هذه الميزة غير مفعلة لعيادتك" })).toBeVisible();
    await expect(c.locator("main")).not.toContainText("INV-PHY-B1-1");
    for (const route of ["payments", "packages"]) await expect(sidebar(c).locator(`[data-route="${route}"]`)).toHaveCount(0);
    await expect(sidebar(c).locator('[data-route="patients"]')).toBeVisible();
    // The API refuses billing reads and writes, whatever the page sends.
    expect(await invoices()).toEqual({ count: null, code: "module_disabled" });
    const ops = await c.evaluate(async () => {
      const rpc = await window.SB.rpc("list_invoices_filtered", {});
      const pay = await window.SB.rpc("record_quick_payment", { p_patient_id: "P-PHY-01", p_allocations: [], p_method: "cash" });
      const ins = await window.SB.from("invoices").insert({ invoice_id: "INV-AT07-" + Date.now(), patient_id: "P-PHY-01", amount: 1 });
      return [rpc.error && rpc.error.code, pay.error && pay.error.code, ins.error && ins.error.code];
    });
    expect(ops).toEqual(["module_disabled", "module_disabled", "module_disabled"]);

    // On again: the same invoices are back.
    await billing.click();
    await expect(paToast(page, "تم الحفظ")).toBeVisible();
    await expect(billing).toHaveAttribute("aria-checked", "true");
    off = false;
    await c.reload();
    await expect(c.locator("main")).toContainText("INV-PHY-B1-1");
    await expect(sidebar(c).locator('[data-route="payments"]')).toBeVisible();
    expect(await invoices()).toEqual(before);
  } finally {
    if (off) {
      await restoreAs(playwright, baseURL, async (sa) => {
        const d = await (await sa.get(`/api/platform/organizations/${ORG_ID.physio}`)).json();
        const codes = d.modules.filter((m) => m.enabled).map((m) => m.code).concat("core.billing");
        await sa.put(`/api/platform/organizations/${ORG_ID.physio}/modules`, { data: { codes } });
      });
    }
    await clinic.close();
  }
});

// ── AT-08 ───────────────────────────────────────────────────────────────
test("AT-08 a user of clinic A gets neither a file of clinic B's patient nor a working download link for it", async ({ page, browser, baseURL }) => {
  // Clinic B: the dental admin uploads a report to a patient's file (C02).
  const b = await otherBrowser(browser, baseURL);
  const bp = b.page;
  await bp.goto("/?org=demo-dental#/patients");
  await clinicLogin(bp, "admin@demo-dental.test");
  await bp.locator("main").getByText("مريض أول — DEN").first().click();
  // The dental patient file (src/dental.jsx): its sections are tabs.
  await bp.getByRole("tab", { name: "الملفات", exact: true }).click();
  const uploaded = bp.waitForResponse((r) => r.url().endsWith("/api/files/upload"));
  await bp.locator('input[type="file"]').setInputFiles({ name: `report-${RUN}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 secret of clinic B ${RUN}`) });
  const up = await uploaded;
  expect(up.status()).toBe(200);
  const filePath = (await up.json()).path;
  await expect(bp.getByText("تم رفع 1 ملف")).toBeVisible();
  // Clinic B itself opens it through a signed link.
  const own = await bp.evaluate(async (p) => {
    const s = await window.SB.storage.from("patient-files").createSignedUrl(p, 60);
    const res = await fetch(s.data.signedUrl);
    return { status: res.status, text: await res.text() };
  }, filePath);
  expect(own.status).toBe(200);
  expect(own.text).toContain(`secret of clinic B ${RUN}`);
  await b.close();

  // Clinic A: the physio admin asks for it every way its client can.
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  const a = await page.evaluate(async (p) => {
    const rows = await window.SB.from("patient_files").select("storage_path").eq("storage_path", p);
    const signed = await window.SB.storage.from("patient-files").createSignedUrl(p, 60);
    // The download address a link or <img> would use, naming clinic A.
    const direct = await fetch("/api/files/object/patient-files/" + p.split("/").map(encodeURIComponent).join("/") + "?org=demo-physio", { credentials: "include" });
    // … and naming clinic B: A is no member there.
    const asB = await fetch("/api/files/object/patient-files/" + p.split("/").map(encodeURIComponent).join("/") + "?org=demo-dental", { credentials: "include" });
    return { rows: rows.data, link: signed.data && signed.data.signedUrl, signErr: !!signed.error,
             direct: direct.status, body: await direct.text(), asB: asB.status, bodyB: await asB.text() };
  }, filePath);
  expect(a.rows).toEqual([]);
  expect(a.link).toBeFalsy();
  expect(a.signErr).toBe(true);
  expect(a.direct).toBe(404);
  expect(a.body).not.toContain("secret of clinic B");
  expect(a.asB).toBe(403);
  expect(a.bodyB).not.toContain("secret of clinic B");
});

// ── AT-09 ───────────────────────────────────────────────────────────────
test("AT-09 a clinic admin cannot give anyone, themselves included, the Super Admin role; the attempt is refused and recorded as a security event", async ({ page, browser, baseURL }) => {
  test.skip(!C1.member, "needs the clinic and member of AT-06");
  await page.goto(`/?org=${C1.slug}`);
  await clinicLogin(page, C1.owner, C1.ownerPassword);
  await openUsers(page);
  // The form offers the clinic's roles only.
  const row = page.locator(`tr[data-member="${C1.member}"]`);
  await row.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "تعديل الدور والفروع" }).click();
  const roles = await page.locator("#member-role option").evaluateAll((os) => os.map((o) => o.value).sort());
  expect(roles).toEqual(["admin", "doctor", "receptionist", "therapist"]);
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  // Their own row offers no role change at all.
  await page.locator(`tr[data-member="${C1.owner}"]`).getByRole("button", { name: "المزيد" }).click();
  await expect(page.getByRole("button", { name: "تغيير كلمة المرور" }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "تعديل الدور والفروع" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Whatever the client sends, the server refuses it.
  const tries = await page.evaluate(async ({ member, owner }) => {
    const list = (await window.ClinicApi.request("GET", "/org/members")).data;
    const other = list.find((m) => m.email === member);
    const me = list.find((m) => m.email === owner);
    const a = await window.ClinicApi.request("PATCH", `/org/members/${other.id}`, { role: "super_admin" });
    const b = await window.ClinicApi.request("PATCH", `/org/members/${me.id}`, { role: "super_admin" });
    return { other: [a.status, a.error && a.error.code], self: [b.status, b.error && b.error.code] };
  }, { member: C1.member, owner: C1.owner });
  expect(tries.other).toEqual([400, "invalid_role"]);
  expect(tries.self[0]).toBe(400);
  await page.reload();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(page.locator(`tr[data-member="${C1.member}"]`)).toContainText("موظف استقبال");

  // The Super Admin sees the refused attempts in the audit log (A07).
  const sa = await otherBrowser(browser, baseURL);
  await panel(sa.page, `#/audit?organization_id=${C1.id}&action=member.update`);
  const denied = sa.page.locator("table[data-audit] tbody tr[data-action='member.update']").filter({ has: sa.page.locator("[data-result=denied]") });
  await expect(denied.first()).toBeVisible();
  await expect(denied.first()).toContainText("مرفوضة");
  await expect(denied.first()).toContainText(C1.owner);
  expect(await denied.count()).toBeGreaterThanOrEqual(1);
  await sa.close();
});

// ── AT-10 ───────────────────────────────────────────────────────────────
test("AT-10 a clinic suspended by the Super Admin gets no working sessions for its data, and its records are kept for 6 months", async ({ page, browser, baseURL, playwright }) => {
  const member = await otherBrowser(browser, baseURL);
  const m = member.page;
  await m.goto("/?org=demo-dental#/patients");
  await clinicLogin(m, "admin@demo-dental.test");
  await expect(m.locator("main").getByText("مريض أول — DEN").first()).toBeVisible();
  const current = () => m.evaluate(() => window.ClinicApi.request("GET", "/orgs/current").then((r) => [r.status, r.error && r.error.code]));
  expect((await current())[0]).toBe(200);

  let suspended = false;
  try {
    await panel(page, `#/clinics/${ORG_ID.dental}`);
    await page.getByRole("button", { name: "إيقاف العيادة" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("6 أشهر");
    await dlg.getByLabel("سبب الإيقاف").fill("اختبار القبول AT-10");
    await dlg.getByRole("button", { name: "إيقاف العيادة" }).click();
    suspended = true;
    await expect(paToast(page, "أُوقفت العيادة")).toBeVisible();
    const until = new Date();
    until.setMonth(until.getMonth() + 6);
    await expect(page.locator("[data-retention]")).toContainText(`البيانات محفوظة حتى ${arDay(until)}`);

    // The open session's next request is refused by the server …
    expect(await current()).toEqual([403, "org_inactive"]);
    // … the screen signs out, and the clinic's address offers no login.
    await m.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(sidebar(m)).toHaveCount(0);
    await m.reload();
    await expect(m.locator(".tenant-status")).toHaveAttribute("data-status", "suspended");
    await expect(m.getByText("هذه العيادة متوقفة حاليًا. تواصل مع إدارة المنصة.")).toBeVisible();
    await expect(m.locator("#login-email")).toHaveCount(0);
    // From the main site the account finds no open clinic.
    await m.goto("/");
    await rootLogin(m, "admin@demo-dental.test");
    await expect(m.locator(".tenant-status")).toHaveAttribute("data-status", "no-clinic");
    await m.getByRole("button", { name: "تسجيل الخروج" }).click();

    // Reactivated (A04): the same records are there.
    await page.getByRole("button", { name: "إعادة تفعيل" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "إعادة تفعيل" }).click();
    await expect(paToast(page, "العيادة نشطة الآن")).toBeVisible();
    suspended = false;
    await expect(page.locator("[data-retention]")).toHaveCount(0);
    await m.goto("/?org=demo-dental#/patients");
    await clinicLogin(m, "admin@demo-dental.test");
    await expect(m.locator("main").getByText("مريض أول — DEN").first()).toBeVisible();
    await expect(m.locator("main").getByText("مريضة رابعة — DEN").first()).toBeVisible();
  } finally {
    if (suspended) {
      await restoreAs(playwright, baseURL, (sa) => sa.post(`/api/platform/organizations/${ORG_ID.dental}/status`, { data: { status: "active" } }));
    }
    await member.close();
  }
});

// ── AT-11 / AT-12 ───────────────────────────────────────────────────────
test("AT-11 migrating the current clinic's data matches the saved migration report", async () => {
  test.skip(true, "No screen: the production migration (plan task 4.7, docs/08) is a database procedure verified by its own count/relations/files report, not in the browser.");
});

test("AT-12 a used slug is changed by the approved policy and old links redirect or stop working", async () => {
  test.skip(true, "No screen and no policy yet: slug changes are an open question (PRD question 5, plan task 4.6); the panel cannot change a slug.");
});

// ── AT-13 ───────────────────────────────────────────────────────────────
test("AT-13 a visitor opening an unknown or invalid clinic address gets a safe page that reveals nothing internal", async ({ page, baseURL }) => {
  const port = new URL(baseURL).port;
  const internal = /error|exception|stack|sql|select |postgres|de000000|node_modules|undefined|null|\bat [A-Za-z.]+ \(/i;
  for (const url of [
    `/?org=no-such-clinic-${RUN}`,
    "/?org=Bad_Slug!",
    `/?org=${encodeURIComponent("../../etc/passwd")}`,
    `http://no-such-${RUN}.localhost:${port}/`,
  ]) {
    await page.goto(url);
    await expect(page.locator(".tenant-status"), url).toHaveAttribute("data-status", "not-found");
    await expect(page.getByRole("heading", { name: "لا توجد عيادة بهذا الرابط" })).toBeVisible();
    await expect(page.getByRole("link", { name: "الموقع الرئيسي" })).toBeVisible();
    await expect(page.locator("#login-email")).toHaveCount(0);
    expect(await page.locator("body").innerText(), url).not.toMatch(internal);
  }
  // The answer behind the page says «not found» and nothing more.
  const r = await page.request.get(`/api/orgs/resolve?slug=no-such-clinic-${RUN}`);
  expect(r.status()).toBe(404);
  const body = await r.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(JSON.stringify(body)).not.toMatch(/sql|stack|select|postgres/i);
  // The main-site link leads to the login, not to any clinic.
  await page.getByRole("link", { name: "الموقع الرئيسي" }).click();
  await expect(page.locator("#root-email")).toBeVisible();
  test.info().annotations.push({
    type: "not-covered",
    description: "Invalid certificates: TLS ends at the host's wildcard certificate (plan task 1.8); the browser refuses an invalid certificate before the app loads, so the local http stack cannot show it.",
  });
});

// ── AT-14 ───────────────────────────────────────────────────────────────
test("AT-14 the admin of a dental clinic adds a second branch: it is created and used for bookings, staff and reports", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  // The Super Admin: a plan with at most 2 branches (A06), a dental clinic on it (A03).
  await panel(page, "#/plans");
  await page.getByRole("button", { name: "خطة جديدة" }).click();
  const planDlg = page.getByRole("dialog");
  await planDlg.getByLabel("الاسم").fill(C2.plan);
  await planDlg.getByLabel("الرمز").fill(C2.planCode);
  await planDlg.getByLabel("حد الفروع").fill("2");
  await planDlg.getByRole("button", { name: "إنشاء الخطة" }).click();
  await expect(paToast(page, `أُنشئت الخطة «${C2.plan}»`)).toBeVisible();
  await wizardToLastStep(page, { name: C2.name, slug: C2.slug, specialty: "طب الأسنان", plan: C2.plan, email: C2.owner });
  const mark = readOutbox().length;
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();
  await expect(page.locator("[data-wizard-done]")).toBeVisible();
  const link = await waitForMailLink(C2.owner, /\?invite=/, mark);

  // The first admin accepts and adds «فرع الدقي» (C07).
  const admin = await otherBrowser(browser, baseURL);
  const a = admin.page;
  await acceptAsNew(a, link, C2.name, "مدير عيادة الأسنان");
  C2.ready = true;
  await sidebar(a).locator('[data-route="branches"]').click();
  await expect(a.getByTestId("branch-counter")).toHaveText(/الفروع النشطة:\s*1\s*من\s*2/);
  await a.getByRole("button", { name: "إضافة فرع" }).first().click();
  await a.locator("#branch-name").fill("فرع الدقي");
  await a.locator("#branch-address").fill("الدقي، الجيزة");
  await a.locator("#branch-phone").fill("0233330000");
  await a.getByRole("button", { name: "إضافة الفرع" }).click();
  const card = a.locator("[data-branch-card]").filter({ hasText: "فرع الدقي" });
  await expect(card).toHaveAttribute("data-status", "active");
  await expect(a.getByTestId("branch-counter")).toHaveText(/الفروع النشطة:\s*2\s*من\s*2/);
  const branch2 = await card.getAttribute("data-branch-card");

  // Staff (C06): the branch is offered to invitations and new accounts; a
  // specialist's account is made for it.
  await openUsers(a);
  await a.getByRole("button", { name: "دعوة موظف" }).click();
  await expect(a.locator(`#staff-invite-branch-${branch2}`)).toBeVisible();
  await a.getByRole("button", { name: "إلغاء", exact: true }).click();
  const thEmail = `atd-th-${RUN}@e2e.test`;
  await a.getByRole("button", { name: "إنشاء مستخدم" }).click();
  await a.getByRole("textbox", { name: "الاسم الكامل" }).fill("أخصائية الدقي");
  await a.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(thEmail);
  await a.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await a.getByRole("combobox", { name: "الدور" }).selectOption("therapist");
  for (const box of await a.locator('input[id^="create-user-branch-"]').all()) {
    await box.setChecked((await box.getAttribute("id")) === `create-user-branch-${branch2}`);
  }
  await a.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(a.getByText("تم إنشاء المستخدم")).toBeVisible();
  await expect(a.locator(`tr[data-member="${thEmail}"]`)).toContainText("فرع الدقي");
  await expect(a.locator(`tr[data-member="${thEmail}"]`)).not.toContainText("الفرع الرئيسي");
  // … and put on the bookable roster (a department and the specialist).
  await a.locator('[data-settings-tab="depts"]').click();
  await a.getByRole("button", { name: "إضافة قسم" }).click();
  await a.getByRole("dialog").locator("input").first().fill("طب الأسنان العام");
  await a.getByRole("dialog").getByRole("button", { name: "حفظ" }).click();
  await expect(a.getByText("تمت إضافة القسم")).toBeVisible();
  await a.getByRole("button", { name: "إضافة أخصائي" }).click();
  const specDlg = a.getByRole("dialog");
  const account = specDlg.locator("select").first();
  await expect(account.locator("option", { hasText: thEmail })).toHaveCount(1);
  await account.selectOption(await account.locator("option", { hasText: thEmail }).getAttribute("value"));
  await specDlg.getByRole("button", { name: "حفظ" }).click();
  await expect(a.getByText("تمت إضافة الأخصائي")).toBeVisible();

  // Booking (C03) in «فرع الدقي».
  await sidebar(a).locator('[data-route="appointments"]').click();
  await picker(a).click();
  await a.getByRole("option").filter({ hasText: "فرع الدقي" }).click();
  await expect(a.locator(".topbar")).toContainText("فرع الدقي");
  const patient = `مريض فرع الدقي ${RUN}`;
  await a.getByRole("button", { name: "حجز جديد" }).click();
  await a.getByRole("button", { name: "مريض جديد" }).click();
  await a.getByPlaceholder("الاسم الكامل").fill(patient);
  await a.getByPlaceholder("+20 1xx xxx xxxx").fill("011" + String(Date.now()).slice(-8));
  await a.getByRole("button", { name: "متابعة" }).click();
  await a.getByRole("button", { name: /أخصائية الدقي/ }).click();
  await a.getByRole("button", { name: "متابعة بدون طبيب" }).click();
  await a.getByRole("button", { name: "غدًا" }).click();
  await a.locator("button.mono:not([disabled])").filter({ hasText: /^1[2-7]:[0-5]\d$/ }).first().click();
  const saved = a.waitForRequest((r) => r.url().endsWith("/api/data") && (r.postDataJSON() || {}).table === "bookings"
    && ["insert", "upsert"].includes((r.postDataJSON() || {}).action));
  await a.getByRole("button", { name: "تأكيد الحجز" }).click();
  expect((await saved).headers()["x-branch-id"]).toBe(branch2);
  await expect(a.getByText("تم تأكيد الحجز")).toBeVisible();
  const tomorrow = await a.evaluate(() => new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  await a.locator('input[type="date"]').first().fill(tomorrow);
  await expect(a.locator("div[draggable=true]").filter({ hasText: patient })).toBeVisible();
  // The main branch's calendar does not have it.
  await picker(a).click();
  await a.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  await expect(a.locator(".topbar")).toContainText("الفرع الرئيسي");
  await a.locator('input[type="date"]').first().fill(tomorrow);
  await expect(a.locator(".h3").filter({ hasText: /غدًا/ })).toBeVisible();
  await expect(a.locator("div[draggable=true]").filter({ hasText: patient })).toHaveCount(0);

  // Reports (C05) are read for the branch chosen in the picker.
  await picker(a).click();
  await a.getByRole("option").filter({ hasText: "فرع الدقي" }).click();
  await sidebar(a).locator('[data-route="reports"]').click();
  await expect(a.locator(".report-branch")).toContainText("فرع الدقي");
  await picker(a).click();
  await a.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  await expect(a.locator(".report-branch")).toContainText("الفرع الرئيسي");
  await admin.close();
});

// ── AT-15 ───────────────────────────────────────────────────────────────
test("AT-15 the clinic admin invites a receptionist for branch 2: the invitation arrives, and once accepted the receptionist sees branch 2 only", async ({ page, browser, baseURL }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await openUsers(page);
  const email = `at15-${RUN}@e2e.test`;
  const mark = readOutbox().length;
  await inviteInUi(page, email, "receptionist", ["br-demo-physio-2"]);
  await expect(page.locator(`tr[data-invite="${email}"]`)).toContainText("فرع المعادي");
  const link = await waitForMailLink(email, /\?invite=/, mark);
  const mail = readOutbox().slice(mark).find((x) => JSON.stringify(x.to).includes(email));
  expect(mail.subject).toContain(PHYSIO);

  const rec = await otherBrowser(browser, baseURL);
  const r = rec.page;
  await acceptAsNew(r, link, PHYSIO, "استقبال المعادي");
  await expect(picker(r)).toContainText("فرع المعادي");
  await picker(r).click();
  await expect(r.getByRole("option")).toHaveCount(1);
  await picker(r).click();
  // The role's screens only.
  await expect(sidebar(r).locator('[data-route="settings"]')).toHaveCount(0);
  await expect(sidebar(r).locator('[data-route="branches"]')).toHaveCount(0);
  // Branch 2's bookings and invoices, none of branch 1.
  await sidebar(r).locator('[data-route="appointments"]').click();
  await expect(r.locator("main").getByText("مريض ثالث — PHY").first()).toBeVisible();
  await expect(r.locator("main").getByText("مريض أول — PHY")).toHaveCount(0);
  await sidebar(r).locator('[data-route="payments"]').click();
  await expect(r.locator("main")).toContainText("INV-PHY-B2-1");
  await expect(r.locator("main")).not.toContainText("INV-PHY-B1-1");
  // Asking for branch 1 anyway (X-Branch-Id) opens nothing of it.
  const branches = await r.evaluate(async () => {
    window.ACTIVE_BRANCH_ID = "br-demo-physio-1";
    try {
      const x = await window.SB.from("bookings").select("booking_id,branch_id");
      return (x.data || []).map((b) => b.branch_id);
    } finally { window.ACTIVE_BRANCH_ID = "br-demo-physio-2"; }
  });
  expect(branches.length).toBeGreaterThan(0);
  expect([...new Set(branches)]).toEqual(["br-demo-physio-2"]);
  await rec.close();
});

// ── AT-16 ───────────────────────────────────────────────────────────────
test("AT-16 on a plan of at most 2 branches, adding a third branch is refused with the plan's limit", async ({ page }) => {
  test.skip(!C2.ready, "needs the two-branch clinic of AT-14");
  await page.goto(`/?org=${C2.slug}#/branches`);
  await clinicLogin(page, C2.owner);
  await expect(page.getByTestId("branch-counter")).toHaveText(/الفروع النشطة:\s*2\s*من\s*2/);
  await expect(page.getByText("وصلت إلى حد الفروع في خطتك")).toBeVisible();
  await page.getByRole("button", { name: "إضافة فرع" }).first().click();
  await page.locator("#branch-name").fill("فرع ثالث");
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  await expect(page.locator(".branch-form-error")).toContainText("تجاوزت حد الفروع في خطتك");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.locator("[data-branch-card]")).toHaveCount(2);
  await picker(page).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option").filter({ hasText: "فرع ثالث" })).toHaveCount(0);
});
