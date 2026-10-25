// Error tracking in the browser (docs/06 S6): a page that throws while
// rendering shows its own error card (Arabic and English) inside the
// clinic shell, «إعادة المحاولة» renders it again, and the error reaches
// the platform's A08 list, scrubbed. The page is made to throw from the
// test (DATA.campaigns, read only by the WhatsApp campaigns page): no test
// hook in the app.
const { test, expect, PASSWORD } = require("./fixtures.cjs");

const breakCampaigns = (page, message) => page.evaluate((msg) => {
  window.__campaigns = window.DATA.campaigns;
  Object.defineProperty(window.DATA, "campaigns", { configurable: true, get() { throw new Error(msg); }, set() {} });
}, message);
const fixCampaigns = (page) => page.evaluate(() => {
  delete window.DATA.campaigns;
  window.DATA.campaigns = window.__campaigns || [];
});

async function signIn(page, url, button) {
  await page.goto(url);
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.locator("#clinic-main")).toBeVisible();
}

for (const lang of ["ar", "en"]) {
  const t = lang === "ar"
    ? { url: "/?org=demo-physio", signIn: "تسجيل الدخول", title: "حدث خطأ في هذه الصفحة", retry: "إعادة المحاولة", page: "حملات واتساب" }
    : { url: "/?org=demo-physio&lang=en", signIn: "Sign in", title: "Something went wrong on this page", retry: "Try again", page: "WhatsApp campaigns" };

  test(`a page that throws shows its error card in the shell and reports it (${lang})`, async ({ page }) => {
    await signIn(page, t.url, t.signIn);
    const message = `e2e ${lang}: the campaigns page failed for 01012345678`;
    await breakCampaigns(page, message);
    const reported = page.waitForRequest((r) => r.url().endsWith("/api/client-errors") && r.method() === "POST");
    await page.locator('aside.sidebar [data-route="campaigns"]').click();
    const card = page.locator("[data-error-boundary]");
    await expect(card).toBeVisible();
    await expect(card).toContainText(t.title);
    await expect(page.locator("aside.sidebar")).toBeVisible(); // the shell is still there
    const req = await reported;
    expect(req.postDataJSON()).toMatchObject({ message, route: "#/campaigns", kind: "react" });
    expect((await req.response()).status()).toBe(204);

    await fixCampaigns(page);
    await card.getByRole("button", { name: t.retry }).click();
    await expect(page.getByRole("heading", { level: 1, name: t.page })).toBeVisible();
    await expect(card).toHaveCount(0);
  });
}

test("the platform's «الأخطاء» page lists the browser error, scrubbed, and «تم الحل» resolves it", async ({ page, browser, baseURL }) => {
  // One error from a clinic page first.
  const clinic = await browser.newContext({ baseURL, locale: "ar-EG" });
  await require("../scripts/pw-cdn.cjs").routeCdn(clinic);
  const cp = await clinic.newPage();
  await signIn(cp, "/?org=demo-physio", "تسجيل الدخول");
  // A letters-only run id: long digit runs are scrubbed to [number] too.
  const run = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
  const message = `e2e platform: the campaigns page failed for a@b.test ${run}`;
  await breakCampaigns(cp, message);
  const reported = cp.waitForResponse((r) => r.url().endsWith("/api/client-errors"));
  await cp.locator('aside.sidebar [data-route="campaigns"]').click();
  expect((await reported).status()).toBe(204);
  await clinic.close();

  await page.goto("/?platform=1#/errors");
  await expect(page.locator("[data-platform-app][data-auth=anon]")).toBeVisible();
  await page.getByLabel("البريد الإلكتروني").fill("super@clinicsys.test");
  await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("[data-platform-app][data-auth=ready]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "الأخطاء" })).toBeVisible();
  const scrubbed = message.replace("a@b.test", "[email]");
  const row = page.locator("tr[data-fingerprint]").filter({ hasText: scrubbed });
  await expect(row).toBeVisible();
  await expect(row).toContainText("المتصفح");
  await expect(page.getByText("a@b.test")).toHaveCount(0);

  await row.getByRole("button", { name: "التفاصيل" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("#/campaigns");
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "تم الحل" }).click();
  await expect(page.getByText("عُلّم الخطأ كمحلول")).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "محلولة" }).click();
  await expect(page.locator("tr[data-fingerprint]").filter({ hasText: scrubbed })).toBeVisible();
  // A01 counts the open ones.
  await page.goto("/?platform=1#/");
  await expect(page.locator('[data-stat="open_errors"]')).toBeVisible();
});
