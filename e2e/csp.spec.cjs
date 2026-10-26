// Content-Security-Policy (security audit, 25 Oct 2026): the build writes
// it into dist/index.html (scripts/build.mjs) and the API sends it as a
// header with frame-ancestors (api/src/static.js). Every other spec fails
// on a violation (fixtures.cjs), so the screens they open run under it;
// this one shows that it is there and that injected script does not run.
const { test, expect } = require("./fixtures.cjs");

const PASSWORD = "Dev@12345";

test("the clinic page carries the policy; an injected inline script or event handler does not run", async ({ page, context }) => {
  const res = await page.goto("/?org=demo-physio");
  const header = res.headers()["content-security-policy"] || "";
  expect(header).toContain("script-src 'self' 'sha256-");
  expect(header).toContain("frame-ancestors 'none'");
  expect(header).not.toContain("'unsafe-inline' https://unpkg");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("aside.sidebar")).toBeVisible();

  const ran = await page.evaluate(async () => {
    window.__injected = [];
    const s = document.createElement("script");
    s.textContent = "window.__injected.push('script')";
    document.head.appendChild(s);
    const box = document.createElement("div");
    box.innerHTML = '<img src="data:," onerror="window.__injected.push(\'onerror\')"><a id="csp-js" href="javascript:window.__injected.push(\'href\')">x</a>';
    document.body.appendChild(box);
    document.getElementById("csp-js").click();
    await new Promise((r) => setTimeout(r, 300));
    box.remove();
    return window.__injected;
  });
  expect(ran).toEqual([]);
  // The three attempts are the violations this test expects; any other fails it.
  await expect.poll(() => context.cspViolations.length).toBeGreaterThanOrEqual(3);
  expect(context.cspViolations.every((v) => /script-src(-elem|-attr)? inline/.test(v)), context.cspViolations.join("\n")).toBe(true);
  context.cspViolations.length = 0;
});

test("the print window (it inherits the policy) prints from its button without an inline handler", async ({ page, context }) => {
  await page.goto("/?org=demo-physio");
  await page.locator("#login-email").fill("receptionist@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("aside.sidebar")).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.evaluate(() => window.printHTML("اختبار", "<p>نص <b>للطباعة</b></p>"));
  const popup = await opened;
  await expect(popup.locator("h1")).toContainText("اختبار");
  await popup.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await popup.locator(".no-print button").click();
  expect(await popup.evaluate(() => window.__printed)).toBe(1);
  expect(await popup.locator("[onclick]").count()).toBe(0);
});
