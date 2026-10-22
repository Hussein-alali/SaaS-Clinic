// The clinic admin's screens in the browser (docs/03-App-Flow.md C06 and
// C07, docs/06 tasks 3.7, 3.8, 2.14, 2.15): branches (add / edit /
// deactivate / re-activate within the plan's branch limit, never delete),
// the branch context of bookings and reports, staff and invitations
// (invite with role + branches, S03 acceptance from the e-mail, resend,
// revoke, «e-mail not sent», the plan's user limit, «إنشاء مستخدم»,
// deactivation), and the screens other roles do not get.
//
// Runs against the API-served dist/ with the dev seed (see fixtures.cjs).
// Tests that change branches or plan limits work on a clinic of their own
// (created here through /api/platform as the Super Admin), so the seeded
// clinics keep their two branches for e2e/tenant.spec.cjs. Accounts and
// invitations made here use unique e-mails: the spec can run again on the
// same database.
const { test, expect, PASSWORD, readOutbox } = require("./fixtures.cjs");
const { routeCdn } = require("../scripts/pw-cdn.cjs");

const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const SUPER = "super@clinicsys.test";
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── helpers ─────────────────────────────────────────────────────────────
// An API client signed in as `email` (its own cookie jar).
async function apiAs(playwright, baseURL, email, { platform = false, org = null } = {}) {
  const headers = { "X-Requested-With": "clinicsys" };
  if (platform) headers["X-Platform"] = "1";
  if (org) headers["X-Org-Slug"] = org;
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  const r = await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(r.status(), `API login ${email}`).toBe(200);
  return ctx;
}

// E-mails to `to` sent after the first `after` mails of the outbox.
function mailsTo(to, after = 0) {
  return readOutbox().slice(after).filter((m) => JSON.stringify(m.to || "").includes(to));
}
const linkOf = (mail) => {
  const m = String((mail && (mail.text || mail.html)) || "").match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
};
// The newest invitation link to `to` sent after `after` mails (the API
// sends after answering, so this polls).
async function waitForInvite(to, after = 0) {
  let link = null;
  await expect.poll(() => {
    const mails = mailsTo(to, after).map(linkOf).filter((l) => l && /\?invite=/.test(l));
    link = mails.length ? mails[mails.length - 1] : null;
    return !!link;
  }, { message: `invitation e-mail to ${to}`, timeout: 15_000 }).toBe(true);
  return link;
}
const tokenOf = (link) => new URL(link).searchParams.get("invite");

async function acceptByApi(playwright, baseURL, token, name) {
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys" } });
  const r = await anon.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { data: { name, password: PASSWORD } });
  expect(r.status(), await r.text()).toBe(200);
}

