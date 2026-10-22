// Milestone 3 entry journeys in the browser (docs/03-App-Flow.md S01-S06,
// J2/J3; docs/06 tasks 3.1-3.5): the main site's login and clinic picker,
// clinic status pages, the clinic login and its membership check, data
// right after sign-in, the branch picker, invitations, password reset,
// module gating and demo mode. Runs against the API-served dist/ with the
// dev seed (see fixtures.cjs). Every test restores what it changes.
const { test, expect, PASSWORD, readOutbox } = require("./fixtures.cjs");

const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const DENTAL = "عيادة الأسنان التجريبية";
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

async function orgIdOf(superAdmin, slug) {
  const r = await superAdmin.get(`/api/platform/organizations?q=${encodeURIComponent(slug)}`);
  expect(r.status()).toBe(200);
  const org = (await r.json()).data.find((o) => o.slug === slug);
  expect(org, `organization ${slug}`).toBeTruthy();
  return org.id;
}

// The first link of the newest e-mail to `to` sent after `after` e-mails
// (the API sends some mails after answering, so this polls).
async function waitForLink(to, re = /./, after = 0) {
  for (let i = 0; i < 75; i++) {
    const mails = readOutbox().slice(after).filter((m) => JSON.stringify(m.to || "").includes(to));
    for (const mail of mails.reverse()) {
      const m = String(mail.text || mail.html || "").match(/https?:\/\/[^\s"'<>]+/);
      if (m && re.test(m[0])) return m[0];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no e-mail with a link to ${to}`);
}

// Makes `email` an active member of `slug` (Super Admin invitation +
// acceptance with the account's own password), unless it already is.
async function ensureMemberOf(playwright, baseURL, email, slug, role, branchIds) {
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const id = await orgIdOf(sa, slug);
  const before = readOutbox().length;
  const inv = await sa.post(`/api/platform/organizations/${id}/invitations`, { data: { email, role, branch_ids: branchIds } });
  const body = await inv.json();
  if (inv.status() === 409 && body.error.code === "already_member") return;
  expect(inv.status(), JSON.stringify(body)).toBe(201);
  const token = new URL(await waitForLink(email, /\?invite=/, before)).searchParams.get("invite");
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-Requested-With": "clinicsys" } });
  const acc = await anon.post(`/api/invitations/${encodeURIComponent(token)}/accept`, { data: { password: PASSWORD } });
  expect(acc.status(), await acc.text()).toBe(200);
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

const sidebar = (page) => page.locator("aside.sidebar");
const sessionStatus = async (page) => (await page.request.get("/api/auth/session")).status();

// ── S01/S02/S04: the main site ──────────────────────────────────────────
test("main site: a member of one clinic is taken straight to it (J3, AT-04)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  await expect(page.getByText("الدخول بدعوة فقط من مدير العيادة")).toBeVisible();
  const login = page.waitForRequest((r) => r.url().endsWith("/api/auth/login"));
  await rootLogin(page, "admin@demo-physio.test");
  // «أبقني مسجلاً» is ticked by default and reaches the API as remember.
  expect((await login).postDataJSON()).toMatchObject({ email: "admin@demo-physio.test", remember: true });
  await page.waitForURL(/\/\?org=demo-physio$/);
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(page.getByRole("button", { name: "تبديل العيادة" })).toHaveCount(0);
});

test("main site: a member of several clinics picks one (S04, AT-04)", async ({ page, playwright, baseURL }) => {
  const email = "receptionist2@demo-physio.test";
  await ensureMemberOf(playwright, baseURL, email, "demo-dental", "receptionist", ["br-demo-dental-1"]);
  await page.goto("/");
  await rootLogin(page, email);
  await expect(page.getByRole("heading", { name: "اختر العيادة" })).toBeVisible();
  const cards = page.locator(".tenant-clinic-card");
  await expect(cards).toHaveCount(2);
  const dental = cards.filter({ hasText: DENTAL });
  await expect(dental).toContainText("طب أسنان");
  await expect(dental).toContainText("موظف استقبال");
  await expect(dental).toContainText("?org=demo-dental");
  await expect(cards.filter({ hasText: PHYSIO })).toContainText("علاج طبيعي");
  await dental.click();
  await page.waitForURL(/\/\?org=demo-dental$/);
  await expect(sidebar(page)).toContainText(DENTAL);
  // «تبديل العيادة» goes back to the picker.
  await page.getByRole("button", { name: "تبديل العيادة" }).click();
  await expect(page.getByRole("heading", { name: "اختر العيادة" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("main site: a Super Admin without a clinic is pointed to the platform", async ({ page }) => {
  await page.goto("/");
  await rootLogin(page, "super@clinicsys.test");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "no-clinic");
  await expect(page.getByRole("link", { name: "لوحة إدارة المنصة" })).toHaveAttribute("href", /\/\?platform=1$/);
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#root-email")).toBeVisible();
  expect(await sessionStatus(page)).toBe(401);
});

test("platform context renders the Super Admin panel, never the main site", async ({ page }) => {
  await page.goto("/?platform=1");
  await expect(page.locator("#root-email")).toHaveCount(0);
  await expect(page.locator("#login-email")).toHaveCount(0);
  const hasPanel = await page.evaluate(() => typeof window.PlatformApp === "function");
  if (!hasPanel) {
    await expect(page.getByRole("heading", { name: "لوحة إدارة المنصة غير متاحة حاليًا" })).toBeVisible();
  } else {
    await expect(page.locator("#root")).not.toBeEmpty();
  }
});

// ── S06: status pages (task 3.1, AT-13) ─────────────────────────────────
test("status pages: unknown clinic link (query and host) and a suspended clinic", async ({ page, playwright, baseURL }) => {
  await page.goto("/?org=no-such-clinic");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "not-found");
  await expect(page.getByRole("heading", { name: "لا توجد عيادة بهذا الرابط" })).toBeVisible();
  await expect(page.getByRole("link", { name: "الموقع الرئيسي" })).toBeVisible();

  const port = new URL(baseURL).port;
  await page.goto(`http://no-such-clinic.localhost:${port}/`);
  await expect(page.getByRole("heading", { name: "لا توجد عيادة بهذا الرابط" })).toBeVisible();

  // The clinic subdomain itself resolves too (Host, not ?org=).
  await page.goto(`http://demo-physio.localhost:${port}/`);
  await expect(page.locator("#login-email")).toBeVisible();
  await expect(page.getByText(PHYSIO).first()).toBeVisible();

  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const id = await orgIdOf(sa, "demo-dental");
  const off = await sa.post(`/api/platform/organizations/${id}/status`, { data: { status: "suspended", reason: "e2e" } });
  expect(off.status()).toBe(200);
  try {
    await page.goto("/?org=demo-dental");
    await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "suspended");
    await expect(page.getByText("هذه العيادة متوقفة حاليًا. تواصل مع إدارة المنصة.")).toBeVisible();
    await expect(page.locator("#login-email")).toHaveCount(0);
  } finally {
    const on = await sa.post(`/api/platform/organizations/${id}/status`, { data: { status: "active" } });
    expect(on.status()).toBe(200);
  }
});

// ── S02: the clinic login (task 3.2) ────────────────────────────────────
test("clinic login: branded before sign-in, data on screen right after it without a reload", async ({ page }) => {
  const early = [];
  page.on("request", (r) => {
    if (/\/api\/(data|rpc|orgs\/current)/.test(r.url())) early.push(r.url());
  });
  await page.goto("/?org=demo-physio");
  await expect(page.locator("#login-email")).toBeVisible();
  // Name from /api/orgs/resolve (loadClinic needs a session).
  await expect(page.getByText("سجّل الدخول للمتابعة إلى مساحة")).toContainText(PHYSIO);
  expect(early, "no data request before sign-in").toEqual([]);

  await page.evaluate(() => { window.__sameDocument = true; });
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(page.getByText("مريض أول — PHY").first()).toBeVisible();
  await expect(page.locator('[data-route="patients"]')).toContainText("4");
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(await page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-1");

  // Signing out ends the server session too.
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#login-email")).toBeVisible();
  expect(await sessionStatus(page)).toBe(401);
});

test("clinic login: an account of another clinic is refused and signed out (AT-05)", async ({ page }) => {
  await page.goto("/?org=demo-dental");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(page.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(page)).toHaveCount(0);
  expect(await sessionStatus(page)).toBe(401);
});

test("clinic login: wrong password shows one generic Arabic message", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test", "not-the-password");
  await expect(page.locator(".tenant-notice")).toHaveText("البريد الإلكتروني أو كلمة المرور غير صحيحة");
});

test("clinic login: a deactivated member is refused (AT-06)", async ({ page, playwright, baseURL }) => {
  const admin = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio" });
  const off = await admin.post("/api/admin/set-status", { data: { staff_id: "ST-PHY-THERAPIST", active: false } });
  expect(off.status(), await off.text()).toBe(200);
  try {
    await page.goto("/?org=demo-physio");
    await clinicLogin(page, "therapist@demo-physio.test");
    await expect(page.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
    await expect(sidebar(page)).toHaveCount(0);
    expect(await sessionStatus(page)).toBe(401);
  } finally {
    const on = await admin.post("/api/admin/set-status", { data: { staff_id: "ST-PHY-THERAPIST", active: true } });
    expect(on.status()).toBe(200);
  }
});

test("an open session on another clinic's link shows «no membership» (S06)", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toBeVisible();
  await page.goto("/?org=demo-dental");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "no-membership");
  await expect(page.getByText("admin@demo-physio.test")).toBeVisible();
});

// ── Branches (task 3.4) ─────────────────────────────────────────────────
test("branch picker: only the member's branches; switching changes X-Branch-Id and the data", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "receptionist2@demo-physio.test");
  await expect(page.getByText("مريض أول — PHY").first()).toBeVisible();
  await expect(page.getByText("مريض ثالث — PHY")).toHaveCount(0);
  const picker = page.locator("button.branch-switcher");
  await expect(picker).toContainText("الفرع الرئيسي");

  await picker.click();
  await expect(page.getByRole("option")).toHaveCount(2);
  const switched = page.waitForRequest((r) => r.url().endsWith("/api/data") && r.headers()["x-branch-id"] === "br-demo-physio-2");
  await page.getByRole("option").filter({ hasText: "فرع المعادي" }).click();
  await switched;
  await expect(page.getByText("مريض ثالث — PHY").first()).toBeVisible();
  await expect(page.getByText("مريض أول — PHY")).toHaveCount(0);

  // The choice is kept across a reload.
  await page.reload();
  await expect(picker).toContainText("فرع المعادي");
  await expect(page.getByText("مريض ثالث — PHY").first()).toBeVisible();

  // A receptionist of branch 1 only sees branch 1 in the picker.
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await clinicLogin(page, "receptionist@demo-physio.test");
  await expect(picker).toContainText("الفرع الرئيسي");
  await picker.click();
  await expect(page.getByRole("option")).toHaveCount(1);
  expect(await page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-1");
});

