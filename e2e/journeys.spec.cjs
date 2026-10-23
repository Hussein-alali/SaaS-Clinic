// The four primary journeys of docs/03-App-Flow.md, end to end through the
// real screens (plan task 3.9):
//   J1  the Super Admin creates a clinic in the wizard → invitation e-mail
//   J2  the first admin accepts it → the clinic is active → C01 with the
//       first-use checklist «ابدأ الإعداد» (docs/03 «First-use journey»),
//       then signs in again from the main site
//   J3  login from the main site: one membership → the clinic; several →
//       the picker (S04); none → a status page (S06)
//   J4  a receptionist books an appointment in their branch (C03) and it is
//       in the calendar, with the WhatsApp reminder
//
// Runs against the API-served dist/ with the dev seed (fixtures.cjs). The
// only API calls are reads the screens cannot show (the e-mail outbox).
// J1–J3 share one new clinic and run in order; every name is unique per
// run, so the spec runs again on the same database.
const { test, expect, PASSWORD, readOutbox } = require("./fixtures.cjs");
const { routeCdn } = require("../scripts/pw-cdn.cjs");

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const SLUG = `j-${RUN}`;
const CLINIC = `عيادة الرحلات ${RUN}`;
const OWNER = `owner-${RUN}@e2e.test`;
const OWNER_NAME = "د. سلمى مديرة العيادة";
const OWNER_PASSWORD = "Journey#2026";
const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const DENTAL = "عيادة الأسنان التجريبية";

const sidebar = (page) => page.locator("aside.sidebar");
const checklist = (page) => page.locator("section.onboarding");
const step = (page, id) => checklist(page).locator(`li[data-step="${id}"]`);

// The newest link of an e-mail to `to` sent after `after` e-mails (the API
// sends after answering, so this polls).
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

// Another person's browser: same CDN routes and «no uncaught page error» rule.
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