// A clinic of this test's own: plan with the given limits (null = none),
// created by the Super Admin, first admin accepted (password PASSWORD).
async function newClinic(playwright, baseURL, { maxBranches = null, maxUsers = null } = {}) {
  const sa = await apiAs(playwright, baseURL, SUPER, { platform: true });
  const plan = await sa.post("/api/platform/plans", {
    data: { code: `e2e-ca-${uniq()}`, name: "خطة اختبار الإدارة", max_branches: maxBranches, max_users: maxUsers },
  });
  expect(plan.status(), await plan.text()).toBe(201);
  const slug = `ca-${uniq()}`;
  const admin = `ca-admin-${uniq()}@e2e.test`;
  const name = `عيادة الإدارة ${slug}`;
  const mark = readOutbox().length;
  const created = await sa.post("/api/platform/organizations", {
    data: { name, slug, specialty_code: "physio", plan_id: (await plan.json()).id, admin_email: admin },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  await acceptByApi(playwright, baseURL, tokenOf(await waitForInvite(admin, mark)), "مدير عيادة الاختبار");
  return { slug, admin, name, orgId: body.organization.id, mainBranch: body.branches[0].id, sa };
}

// A second, independent browser (another person), with the same CDN
// routes and the same «no uncaught page error» rule as the `page` fixture.
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

async function clinicLogin(page, email, password = PASSWORD) {
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}

const sidebar = (page) => page.locator("aside.sidebar");
const picker = (page) => page.locator("button.branch-switcher");
const card = (page, name) => page.locator("[data-branch-card]").filter({ has: page.locator(".branch-card-name", { hasText: new RegExp(`^${name}$`) }) });
const counter = (page) => page.getByTestId("branch-counter");
const usersCounter = (page) => page.getByTestId("users-counter");
const inviteRow = (page, email) => page.locator(`tr[data-invite="${email}"]`);
const memberRow = (page, email) => page.locator(`tr[data-member="${email}"]`);

async function openUsers(page) {
  await sidebar(page).locator('[data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(page.locator(".staff-panel")).toBeVisible();
  await expect(page.locator(".members-table tbody tr[data-member]").first()).toBeVisible();
}

async function invite(page, email, { role = "receptionist", branches = null } = {}) {
  await page.getByRole("button", { name: "دعوة موظف" }).click();
  await page.locator("#staff-invite-email").fill(email);
  await page.locator("#staff-invite-role").selectOption(role);
  if (branches) {
    for (const box of await page.locator('input[id^="staff-invite-branch-"]').all()) {
      const id = (await box.getAttribute("id")).replace("staff-invite-branch-", "");
      await box.setChecked(branches.includes(id));
    }
  }
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
}

// ── C07: branches ───────────────────────────────────────────────────────
test("C07: the admin adds, edits, deactivates and re-activates branches within the plan's limit; a branch is never deleted (AT-14, AT-16)", async ({ page, playwright, baseURL, browser }) => {
  const clinic = await newClinic(playwright, baseURL, { maxBranches: 2 });
  await page.goto(`/?org=${clinic.slug}`);
  await clinicLogin(page, clinic.admin);
  await expect(sidebar(page)).toContainText(clinic.name);
  await sidebar(page).locator('[data-route="branches"]').click();
  await expect(page).toHaveURL(/#\/branches$/);
  await expect(page.locator(".h1", { hasText: "الفروع" })).toBeVisible();

  // One branch: the counter, and the last active branch cannot be deactivated.
  await expect(counter(page)).toHaveText(/الفروع النشطة:\s*1\s*من\s*2/);
  const main = card(page, "الفرع الرئيسي");
  await expect(main).toHaveAttribute("data-status", "active");
  await expect(main).toContainText("الفرع الحالي");
  await expect(main.getByRole("button", { name: "تعطيل الفرع الرئيسي" })).toBeDisabled();
  await expect(main).toContainText("آخر فرع نشط لا يمكن تعطيله");

  // Add: the name is required; the second branch is within the plan.
  await page.getByRole("button", { name: "إضافة فرع" }).first().click();
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  await expect(page.getByText("اسم الفرع مطلوب")).toBeVisible();
  await page.locator("#branch-name").fill("الفرع الرئيسي");
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  await expect(page.getByText("يوجد فرع بهذا الاسم في عيادتك بالفعل")).toBeVisible();
  await page.locator("#branch-name").fill("فرع الدقي");
  await page.locator("#branch-address").fill("12 ش التحرير، الدقي");
  await page.locator("#branch-phone").fill("0233334444");
  await page.locator("#branch-rooms").fill("3");
  // Working hours: Saturday 10:00–18:00, Friday stays closed.
  await page.locator('.branch-hours-row[data-day="sat"] input[type=time]').first().fill("10:00");
  await page.locator('.branch-hours-row[data-day="sat"] input[type=time]').nth(1).fill("18:00");
  await expect(page.locator('.branch-hours-row[data-day="fri"] input[type=checkbox]')).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/data") && r.request().postDataJSON().action === "insert");
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  expect((await saved).status()).toBe(200);
  const dokki = card(page, "فرع الدقي");
  await expect(dokki).toBeVisible();
  await expect(dokki).toContainText("12 ش التحرير، الدقي");
  await expect(dokki).toContainText("0233334444");
  await expect(dokki.locator(".branch-card-rooms")).toContainText("3");
  await expect(dokki.locator(".branch-card-hours")).toContainText("السبت");
  await expect(dokki.locator(".branch-card-hours")).toContainText("10:00–18:00");
  await expect(dokki.locator(".branch-card-hours")).toContainText("باقي الأيام: مغلق");
  await expect(counter(page)).toHaveText(/الفروع النشطة:\s*2\s*من\s*2/);
  await expect(page.getByText("وصلت إلى حد الفروع في خطتك")).toBeVisible();
  await expect(main.getByRole("button", { name: "تعطيل الفرع الرئيسي" })).toBeEnabled();
  const dokkiId = await dokki.getAttribute("data-branch-card");
  // The sidebar picker offers it right away.
  await picker(page).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await picker(page).click();

  // A third branch: refused by the plan, with the reason; nothing is added.
  await page.getByRole("button", { name: "إضافة فرع" }).first().click();
  await page.locator("#branch-name").fill("فرع ثالث");
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  await expect(page.locator(".branch-form-error")).toContainText("تجاوزت حد الفروع في خطتك");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.locator("[data-branch-card]")).toHaveCount(2);

  // Edit: name, phone and hours (Sunday opened, Saturday closed).
  await dokki.getByRole("button", { name: "تعديل فرع الدقي" }).click();
  await expect(page.locator("#branch-name")).toHaveValue("فرع الدقي");
  await page.locator("#branch-name").fill("فرع الدقي الجديد");
  await page.locator("#branch-phone").fill("0233335555");
  await page.locator('.branch-hours-row[data-day="sat"] input[type=checkbox]').uncheck();
  await page.locator('.branch-hours-row[data-day="sun"] input[type=time]').first().fill("11:00");
  await page.locator('.branch-hours-row[data-day="sun"] input[type=time]').nth(1).fill("19:00");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  const edited = card(page, "فرع الدقي الجديد");
  await expect(edited).toContainText("0233335555");
  await expect(edited.locator(".branch-card-hours")).toContainText("الأحد");
  await expect(edited.locator(".branch-card-hours")).toContainText("11:00–19:00");
  await expect(edited.locator(".branch-card-hours")).not.toContainText("السبت");
  await page.reload();
  await expect(card(page, "فرع الدقي الجديد")).toContainText("0233335555");

  // A receptionist of this branch only (made through the API) — used
  // below once the branch is inactive.
  const admin = await apiAs(playwright, baseURL, clinic.admin, { org: clinic.slug });
  const recEmail = `ca-rec-${uniq()}@e2e.test`;
  const mark = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email: recEmail, role: "receptionist", branch_ids: [dokkiId] } });
  expect(inv.status(), await inv.text()).toBe(201);
  await acceptByApi(playwright, baseURL, tokenOf(await waitForInvite(recEmail, mark)), "استقبال الدقي");

  // Deactivate (no delete anywhere): the branch moves to «الفروع المعطّلة»,
  // leaves the picker, and frees a place in the plan.
  await expect(page.getByRole("button", { name: /حذف/ })).toHaveCount(0);
  await card(page, "فرع الدقي الجديد").getByRole("button", { name: "تعطيل فرع الدقي الجديد" }).click();
  await expect(page.getByText("لا يُحذف أي فرع")).toBeVisible();
  await page.getByRole("button", { name: "تعطيل الفرع", exact: true }).click();
  await expect(card(page, "فرع الدقي الجديد")).toHaveAttribute("data-status", "inactive");
  await expect(page.getByText("الفروع المعطّلة")).toBeVisible();
  await expect(counter(page)).toHaveText(/الفروع النشطة:\s*1\s*من\s*2/);
  await picker(page).click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("الفرع الرئيسي");
  await picker(page).click();

  // The database keeps the row: a DELETE through the API removes nothing.
  const del = await page.request.post("/api/data", {
    headers: { "X-Requested-With": "clinicsys", "X-Org-Slug": clinic.slug },
    data: { table: "branches", action: "delete", filters: [{ column: "id", op: "eq", value: dokkiId }], count: "exact" },
  });
  expect(del.status(), await del.text()).toBe(200);
  expect((await del.json()).count).toBe(0);
  const detail = await (await clinic.sa.get(`/api/platform/organizations/${clinic.orgId}`)).json();
  expect(detail.branches.find((b) => b.id === dokkiId)).toMatchObject({ name: "فرع الدقي الجديد", status: "inactive" });

  // The receptionist whose only branch is inactive: data readable, a
  // banner says why, and a new booking is refused.
  const rec = await otherBrowser(browser, baseURL);
  await rec.page.goto(`/?org=${clinic.slug}`);
  await clinicLogin(rec.page, recEmail);
  await expect(sidebar(rec.page)).toBeVisible();
  await expect(rec.page.getByText("الفرع «فرع الدقي الجديد» معطّل")).toBeVisible();
  await expect(picker(rec.page)).toContainText("فرع معطّل — للعرض فقط");
  const refused = await rec.page.evaluate(() => window.KineticData.upsert("appts", { booking_id: "BK-E2E-OFF", patient_id: "P-NONE", date: "2026-10-30", time: "10:00" })
    .then(() => "saved", (e) => e.message));
  expect(refused).toContain("هذا الفرع معطّل");
  // Any other new row there is refused by the server (409 branch_inactive,
  // task 3.18), with the Arabic reason.
  const refusedInvoice = await rec.page.evaluate(() => window.KineticData.upsert("payments", { invoice_id: "INV-E2E-OFF-" + Date.now(), amount: 10 })
    .then((r) => r._error, (e) => e.message));
  expect(refusedInvoice).toBe("هذا الفرع معطّل — اختر فرعًا نشطًا لإضافة حجوزات أو مدفوعات جديدة");
  await rec.close();

  // The freed place takes a new branch; re-activating the old one is then
  // over the plan's limit and says so.
  await page.getByRole("button", { name: "إضافة فرع" }).first().click();
  await page.locator("#branch-name").fill("فرع ثالث");
  await page.getByRole("button", { name: "إضافة الفرع" }).click();
  await expect(card(page, "فرع ثالث")).toHaveAttribute("data-status", "active");
  await expect(counter(page)).toHaveText(/الفروع النشطة:\s*2\s*من\s*2/);
  await card(page, "فرع الدقي الجديد").getByRole("button", { name: "إعادة تفعيل فرع الدقي الجديد" }).click();
  await page.getByRole("button", { name: "إعادة التفعيل", exact: true }).click();
  await expect(page.locator(".ca-alert-error")).toContainText("تجاوزت حد الفروع في خطتك");
  await expect(card(page, "فرع الدقي الجديد")).toHaveAttribute("data-status", "inactive");

  // With a place free again, re-activation works.
  await card(page, "فرع ثالث").getByRole("button", { name: "تعطيل فرع ثالث" }).click();
  await page.getByRole("button", { name: "تعطيل الفرع", exact: true }).click();
  await expect(card(page, "فرع ثالث")).toHaveAttribute("data-status", "inactive");
  await card(page, "فرع الدقي الجديد").getByRole("button", { name: "إعادة تفعيل فرع الدقي الجديد" }).click();
  await page.getByRole("button", { name: "إعادة التفعيل", exact: true }).click();
  await expect(card(page, "فرع الدقي الجديد")).toHaveAttribute("data-status", "active");
  await expect(counter(page)).toHaveText(/الفروع النشطة:\s*2\s*من\s*2/);
});