// ── S03: invitations (task 3.3) ─────────────────────────────────────────
test("invitation, new account: the first admin activates a new clinic and enters it (J2)", async ({ page, playwright, baseURL }) => {
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const slug = `e2e-${uniq()}`;
  const email = `first-admin-${uniq()}@e2e.test`;
  const before = readOutbox().length;
  const created = await sa.post("/api/platform/organizations", {
    data: { name: "عيادة الاختبار الجديدة", slug, specialty_code: "physio", admin_email: email },
  });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto(`/?org=${slug}`);
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "pending");
  await expect(page.getByRole("heading", { name: "العيادة بانتظار التفعيل" })).toBeVisible();

  const link = await waitForLink(email, /\?invite=/, before);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "قبول الدعوة" })).toBeVisible();
  const summary = page.locator(".tenant-invite-summary");
  await expect(summary).toContainText("عيادة الاختبار الجديدة");
  await expect(summary).toContainText(email);
  await expect(summary).toContainText("مدير");
  await expect(page.locator("form[data-mode=new]")).toBeVisible();

  await page.locator("#invite-name").fill("مدير العيادة الجديدة");
  await page.locator("#invite-password").fill("Secret123");
  await page.locator("#invite-confirm").fill("Secret124");
  await page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();
  await expect(page.getByText("كلمتا المرور غير متطابقتين")).toBeVisible();
  await page.locator("#invite-confirm").fill("Secret123");
  await page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();

  await expect(sidebar(page)).toContainText("عيادة الاختبار الجديدة");
  await expect(page.locator('[data-route="settings"]')).toBeVisible();
  const resolved = await (await page.request.get(`/api/orgs/resolve?slug=${slug}`)).json();
  expect(resolved.status).toBe("active");

  // The link works once.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "هذه الدعوة استُخدمت من قبل" })).toBeVisible();
});