async function platformLogin(page) {
  await page.goto("/?platform=1");
  await expect(page.locator("[data-platform-app][data-auth=anon]")).toBeVisible();
  await page.getByLabel("البريد الإلكتروني").fill("super@clinicsys.test");
  await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
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

// ── J1 ──────────────────────────────────────────────────────────────────
let inviteLink = null;

test("J1 — the Super Admin creates a clinic in the wizard; the first admin's invitation is e-mailed and the clinic waits for it", async ({ page }) => {
  await platformLogin(page);
  await page.getByRole("navigation", { name: "أقسام المنصة" }).getByRole("link", { name: "العيادات" }).click();
  await page.getByRole("link", { name: "إنشاء عيادة" }).click();

  // 1 — name + address (slug checked as it is typed).
  await expect(page.getByRole("heading", { name: /الخطوة 1 من 4/ })).toBeVisible();
  await page.getByLabel("اسم العيادة").fill(CLINIC);
  await page.getByLabel("رابط العيادة").fill(SLUG);
  await expect(page.locator(".pa-slug-msg")).toHaveAttribute("data-state", "available");
  await page.getByRole("button", { name: "التالي" }).click();
  // 2 — specialty: its default modules are switched on, and stay editable.
  await expect(page.getByRole("heading", { name: /الخطوة 2 من 4/ })).toBeVisible();
  await page.getByRole("radio", { name: /العلاج الطبيعي/ }).click();
  await expect(page.getByRole("switch", { name: "جلسات العلاج الطبيعي", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "الفواتير والمدفوعات", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "التالي" }).click();
  // 3 — plan and status.
  await expect(page.getByRole("heading", { name: /الخطوة 3 من 4/ })).toBeVisible();
  await expect(page.locator(".pa-wizard-body")).toContainText("بانتظار التفعيل");
  await page.getByRole("button", { name: "التالي" }).click();
  // 4 — the first admin, then «إنشاء».
  await expect(page.getByRole("heading", { name: /الخطوة 4 من 4/ })).toBeVisible();
  await page.getByLabel("بريد أول مدير للعيادة").fill(OWNER);
  await expect(page.locator(".pa-summary")).toContainText(CLINIC);
  const mark = readOutbox().length;
  await page.getByRole("button", { name: "إنشاء العيادة" }).click();

  // Success: the address, «بانتظار التفعيل» and the invitation sent.
  const done = page.locator("[data-wizard-done]");
  await expect(done.getByRole("heading", { name: `أُنشئت العيادة «${CLINIC}»` })).toBeVisible();
  await expect(done).toContainText(`${SLUG}.clinicsyseg.com`);
  await expect(done.locator(".badge", { hasText: "بانتظار التفعيل" })).toBeVisible();
  await expect(done.locator("[data-invite-sent]")).toContainText(OWNER);

  // The e-mail: the clinic's name, a link to this clinic's S03 page.
  inviteLink = await waitForMailLink(OWNER, /\?invite=/, mark);
  expect(inviteLink).toContain(`org=${SLUG}`);
  const mail = readOutbox().slice(mark).find((m) => JSON.stringify(m.to).includes(OWNER));
  expect(mail.subject).toContain(CLINIC);

  // Until the invitation is accepted the clinic's address shows «بانتظار التفعيل» (AT-03).
  await page.goto(`/?org=${SLUG}`);
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "pending");
  await expect(page.locator("#login-email")).toHaveCount(0);
});

// ── J2 ──────────────────────────────────────────────────────────────────
test("J2 — the first admin accepts the invitation: the clinic is active and the dashboard opens with «ابدأ الإعداد»", async ({ page, browser, baseURL }) => {
  test.skip(!inviteLink, "needs the clinic created in J1");
  await page.goto(inviteLink);
  await expect(page.getByRole("heading", { name: "قبول الدعوة" })).toBeVisible();
  const summary = page.locator(".tenant-invite-summary");
  await expect(summary).toContainText(CLINIC);
  await expect(summary).toContainText(OWNER);
  await expect(summary).toContainText("مدير");
  await page.locator("#invite-name").fill(OWNER_NAME);
  await page.locator("#invite-password").fill(OWNER_PASSWORD);
  await page.locator("#invite-confirm").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "تفعيل الحساب والدخول" }).click();

  // C01 of the new clinic, signed in, with the first-use checklist.
  await expect(sidebar(page)).toContainText(CLINIC);
  await expect(page).toHaveURL(new RegExp(`org=${SLUG}.*#/dashboard$`));
  await expect(checklist(page).getByRole("heading", { name: "ابدأ الإعداد" })).toBeVisible();
  await expect(checklist(page).locator("li[data-step]")).toHaveCount(5);
  await expect(checklist(page).locator("li[data-done=true]")).toHaveCount(0);
  await expect(checklist(page).locator("[data-onboarding-progress]")).toHaveText("أنجزت 0 من 5");
  for (const id of ["branch", "settings", "team", "invite", "booking"]) await expect(step(page, id)).toBeVisible();

  // The Super Admin's list now shows the clinic as active.
  const sa = await otherBrowser(browser, baseURL);
  await platformLogin(sa.page);
  await sa.page.goto(`/?platform=1#/clinics?q=${SLUG}`);
  await expect(sa.page.locator(`tr[data-slug="${SLUG}"]`)).toContainText("نشطة");
  await sa.close();

  // Step 1: «فتح الفروع» → C07 → the main branch gets an address and a phone.
  await step(page, "branch").getByRole("button", { name: "فتح الفروع" }).click();
  await expect(page).toHaveURL(/#\/branches$/);
  await page.getByRole("button", { name: "تعديل الفرع الرئيسي" }).click();
  await page.locator("#branch-address").fill("15 ش النصر، مدينة نصر");
  await page.locator("#branch-phone").fill("0222223333");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await expect(page.locator("[data-branch-card]").first()).toContainText("15 ش النصر، مدينة نصر");
  await sidebar(page).locator('[data-route="dashboard"]').click();
  await expect(step(page, "branch")).toHaveAttribute("data-done", "true");
  await expect(checklist(page).locator("[data-onboarding-progress]")).toHaveText("أنجزت 1 من 5");

  // Step 2: «فتح الإعدادات» → «بيانات العيادة» → the clinic's phone.
  await step(page, "settings").getByRole("button", { name: "فتح الإعدادات" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('[data-settings-tab="clinic"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("جاري تحميل البيانات…")).toHaveCount(0);
  // The settings form's fields (div.label above each input).
  const field = (label) => page.locator("div").filter({ has: page.locator("> div.label", { hasText: new RegExp(`^${label}\\s*$`) }) }).locator("input");
  await field("الهاتف").fill("0222224444");
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await expect(page.getByText("تم حفظ التغييرات")).toBeVisible();
  await sidebar(page).locator('[data-route="dashboard"]').click();
  await expect(step(page, "settings")).toHaveAttribute("data-done", "true");
  await expect(checklist(page).locator("[data-onboarding-progress]")).toHaveText("أنجزت 2 من 5");

  // Step 3 and 4 open the right settings tabs.
  await step(page, "team").getByRole("button", { name: "فتح الأقسام والفريق" }).click();
  await expect(page.locator('[data-settings-tab="depts"]')).toHaveAttribute("aria-selected", "true");
  await sidebar(page).locator('[data-route="dashboard"]').click();
  await step(page, "invite").getByRole("button", { name: "دعوة الموظفين" }).click();
  await expect(page.locator('[data-settings-tab="users"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".staff-panel")).toBeVisible();
  await sidebar(page).locator('[data-route="dashboard"]').click();

  // «لاحقًا» folds it into one line (kept across a reload in this tab),
  // «متابعة الإعداد» opens it again, «إخفاء» removes it for good.
  await checklist(page).getByRole("button", { name: "لاحقًا" }).click();
  await expect(page.locator("section.onboarding-folded")).toContainText("أنجزت 2 من 5");
  await page.reload();
  await expect(page.locator("section.onboarding-folded")).toBeVisible();
  await page.getByRole("button", { name: "متابعة الإعداد" }).click();
  await expect(checklist(page).locator("li[data-step]")).toHaveCount(5);
  await checklist(page).getByRole("button", { name: "إخفاء" }).click();
  await expect(checklist(page)).toHaveCount(0);
  await page.reload();
  await expect(sidebar(page)).toContainText(CLINIC);
  await expect(page.getByText("صباح الخير")).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
});

test("J2 — the first admin signs out and signs in again from the main site with the password chosen in S03", async ({ page }) => {
  test.skip(!inviteLink, "needs the clinic created in J1");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  await rootLogin(page, OWNER, OWNER_PASSWORD);
  // One membership → straight to that clinic (J3), its dashboard.
  await page.waitForURL(new RegExp(`\\?org=${SLUG}(#/dashboard)?$`));
  await expect(sidebar(page)).toContainText(CLINIC);
  await expect(sidebar(page)).toContainText(OWNER_NAME);
  await expect(page.locator('[data-route="settings"]')).toBeVisible();
  await expect(page.locator('[data-route="branches"]')).toBeVisible();
  // The invitation link has done its job.
  await page.goto(inviteLink);
  await expect(page.getByRole("heading", { name: "هذه الدعوة استُخدمت من قبل" })).toBeVisible();
});

// ── J3 ──────────────────────────────────────────────────────────────────
test("J3 — main site login: one membership goes straight in; after joining a second clinic the picker (S04) lists both; no membership → S06", async ({ page, browser, baseURL }) => {
  test.skip(!inviteLink, "needs the clinic created in J1");
  // One membership (the first admin of J1): straight to the clinic.
  await page.goto("/");
  await rootLogin(page, OWNER, OWNER_PASSWORD);
  await page.waitForURL(new RegExp(`\\?org=${SLUG}(#/[a-z]+)?$`));
  await expect(sidebar(page)).toContainText(CLINIC);
  await expect(page.getByRole("button", { name: "تبديل العيادة" })).toHaveCount(0);
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#login-email")).toBeVisible();

  // The dental clinic's admin invites this account (C06), which accepts
  // with its own password (S03, existing account).
  const dental = await otherBrowser(browser, baseURL);
  await dental.page.goto("/?org=demo-dental");
  await clinicLogin(dental.page, "admin@demo-dental.test");
  await expect(sidebar(dental.page)).toContainText(DENTAL);
  await sidebar(dental.page).locator('[data-route="settings"]').click();
  await dental.page.locator('[data-settings-tab="users"]').click();
  const mark = readOutbox().length;
  await dental.page.getByRole("button", { name: "دعوة موظف" }).click();
  await dental.page.locator("#staff-invite-email").fill(OWNER);
  await dental.page.locator("#staff-invite-role").selectOption("doctor");
  await dental.page.locator("#staff-invite-branch-br-demo-dental-1").check();
  await dental.page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(dental.page.locator(`tr[data-invite="${OWNER}"]`)).toHaveAttribute("data-status", "pending");
  await dental.close();

  // Before accepting, the dental clinic's address does not let this account in (AT-03).
  await page.goto("/?org=demo-dental");
  await clinicLogin(page, OWNER, OWNER_PASSWORD);
  await expect(page.locator(".tenant-notice")).toContainText("ليست لديك عضوية نشطة في هذه العيادة");
  await expect(sidebar(page)).toHaveCount(0);

  await page.goto(await waitForMailLink(OWNER, /\?invite=/, mark));
  await expect(page.locator("form[data-mode=existing]")).toBeVisible();
  await expect(page.locator(".tenant-invite-summary")).toContainText(DENTAL);
  await page.locator("#invite-password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "قبول الدعوة والدخول" }).click();
  await expect(sidebar(page)).toContainText(DENTAL);
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#login-email")).toBeVisible();

  // Several memberships → S04 with both clinics; pick one, then «تبديل العيادة».
  await page.goto("/");
  await rootLogin(page, OWNER, OWNER_PASSWORD);
  await expect(page.getByRole("heading", { name: "اختر العيادة" })).toBeVisible();
  const cards = page.locator(".tenant-clinic-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: CLINIC })).toContainText("علاج طبيعي");
  await expect(cards.filter({ hasText: CLINIC })).toContainText("مدير");
  await expect(cards.filter({ hasText: DENTAL })).toContainText("طب أسنان");
  await expect(cards.filter({ hasText: DENTAL })).toContainText("طبيب");
  await cards.filter({ hasText: CLINIC }).click();
  await page.waitForURL(new RegExp(`\\?org=${SLUG}(#/[a-z]+)?$`));
  await expect(sidebar(page)).toContainText(CLINIC);
  await page.getByRole("button", { name: "تبديل العيادة" }).click();
  await expect(page.getByRole("heading", { name: "اختر العيادة" })).toBeVisible();
  await cards.filter({ hasText: DENTAL }).click();
  await page.waitForURL(/\?org=demo-dental(#\/[a-z]+)?$/);
  await expect(sidebar(page)).toContainText(DENTAL);
  await expect(page.locator('[data-route="settings"]')).toBeVisible(); // doctor navigation
  await expect(page.locator('[data-route="branches"]')).toHaveCount(0);
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();

  // No membership (a Super Admin who belongs to no clinic) → S06.
  await page.goto("/");
  await rootLogin(page, "super@clinicsys.test");
  await expect(page.locator(".tenant-status")).toHaveAttribute("data-status", "no-clinic");
  await expect(page.getByRole("heading", { name: "حسابك غير مرتبط بعيادة" })).toBeVisible();
  await expect(page.getByRole("link", { name: "لوحة إدارة المنصة" })).toBeVisible();
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.locator("#root-email")).toBeVisible();
});

// ── J4 ──────────────────────────────────────────────────────────────────
test("J4 — a receptionist books an appointment in their branch: new patient, specialist, date, free time → it is in the calendar, with the WhatsApp reminder", async ({ page, browser, baseURL }) => {
  const patient = `مريض الرحلة ${RUN}`;
  const phone = "010" + String(Date.now()).slice(-8);
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "receptionist@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  // The receptionist works in branch 1 only: that is the calendar's branch.
  await expect(page.locator("button.branch-switcher")).toContainText("الفرع الرئيسي");
  await sidebar(page).locator('[data-route="appointments"]').click();
  await expect(page).toHaveURL(/#\/appointments$/);
  await expect(page.locator(".topbar")).toContainText("الفرع الرئيسي");

  // «حجز جديد»: the patient first.
  await page.getByRole("button", { name: "حجز جديد" }).click();
  await expect(page.getByText("بيانات المريض")).toBeVisible();
  await page.getByRole("button", { name: "متابعة" }).click(); // nothing chosen yet
  await expect(page.getByText("اختر المريض أو أدخل بياناته الأولية")).toBeVisible();
  await page.getByRole("button", { name: "مريض جديد" }).click();
  await page.getByPlaceholder("الاسم الكامل").fill(patient);
  await page.getByPlaceholder("+20 1xx xxx xxxx").fill(phone);
  await page.getByRole("button", { name: "متابعة" }).click();

  // The specialist (required) — one click chooses and moves on (this used
  // to stop with «اختر الأخصائي» because the choice was not applied yet).
  await expect(page.getByText("اختر أخصائيًا — الموعد مع الأخصائي إلزامي")).toBeVisible();
  await page.getByRole("button", { name: /الأخصائي — PHY/ }).click();
  // The doctor is optional.
  await expect(page.getByText("استشارة طبيب (اختياري)")).toBeVisible();
  await page.getByRole("button", { name: "متابعة بدون طبيب" }).click();
  // The date: tomorrow.
  await expect(page.getByText("اختر تاريخًا")).toBeVisible();
  await page.getByRole("button", { name: "غدًا" }).click();
  // The time: the first free afternoon slot of this specialist.
  await expect(page.getByText("اختر الوقت")).toBeVisible();
  const free = page.locator("button.mono:not([disabled])").filter({ hasText: /^1[2-7]:[0-5]\d$/ }).first();
  const time = (await free.textContent()).trim();
  await free.click();
  await expect(page.getByText("ملخّص الحجز")).toBeVisible();
  await expect(page.getByText(`المريض: ${patient}`)).toBeVisible();

  const saved = page.waitForRequest((r) => r.url().endsWith("/api/data") && r.method() === "POST"
    && (r.postDataJSON() || {}).table === "bookings" && ["insert", "upsert"].includes((r.postDataJSON() || {}).action));
  await page.getByRole("button", { name: "تأكيد الحجز" }).click();
  const req = await saved;
  // Saved in the receptionist's branch (X-Branch-Id → bookings.branch_id).
  expect(req.headers()["x-branch-id"]).toBe("br-demo-physio-1");
  await expect(page.getByText("تم تأكيد الحجز")).toBeVisible();

  // Back on the calendar: tomorrow, the specialist's column, the booking.
  const tomorrow = await page.evaluate(() => { const d = new Date(Date.now() + 864e5); return d.toISOString().slice(0, 10); });
  await page.locator('input[type="date"]').first().fill(tomorrow);
  const block = page.locator("div[draggable=true]").filter({ hasText: patient });
  await expect(block).toBeVisible();
  await expect(block).toContainText(time);
  await expect(block).toContainText("مؤكد");

  // The booking's details offer the WhatsApp reminder (opens wa.me with the patient's number).
  await block.click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText(patient);
  await expect(dlg).toContainText(time);
  await page.context().route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
  const popup = page.waitForEvent("popup");
  await dlg.getByRole("button", { name: "إرسال تذكير واتساب" }).click();
  const wa = await popup;
  expect(wa.url()).toContain(`wa.me/20${phone.slice(1)}`);
  expect(decodeURIComponent(wa.url())).toContain(patient);
  await wa.close();
  await page.keyboard.press("Escape");

  // The same specialist cannot be booked twice at that time: the slot is taken.
  await page.getByRole("button", { name: "حجز جديد" }).click();
  await page.getByRole("button", { name: "مريض جديد" }).click();
  await page.getByPlaceholder("الاسم الكامل").fill(`${patient} 2`);
  await page.getByPlaceholder("+20 1xx xxx xxxx").fill(phone.slice(0, -1) + ((Number(phone.slice(-1)) + 1) % 10));
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("button", { name: /الأخصائي — PHY/ }).click();
  await page.getByRole("button", { name: "متابعة بدون طبيب" }).click();
  await page.getByRole("button", { name: "غدًا" }).click();
  await expect(page.locator("button.mono").filter({ hasText: new RegExp(`^${time}$`) })).toBeDisabled();
  await page.getByRole("button", { name: "إلغاء" }).click();

  // Branch-scoped: a colleague working in both branches sees it in the main
  // branch only.
  const other = await otherBrowser(browser, baseURL);
  await other.page.goto("/?org=demo-physio#/appointments");
  await clinicLogin(other.page, "receptionist2@demo-physio.test");
  await expect(sidebar(other.page)).toBeVisible();
  const picker = other.page.locator("button.branch-switcher");
  if (!/الفرع الرئيسي/.test(await picker.textContent())) {
    await picker.click();
    await other.page.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  }
  await other.page.locator('input[type="date"]').first().fill(tomorrow);
  await expect(other.page.locator("div[draggable=true]").filter({ hasText: patient })).toBeVisible();
  await picker.click();
  await other.page.getByRole("option").filter({ hasText: "فرع المعادي" }).click();
  await expect(other.page.locator(".topbar")).toContainText("فرع المعادي");
  await other.page.locator('input[type="date"]').first().fill(tomorrow);
  await expect(other.page.locator(".h3").filter({ hasText: /غدًا/ })).toBeVisible();
  await expect(other.page.locator("div[draggable=true]").filter({ hasText: patient })).toHaveCount(0);
  // Back to the main branch for the next runs of other specs.
  await picker.click();
  await other.page.getByRole("option").filter({ hasText: "الفرع الرئيسي" }).click();
  await expect(other.page.locator(".topbar")).toContainText("الفرع الرئيسي");
  await other.close();
});