// ── Branch context: C03 bookings and C05 reports ────────────────────────
test("switching the branch filters the bookings (C03) and the reports (C05)", async ({ page }) => {
  await page.goto("/?org=demo-physio#/appointments");
  await clinicLogin(page, "admin@demo-physio.test");
  const main = page.locator("main");
  await expect(main.getByText("مريض أول — PHY").first()).toBeVisible();
  await expect(main.getByText("مريض ثالث — PHY")).toHaveCount(0);

  await picker(page).click();
  const switched = page.waitForRequest((r) => r.url().endsWith("/api/data") && r.headers()["x-branch-id"] === "br-demo-physio-2");
  await page.getByRole("option").filter({ hasText: "فرع المعادي" }).click();
  await switched;
  await expect(main.getByText("مريض ثالث — PHY").first()).toBeVisible();
  await expect(main.getByText("مريض أول — PHY")).toHaveCount(0);

  // Reports read the same branch-scoped rows and name the branch.
  await sidebar(page).locator('[data-route="reports"]').click();
  await expect(page.locator(".report-branch")).toContainText("فرع المعادي");
  const rows = page.locator("main .tbl tbody").first();
  await expect(rows).toContainText("مريض ثالث — PHY");
  await expect(rows).not.toContainText("مريض أول — PHY");

  await picker(page).click();
  await page.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  await expect(page.locator(".report-branch")).toContainText("الفرع الرئيسي");
  await expect(rows).toContainText("مريض أول — PHY");
  await expect(rows).not.toContainText("مريض ثالث — PHY");
});