test("invitation, new account: an employee invited by the clinic admin (AT-15)", async ({ page, playwright, baseURL }) => {
  const admin = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio" });
  const email = `therapist-${uniq()}@e2e.test`;
  const before = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email, role: "therapist", branch_ids: ["br-demo-physio-2"] } });
  expect(inv.status(), await inv.text()).toBe(201);

  await page.goto(await waitForLink(email, /\?invite=/, before));
  await expect(page.locator(".tenant-invite-summary")).toContainText(PHYSIO);
  await expect(page.locator(".tenant-invite-summary")).toContainText("الأخصائي");
  await page.locator("#invite-name").fill("أخصائي مدعو");
  await page.locator("#invite-password").fill("Secret123");
  await page.locator("#invite-confirm").fill("Secret123");
  await page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();

  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(page.locator('[data-route="sessions"]')).toBeVisible();
  await expect(page.locator('[data-route="reports"]')).toHaveCount(0); // therapist navigation
  // Branch 2 only: the picker and X-Branch-Id follow the invitation.
  await expect(page.locator("button.branch-switcher")).toContainText("فرع المعادي");
  expect(await page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBe("br-demo-physio-2");
});

test("invitation, existing account: joins with its own password (S03)", async ({ page, playwright, baseURL }) => {
  const admin = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio" });
  const email = "doctor@demo-dental.test";
  const before = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email, role: "doctor", branch_ids: ["br-demo-physio-1"] } });
  expect(inv.status(), await inv.text()).toBe(201);

  await page.goto(await waitForLink(email, /\?invite=/, before));
  await expect(page.locator("form[data-mode=existing]")).toBeVisible();
  await expect(page.locator("#invite-name")).toHaveCount(0);
  await expect(page.locator("#invite-confirm")).toHaveCount(0);
  await expect(page.getByText("لن تتغير كلمة مرورك")).toBeVisible();

  await page.locator("#invite-password").fill("wrong-password");
  await page.getByRole("button", { name: "قبول الدعوة والدخول" }).click();
  await expect(page.getByText("كلمة المرور غير صحيحة لهذا الحساب")).toBeVisible();

  await page.locator("#invite-password").fill(PASSWORD);
  await page.getByRole("button", { name: "قبول الدعوة والدخول" }).click();
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect(page.locator('[data-route="treatments"]')).toBeVisible(); // doctor navigation
});

test("invitation: unknown token and a revoked invitation", async ({ page, playwright, baseURL }) => {
  await page.goto("/?invite=" + "x".repeat(43));
  await expect(page.getByRole("heading", { name: "رابط الدعوة غير صحيح" })).toBeVisible();

  const admin = await apiAs(playwright, baseURL, "admin@demo-physio.test", { org: "demo-physio" });
  const email = `revoked-${uniq()}@e2e.test`;
  const before = readOutbox().length;
  const inv = await admin.post("/api/org/invitations", { data: { email, role: "receptionist", branch_ids: ["br-demo-physio-1"] } });
  expect(inv.status()).toBe(201);
  const { invitation } = await inv.json();
  const link = await waitForLink(email, /\?invite=/, before);
  expect((await admin.delete(`/api/org/invitations/${invitation.id}`)).status()).toBe(204);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "أُلغيت هذه الدعوة" })).toBeVisible();
});

// ── S05: password reset ─────────────────────────────────────────────────
test("forgot password: e-mailed link, new password, sign in with it", async ({ page }) => {
  const email = "therapist@demo-dental.test";
  const before = readOutbox().length;
  await page.goto("/?org=demo-dental");
  await page.getByRole("button", { name: "نسيت؟" }).click();
  await page.locator("#forgot-email").fill(email);
  await page.getByRole("button", { name: "إرسال رابط الإعادة" }).click();
  await expect(page.locator(".tenant-notice")).toContainText("إن كان هذا البريد مسجّلًا لدينا");

  const link = await waitForLink(email, /\?reset=/, before);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "تعيين كلمة مرور جديدة" })).toBeVisible();
  await page.locator("#reset-password").fill("NewPass123");
  await page.locator("#reset-confirm").fill("NewPass12");
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();
  await expect(page.getByText("كلمتا المرور غير متطابقتين")).toBeVisible();
  await page.locator("#reset-confirm").fill("NewPass123");
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();

  // Back on the login of the main site, with the success message.
  await expect(page.locator(".tenant-notice")).toContainText("تم تغيير كلمة المرور");
  await expect(page).not.toHaveURL(/reset=/);
  await rootLogin(page, email, PASSWORD);
  await expect(page.locator(".tenant-notice")).toHaveText("البريد الإلكتروني أو كلمة المرور غير صحيحة");
  await rootLogin(page, email, "NewPass123");
  await page.waitForURL(/\/\?org=demo-dental$/);
  await expect(sidebar(page)).toContainText(DENTAL);

  // A reset link works once.
  await page.goto(link);
  await page.locator("#reset-password").fill("Another123");
  await page.locator("#reset-confirm").fill("Another123");
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();
  await expect(page.locator(".tenant-notice")).toContainText("رابط إعادة التعيين غير صالح");
});