// ── C05: «كل الفروع» for the clinic admin (task 3.19) ───────────────────
test("C05 «كل الفروع»: the clinic admin sees every branch with a per-branch breakdown, the current branch only its own rows; other roles keep the current branch", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  if (await page.evaluate(() => window.ACTIVE_BRANCH_ID) !== "br-demo-physio-1") {
    await picker(page).click();
    await page.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  }
  await expect.poll(() => page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-1");

  // A patient and an invoice of this run on each branch (written with that
  // branch's X-Branch-Id, as its own screens would).
  const run = uniq();
  const made = [];
  for (const [n, branch, amount] of [[1, "br-demo-physio-1", 1111], [2, "br-demo-physio-2", 2222]]) {
    const headers = { "X-Requested-With": "clinicsys", "X-Org-Slug": "demo-physio", "X-Branch-Id": branch };
    const name = `مريض التقارير ${n} ${run}`;
    const pid = `P-E2E-RPT-${run}-${n}`;
    let r = await page.request.post("/api/data", { headers, data: { table: "patients", action: "insert", values: { patient_id: pid, name } } });
    expect(r.status(), await r.text()).toBe(200);
    r = await page.request.post("/api/data", { headers, data: { table: "invoices", action: "insert", values: { invoice_id: `INV-E2E-RPT-${run}-${n}`, patient_id: pid, amount, paid: 0 } } });
    expect(r.status(), await r.text()).toBe(200);
    made.push({ name, branch });
  }
  await page.reload();
  await expect(sidebar(page)).toContainText(PHYSIO);
  await sidebar(page).locator('[data-route="reports"]').click();

  const scope = page.getByRole("group", { name: "نطاق التقرير" });
  const pickScope = (name) => scope.getByRole("button", { name, exact: true }).click();
  const rows = page.locator("main .report-rows tbody tr[data-branch]");
  const breakdown = page.locator(".report-branch-breakdown");
  const metric = (branch, key) => breakdown.locator(`tr[data-branch-row="${branch}"] [data-metric="${key}"]`);
  await expect(scope.getByRole("button", { name: "الفرع الحالي" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".report-branch")).toContainText("الفرع: الفرع الرئيسي");
  await page.getByPlaceholder("بحث بالمريض أو طريقة الدفع…").fill(run);

  // Current branch: its own invoice only, no branch breakdown.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(made[0].name);
  await expect(rows.first()).toHaveAttribute("data-branch", "br-demo-physio-1");
  await expect(breakdown).toHaveCount(0);

  // «كل الفروع»: both invoices with their branch, per-branch totals and the
  // clinic total — without changing the branch in use (X-Branch-Id).
  await pickScope("كل الفروع");
  await expect(scope.getByRole("button", { name: "كل الفروع" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".report-branch")).toContainText("كل الفروع");
  await expect(rows).toHaveCount(2);
  await expect(page.locator("main .report-rows thead")).toContainText("الفرع");
  await expect(rows.filter({ hasText: made[0].name })).toHaveAttribute("data-branch", "br-demo-physio-1");
  await expect(rows.filter({ hasText: made[0].name })).toContainText("الفرع الرئيسي");
  await expect(rows.filter({ hasText: made[1].name })).toHaveAttribute("data-branch", "br-demo-physio-2");
  await expect(rows.filter({ hasText: made[1].name })).toContainText("فرع المعادي");
  await expect(breakdown.locator("tr[data-branch-row]")).toHaveCount(3);
  await expect(breakdown.locator('tr[data-branch-row="br-demo-physio-2"]')).toContainText("فرع المعادي");
  await expect(metric("br-demo-physio-1", "count")).toHaveAttribute("data-value", "1");
  await expect(metric("br-demo-physio-2", "count")).toHaveAttribute("data-value", "1");
  await expect(metric("total", "count")).toHaveAttribute("data-value", "2");
  await expect(metric("br-demo-physio-1", "invoiced")).toHaveAttribute("data-value", "1111");
  await expect(metric("br-demo-physio-2", "invoiced")).toHaveAttribute("data-value", "2222");
  await expect(metric("total", "invoiced")).toHaveAttribute("data-value", "3333");
  expect(await page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-1");
  await expect(picker(page)).toContainText("الفرع الرئيسي");
  // Without the search: the clinic total is the sum of the branches.
  await page.getByPlaceholder("بحث بالمريض أو طريقة الدفع…").fill("");
  const value = async (branch, key) => Number(await metric(branch, key).getAttribute("data-value"));
  await expect.poll(() => value("total", "count")).toBeGreaterThan(2);
  expect(await value("total", "count")).toBe(await value("br-demo-physio-1", "count") + await value("br-demo-physio-2", "count"));
  expect(await value("br-demo-physio-2", "count")).toBeGreaterThanOrEqual(2);

  // The search matches the branch name: one branch's rows of the clinic.
  await page.getByPlaceholder("بحث بالمريض أو طريقة الدفع…").fill("فرع المعادي");
  await expect(metric("br-demo-physio-1", "count")).toHaveAttribute("data-value", "0");
  await expect(rows.first()).toBeVisible();
  await expect(rows.and(page.locator('[data-branch="br-demo-physio-1"]'))).toHaveCount(0);

  // The operational tab keeps the scope: today's seeded bookings of both
  // branches are counted.
  await page.locator(".side-tabs .nav-item", { hasText: "التشغيلية" }).click();
  await expect(breakdown.locator("tr[data-branch-row]")).toHaveCount(3);
  await expect.poll(() => value("br-demo-physio-1", "booked")).toBeGreaterThan(0);
  await expect.poll(() => value("br-demo-physio-2", "booked")).toBeGreaterThan(0);
  expect(await value("total", "booked")).toBe(await value("br-demo-physio-1", "booked") + await value("br-demo-physio-2", "booked"));

  // Back to the current branch: branch 1 only again.
  await pickScope("الفرع الحالي");
  await expect(breakdown).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
  await expect(rows.and(page.locator('[data-branch="br-demo-physio-2"]'))).toHaveCount(0);

  // A receptionist of both branches: no choice, the current branch as before.
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await clinicLogin(page, "receptionist2@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await sidebar(page).locator('[data-route="reports"]').click();
  await expect(page.locator(".report-branch")).toContainText("بدّل الفرع من القائمة الجانبية");
  await expect(page.getByRole("group", { name: "نطاق التقرير" })).toHaveCount(0);
  await expect(breakdown).toHaveCount(0);
});

// ── C06: staff and invitations ──────────────────────────────────────────
test("C06: the admin invites a receptionist for branch 2; accepted from the e-mail (S03), that account sees branch 2 only; deactivation ends its session (AT-15, AT-06)", async ({ page, browser, baseURL }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await openUsers(page);
  await expect(usersCounter(page)).toContainText("المستخدمون:");
  await expect(memberRow(page, "admin@demo-physio.test")).toContainText("كل الفروع");
  await expect(memberRow(page, "receptionist2@demo-physio.test")).toContainText("الفرع الرئيسي، فرع المعادي");

  // Validation in the form, then the server's own refusals.
  await page.getByRole("button", { name: "دعوة موظف" }).click();
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.getByText("أدخل البريد الإلكتروني")).toBeVisible();
  await page.locator("#staff-invite-email").fill("not-an-email");
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.getByText("بريد إلكتروني غير صحيح")).toBeVisible();
  await page.locator("#staff-invite-email").fill("receptionist@demo-physio.test");
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.locator(".modal [role=alert]")).toContainText("هذا البريد عضو بالفعل في العيادة");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();

  const email = `ca-b2-${uniq()}@e2e.test`;
  const mark = readOutbox().length;
  // No branch ticked → refused before sending.
  await invite(page, email, { role: "receptionist", branches: [] });
  await expect(page.getByText("اختر فرعًا واحدًا على الأقل")).toBeVisible();
  await page.locator("#staff-invite-branch-br-demo-physio-2").check();
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.getByText(`تم إرسال الدعوة إلى ${email}`)).toBeVisible();
  const row = inviteRow(page, email);
  await expect(row).toHaveAttribute("data-status", "pending");
  await expect(row).toContainText("معلّقة");
  await expect(row).toContainText("موظف استقبال");
  await expect(row).toContainText("فرع المعادي");
  await expect(row).not.toContainText("الفرع الرئيسي");
  // The same e-mail again: a pending invitation exists.
  await invite(page, email, { role: "receptionist", branches: ["br-demo-physio-2"] });
  await expect(page.locator(".modal [role=alert]")).toContainText("توجد دعوة معلّقة لهذا البريد بالفعل");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();

  // S03 in another browser: the link from the e-mail.
  const link = await waitForInvite(email, mark);
  const rec = await otherBrowser(browser, baseURL);
  await rec.page.goto(link);
  await expect(rec.page.locator(".tenant-invite-summary")).toContainText(PHYSIO);
  await expect(rec.page.locator(".tenant-invite-summary")).toContainText("موظف استقبال");
  await rec.page.locator("#invite-name").fill("استقبال المعادي");
  await rec.page.locator("#invite-password").fill(PASSWORD);
  await rec.page.locator("#invite-confirm").fill(PASSWORD);
  await rec.page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();
  await expect(sidebar(rec.page)).toContainText(PHYSIO);
  // Branch 2 only: picker, X-Branch-Id, today's bookings.
  await expect(picker(rec.page)).toContainText("فرع المعادي");
  expect(await rec.page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-2");
  await picker(rec.page).click();
  await expect(rec.page.getByRole("option")).toHaveCount(1);
  await expect(rec.page.getByRole("button", { name: "إضافة فرع جديد" })).toHaveCount(0);
  await picker(rec.page).click();
  await sidebar(rec.page).locator('[data-route="appointments"]').click();
  await expect(rec.page.locator("main").getByText("مريض ثالث — PHY").first()).toBeVisible();
  await expect(rec.page.locator("main").getByText("مريض أول — PHY")).toHaveCount(0);
  // No clinic admin screens for a receptionist.
  await expect(sidebar(rec.page).locator('[data-route="branches"]')).toHaveCount(0);
  await expect(sidebar(rec.page).locator('[data-route="settings"]')).toHaveCount(0);
  // The e-mail's link is on the clinic's host (<slug>.localhost), where the
  // session cookie lives: ask from inside that page.
  const recStatus = () => rec.page.evaluate(() => fetch("/api/orgs/current").then((r) => r.status));
  expect(await recStatus()).toBe(200);

  // The admin's list: an active member of branch 2, the invitation accepted.
  await page.reload();
  await page.locator('[data-settings-tab="users"]').click();
  const member = memberRow(page, email);
  await expect(member).toHaveAttribute("data-status", "active");
  await expect(member).toContainText("استقبال المعادي");
  await expect(member).toContainText("فرع المعادي");
  await expect(inviteRow(page, email)).toHaveCount(0); // no longer waiting
  await page.getByRole("button", { name: /كل الدعوات/ }).click();
  await expect(inviteRow(page, email)).toHaveAttribute("data-status", "accepted");
  await expect(inviteRow(page, email)).toContainText("مقبولة");

  // Deactivate: the member's open session ends on its next request.
  await member.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "تعطيل الحساب" }).click();
  await expect(page.getByText("تُنهى جلساته الحالية فورًا")).toBeVisible();
  await page.getByRole("button", { name: "تعطيل", exact: true }).click();
  await expect(member).toHaveAttribute("data-status", "disabled");
  await expect(member).toContainText("معطّل");
  expect(await recStatus()).toBe(401);
  await rec.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(rec.page.locator("#login-email")).toBeVisible();
  await expect(rec.page.locator(".tenant-notice")).toContainText("سجّل الدخول من جديد");
  await clinicLogin(rec.page, email);
  await expect(rec.page.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(rec.page)).toHaveCount(0);

  // Re-activate: the account signs in again.
  await member.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "إعادة تفعيل الحساب" }).click();
  await page.getByRole("button", { name: "تفعيل", exact: true }).click();
  await expect(member).toHaveAttribute("data-status", "active");
  await clinicLogin(rec.page, email);
  await expect(sidebar(rec.page)).toContainText(PHYSIO);
  await rec.close();
});

test("C06: resend and revoke an invitation; an e-mail that was not sent is flagged until it is re-sent", async ({ page, playwright, baseURL }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await openUsers(page);

  // Resend: a new link replaces the first one.
  const email = `ca-resend-${uniq()}@e2e.test`;
  const mark = readOutbox().length;
  await invite(page, email, { role: "doctor", branches: ["br-demo-physio-1"] });
  await expect(inviteRow(page, email)).toContainText("طبيب");
  const first = await waitForInvite(email, mark);
  const mark2 = readOutbox().length;
  await inviteRow(page, email).getByRole("button", { name: `إعادة إرسال دعوة ${email}` }).click();
  await expect(page.getByText(`أُعيد إرسال الدعوة إلى ${email}`)).toBeVisible();
  const second = await waitForInvite(email, mark2);
  expect(second).not.toBe(first);
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.get(`/api/invitations/${encodeURIComponent(tokenOf(first))}`)).status()).toBe(404);
  expect((await anon.get(`/api/invitations/${encodeURIComponent(tokenOf(second))}`)).status()).toBe(200);

  // Revoke: confirmation, the row leaves the waiting list, the link stops working.
  await inviteRow(page, email).getByRole("button", { name: `إلغاء دعوة ${email}` }).click();
  await expect(page.getByText("لن يعمل رابط الدعوة المرسل إلى")).toBeVisible();
  await page.getByRole("button", { name: "إلغاء الدعوة" }).click();
  await expect(page.getByText(`تم إلغاء دعوة ${email}`)).toBeVisible();
  await expect(inviteRow(page, email)).toHaveCount(0);
  await page.getByRole("button", { name: /كل الدعوات/ }).click();
  await expect(inviteRow(page, email)).toHaveAttribute("data-status", "revoked");
  await expect(inviteRow(page, email)).toContainText("ملغاة");
  await expect(inviteRow(page, email).getByRole("button")).toHaveCount(0);
  const gone = await anon.get(`/api/invitations/${encodeURIComponent(tokenOf(second))}`);
  expect(gone.status()).toBe(410);
  expect((await gone.json()).error.code).toBe("invitation_revoked");
  await page.getByRole("button", { name: /بانتظار القبول/ }).click();

  // «e-mail not sent» is the server's email_status (task 3.15). An SMTP
  // failure is simulated: the create answers email_sent false, and the
  // list reports email_status 'failed' for this invitation → flagged, also
  // after a reload (nothing is kept in the browser); 'pending' shows the
  // neutral «البريد قيد الإرسال»; a real resend clears it.
  const unsent = `ca-unsent-${uniq()}@e2e.test`;
  let forced = "failed";
  await page.route("**/api/org/invitations", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (route.request().method() === "POST") {
      return route.fulfill({ response: res, json: { ...body, email_sent: false, invitation: { ...body.invitation, email_status: "failed" } } });
    }
    const list = Array.isArray(body) ? body.map((i) => (i.email === unsent ? { ...i, email_status: forced } : i)) : body;
    return route.fulfill({ response: res, json: list });
  });
  await invite(page, unsent, { role: "therapist", branches: ["br-demo-physio-1"] });
  await expect(page.getByText(`أُنشئت الدعوة لكن لم يُرسل البريد إلى ${unsent}`)).toBeVisible();
  const flagged = inviteRow(page, unsent);
  await expect(flagged).toHaveAttribute("data-status", "pending");
  await expect(flagged.locator(".invite-unsent")).toHaveText(/لم يُرسل البريد/);
  expect(await page.evaluate(() => sessionStorage.getItem("clinicsys.unsent_invites"))).toBeNull();
  await page.reload();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(inviteRow(page, unsent).locator(".invite-unsent")).toBeVisible();
  // Still being sent according to the server: neutral, not «لم يُرسل».
  forced = "pending";
  await page.reload();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(inviteRow(page, unsent).locator(".invite-sending")).toHaveText(/البريد قيد الإرسال/);
  await expect(inviteRow(page, unsent).locator(".invite-unsent")).toHaveCount(0);
  forced = "failed";
  await page.reload();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(inviteRow(page, unsent).locator(".invite-unsent")).toBeVisible();
  // The real server from here on: the resend's e-mail goes out ('sent').
  await page.unroute("**/api/org/invitations");
  await inviteRow(page, unsent).getByRole("button", { name: `إعادة إرسال دعوة ${unsent}` }).click();
  await expect(page.getByText(`أُعيد إرسال الدعوة إلى ${unsent}`)).toBeVisible();
  await expect(inviteRow(page, unsent).locator("[data-email-status]")).toHaveCount(0);
  const listed = await (await page.request.get("/api/org/invitations", { headers: { "X-Requested-With": "clinicsys", "X-Org-Slug": "demo-physio" } })).json();
  expect(listed.find((i) => i.email === unsent)).toMatchObject({ status: "pending", email_status: "sent" });
  // Clean up: the seat is freed.
  await inviteRow(page, unsent).getByRole("button", { name: `إلغاء دعوة ${unsent}` }).click();
  await page.getByRole("button", { name: "إلغاء الدعوة" }).click();
  await expect(inviteRow(page, unsent)).toHaveCount(0);
});