// ── Modules (task 3.5, AT-07 in the UI) ─────────────────────────────────
test("modules: a disabled module leaves the menu and its link explains why", async ({ page, playwright, baseURL }) => {
  const sa = await apiAs(playwright, baseURL, "super@clinicsys.test", { platform: true });
  const id = await orgIdOf(sa, "demo-physio");
  const detail = await (await sa.get(`/api/platform/organizations/${id}`)).json();
  const enabled = detail.modules.filter((m) => m.enabled).map((m) => m.code);
  expect(enabled).toContain("physio.sessions");
  const put = await sa.put(`/api/platform/organizations/${id}/modules`, {
    data: { codes: enabled.filter((c) => !c.startsWith("physio.")) },
  });
  expect(put.status(), await put.text()).toBe(200);
  try {
    await page.goto("/?org=demo-physio");
    await clinicLogin(page, "admin@demo-physio.test");
    await expect(page.locator('[data-route="patients"]')).toBeVisible();
    await expect(page.locator('[data-route="payments"]')).toBeVisible();
    await expect(page.locator('[data-route="sessions"]')).toHaveCount(0);
    await expect(page.locator('[data-route="treatments"]')).toHaveCount(0);
    // A stored or linked route of the disabled module.
    await page.evaluate(() => localStorage.setItem("kinetic.route", "sessions"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "هذه الميزة غير مفعلة لعيادتك" })).toBeVisible();
    await page.getByRole("button", { name: "العودة إلى لوحة التحكم" }).click();
    await expect(page.getByRole("heading", { name: "هذه الميزة غير مفعلة لعيادتك" })).toHaveCount(0);
  } finally {
    const back = await sa.put(`/api/platform/organizations/${id}/modules`, { data: { codes: enabled } });
    expect(back.status()).toBe(200);
  }
  // The dental clinic never had the physio modules (specialty defaults).
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await page.goto("/?org=demo-dental");
  await clinicLogin(page, "admin@demo-dental.test");
  await expect(page.locator('[data-route="patients"]')).toBeVisible();
  await expect(page.locator('[data-route="sessions"]')).toHaveCount(0);
});

// ── Demo mode (task 3.4) ────────────────────────────────────────────────
test("demo mode (?demo=1) works without a single /api request", async ({ page }) => {
  const api = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url());
  });
  await page.goto("/?demo=1");
  await expect(page.getByText("سجّل الدخول بصفة")).toBeVisible();
  await page.locator("#login-password").fill("demo");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(sidebar(page)).toBeVisible();
  await page.locator('[data-route="patients"]').click();
  await page.locator('[data-route="appointments"]').click();
  await page.waitForTimeout(500);
  expect(api).toEqual([]);
});