test("C06: the users counter follows the plan; at the limit an invitation is refused with the reason; «إنشاء مستخدم» and role changes still work; no Super Admin role (AT-09)", async ({ page, playwright, baseURL }) => {
  const clinic = await newClinic(playwright, baseURL, { maxUsers: 3 });
  await page.goto(`/?org=${clinic.slug}`);
  await clinicLogin(page, clinic.admin);
  await expect(sidebar(page)).toContainText(clinic.name);
  await openUsers(page);
  await expect(usersCounter(page)).toHaveText(/المستخدمون:\s*1\s*من\s*3/);
  await expect(memberRow(page, clinic.admin)).toContainText("(أنا)");

  // «إنشاء مستخدم»: an account with a password set by the admin.
  const created = `ca-created-${uniq()}@e2e.test`;
  await page.getByRole("button", { name: "إنشاء مستخدم" }).click();
  await page.getByRole("textbox", { name: "الاسم الكامل" }).fill("موظف أنشأه المدير");
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(created);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await page.getByRole("combobox", { name: "الدور" }).selectOption("receptionist");
  await expect(page.locator(`#create-user-branch-${clinic.mainBranch}`)).toBeChecked();
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page.getByText("تم إنشاء المستخدم")).toBeVisible();
  const row = memberRow(page, created);
  await expect(row).toHaveAttribute("data-status", "active");
  await expect(row).toContainText("موظف أنشأه المدير");
  await expect(row).toContainText("موظف استقبال");
  await expect(row).toContainText("الفرع الرئيسي");
  await expect(usersCounter(page)).toHaveText(/المستخدمون:\s*2\s*من\s*3/);
  // The account signs in with that password.
  await apiAs(playwright, baseURL, created, { org: clinic.slug });

  // Role and branches of a member.
  await row.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "تعديل الدور والفروع" }).click();
  await page.locator("#member-role").selectOption("doctor");
  await expect(page.getByText("تغيير الدور يُنهي جلسات الموظف المفتوحة")).toBeVisible();
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(row).toContainText("طبيب");

  // AT-09: the form offers clinic roles only, and the API refuses a Super
  // Admin role, recording the attempt as a denied audit event.
  await row.getByRole("button", { name: "المزيد" }).click();
  await page.getByRole("button", { name: "تعديل الدور والفروع" }).click();
  const roles = await page.locator("#member-role option").evaluateAll((os) => os.map((o) => o.value).sort());
  expect(roles).toEqual(["admin", "doctor", "receptionist", "therapist"]);
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  const headers = { "X-Requested-With": "clinicsys", "X-Org-Slug": clinic.slug };
  const list = await (await page.request.get("/api/org/members", { headers })).json();
  const target = list.find((m) => m.email === created);
  const escalate = await page.request.patch(`/api/org/members/${target.id}`, { headers, data: { role: "super_admin" } });
  expect(escalate.status()).toBe(400);
  expect((await escalate.json()).error.code).toBe("invalid_role");
  const audit = await (await clinic.sa.get(`/api/platform/audit?organization_id=${clinic.orgId}&action=member.update`)).json();
  expect(audit.data.map((a) => [a.result, a.actor_email])).toContainEqual(["denied", clinic.admin]);
  await expect(row).toContainText("طبيب");

  // An invitation takes the last seat; the next one is refused.
  await invite(page, `ca-seat-${uniq()}@e2e.test`, { role: "therapist", branches: [clinic.mainBranch] });
  await expect(usersCounter(page)).toHaveText(/المستخدمون:\s*3\s*من\s*3/);
  await expect(usersCounter(page)).toContainText("دعوات معلّقة");
  await expect(page.getByText("وصلت إلى حد المستخدمين في خطتك")).toBeVisible();
  await invite(page, `ca-over-${uniq()}@e2e.test`, { role: "therapist", branches: [clinic.mainBranch] });
  await expect(page.locator(".modal [role=alert]")).toContainText("تجاوزت حد المستخدمين في خطتك");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(usersCounter(page)).toHaveText(/المستخدمون:\s*3\s*من\s*3/);
});

// ── Other roles ─────────────────────────────────────────────────────────
test("receptionist and doctor get neither the branches screen nor staff management", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "receptionist@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(sidebar(page).locator('[data-route="branches"]')).toHaveCount(0);
  await expect(sidebar(page).locator('[data-route="settings"]')).toHaveCount(0);
  await picker(page).click();
  await expect(page.getByRole("button", { name: "إضافة فرع جديد" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "إدارة الفروع" })).toHaveCount(0);
  await expect(page.locator("[role=listbox] button")).toHaveCount(0); // no «تعديل» per branch
  await picker(page).click();
  // A link to the screen falls back to the role's home page.
  await page.goto("/?org=demo-physio#/branches");
  await expect(sidebar(page)).toBeVisible();
  await expect(page).not.toHaveURL(/#\/branches$/);
  await expect(page.locator("[data-branch-card]")).toHaveCount(0);
  for (const path of ["/api/org/members", "/api/org/usage", "/api/org/invitations"]) {
    const r = await page.request.get(path, { headers: { "X-Org-Slug": "demo-physio" } });
    expect(r.status(), path).toBe(403);
  }

  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await clinicLogin(page, "doctor@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(sidebar(page).locator('[data-route="branches"]')).toHaveCount(0);
  await sidebar(page).locator('[data-route="settings"]').click();
  await expect(page.getByText("الوصول مقيّد")).toBeVisible();
  await expect(page.locator("[data-settings-tab]")).toHaveCount(0);
  await expect(page.locator(".staff-panel")).toHaveCount(0);
});
