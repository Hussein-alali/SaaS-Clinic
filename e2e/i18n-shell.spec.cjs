// The clinic shell in English (docs/06 task 3.29) and the shell decisions
// that came with it: the clinic sign-in S02 (3.22 Tab order), the sidebar
// and its branch picker, the shared dialog, toasts, the command palette,
// row menus, the role homes (src/roles.jsx), the concurrent sessions
// (src/multisession.jsx), the phone drawer as a dialog (3.23) and 44px
// touch targets on phones (3.27); then back to Arabic with the switch.
//
// Other agents translate the rest of the app at the same time, so the
// leftover-Arabic checks look only at what these files draw: a run counts
// when it is inside the given regions AND appears in the shell's sources
// (src/ui.jsx, core.jsx, roles.jsx, multisession.jsx). Runs of the pages
// and of the top bar (src/screens*.jsx, tenant.jsx) are checked by their
// own specs.
const fs = require("fs");
const path = require("path");
const { test, expect, PASSWORD, untranslatedUi, missingKeys } = require("./fixtures.cjs");

const SHELL_SOURCES = ["ui.jsx", "core.jsx", "roles.jsx", "multisession.jsx"]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).join("\n")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");   // code, not comments

// Arabic left in the shell's own text inside `regions` (CSS selectors).
async function shellLeftovers(page, regions, allow = []) {
  const runs = await untranslatedUi(page, allow);
  const inRegions = await page.evaluate((sels) => sels
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .map((el) => [el, ...el.querySelectorAll("[placeholder], [aria-label], [title]")]
      .map((e) => ["placeholder", "aria-label", "title"].map((a) => e.getAttribute(a) || "").join(" "))
      .join(" ") + " " + (el.innerText || el.textContent || ""))
    .join("\n"), regions);
  return runs.filter((r) => inRegions.includes(r) && inShellSources(r));
}
// A run of Arabic words that the shell's sources contain as whole words.
function inShellSources(run) {
  const esc = run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^\u0600-\u06FF])" + esc + "([^\u0600-\u06FF]|$)").test(SHELL_SOURCES);
}
// Keys of the shell (literals of its tt() calls) without an English text.
async function shellMissing(page) {
  return (await missingKeys(page)).filter((k) => SHELL_SOURCES.includes(JSON.stringify(k)));
}

async function expectEnglish(page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
}

async function signIn(page, email, url = "/?org=demo-physio&lang=en") {
  await page.goto(url);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#clinic-main")).toBeVisible();
}

const noHorizontalScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);

test("S02 in English: lang/dir, labels, the language corner and the Tab order e-mail → password → … → sign in (3.22)", async ({ page }) => {
  await page.goto("/?org=demo-physio&lang=en");
  await expectEnglish(page);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.locator("label[for=login-email]")).toHaveText(/^E-?mail$/);
  await expect(page.locator("label[for=login-password]")).toHaveText("Password");
  // The switch names the other language, in the top corner of the page.
  const sw = page.locator("[data-lang-switch=ar]");
  await expect(sw).toBeVisible();
  await expect(sw).toHaveText("العربية");

  // «Forgot password?» is under the password field now, after it in the Tab order.
  await page.locator("#login-email").focus();
  const order = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || el.getAttribute("aria-label") || (el.type === "checkbox" ? "checkbox" : el.textContent.trim());
    }));
  }
  expect(order).toEqual(["login-password", "Show password", "checkbox", "Forgot password?", "Sign in"]);
  const pw = await page.locator("#login-password").boundingBox();
  const forgot = await page.getByRole("button", { name: "Forgot password?" }).boundingBox();
  expect(forgot.y).toBeGreaterThan(pw.y + pw.height - 1);

  // A refused sign-in explains itself in English.
  await page.locator("#login-email").fill("not-an-email");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#login-notice")).toContainText(/Enter a valid e-?mail address/);

  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, [".auth-grid"])).toEqual([]);
});

test("clinic shell in English (1280×800): sidebar, branch picker, branch dialog, toast, command palette, row menu", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  const nav = page.getByRole("navigation", { name: "Main menu" });
  await expect(nav).toBeVisible();
  for (const label of ["Dashboard", "Patients", "Appointments", "Treatment plans", "Therapy sessions",
    "Payments and invoices", "Packages", "Reports", "Branches", "Settings"]) {
    await expect(nav.getByRole("link", { name: label, exact: false }).first()).toBeVisible();
  }
  await expect(page.locator("aside.sidebar .nav-section").first()).toHaveText("Care");
  await expect(page.locator("aside.sidebar")).toContainText("Admin ·");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  // LTR: the sidebar is on the left.
  const side = await page.locator("aside.sidebar").boundingBox();
  expect(side.x).toBeLessThan(10);

  // Branch picker → switch branch → toast at the top right (inline end).
  const picker = page.locator("button.branch-switcher");
  await expect(picker).toHaveAttribute("aria-label", /^Current branch: .+ — switch branch$/);
  await picker.click();
  const list = page.getByRole("listbox", { name: "Branches" });
  await expect(list).toBeVisible();
  await expect(page.getByRole("button", { name: "Add new branch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage branches" })).toBeVisible();
  expect(await shellLeftovers(page, ["aside.sidebar"])).toEqual([]);
  const other = list.locator('[role=option][aria-selected="false"]').first();
  await other.click();
  const toast = page.locator('[role=status]', { hasText: "Switched to" });
  await expect(toast).toBeVisible();
  const tb = await toast.boundingBox();
  expect(tb.x + tb.width).toBeGreaterThan(1280 - 40);

  // The shared Modal: the branch form.
  await picker.click();
  await page.getByRole("button", { name: "Add new branch" }).click();
  const dialog = page.getByRole("dialog", { name: "Add new branch" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(dialog.locator("label[for=branch-name]")).toContainText("Branch name");
  await expect(dialog.getByRole("group", { name: "Working hours" }).or(dialog.locator("legend", { hasText: "Working hours" })).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Add branch" }).click();
  await expect(dialog).toContainText("Branch name is required");
  expect(await shellLeftovers(page, ["[role=dialog]"])).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Command palette.
  await page.locator(".topbar button.search-wrap").click();
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  const field = palette.getByRole("combobox", { name: "Search for a patient, appointment, invoice or page" });
  await expect(field).toBeFocused();
  await expect(palette.getByRole("option").first()).toContainText("Dashboard");
  await expect(palette.getByRole("option").first()).toContainText("Go to");
  await field.fill("Setti");
  await expect(palette.getByRole("option", { name: /Settings/ })).toBeVisible();
  await expect(palette).toContainText("Results: 1");
  await field.fill("zzzz-nothing");
  await expect(palette).toContainText("No matching results");
  expect(await shellLeftovers(page, [".cmdk"])).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // A row menu (the staff list in the settings).
  await page.locator('aside.sidebar [data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(page.locator(".staff-panel")).toBeVisible();
  const more = page.locator(".staff-panel").getByRole("button", { name: "More" }).first();
  await expect(more).toHaveAttribute("title", "More");
  await more.click();
  await expect(page.locator(".row-menu-pop")).toBeVisible();
  expect(await shellLeftovers(page, [".row-menu-pop"])).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".row-menu-pop")).toHaveCount(0);

  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, ["aside.sidebar"])).toEqual([]);
});

test("role homes in English: reception, doctor and therapist dashboards (src/roles.jsx)", async ({ page }) => {
  await signIn(page, "receptionist@demo-physio.test");
  await expectEnglish(page);
  await expect(page.locator("aside.sidebar [data-route=dashboard]")).toContainText("Reception dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good morning,");
  await expect(page.locator(".page")).toContainText("Check-in queue");
  await expect(page.locator(".page")).toContainText("Today's cash");
  // Money in English: «EGP 1,250».
  await expect(page.locator(".page")).toContainText(/EGP \d/);
  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, [".page", "aside.sidebar"])).toEqual([]);
  // The longer English buttons wrap on a phone instead of widening the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Sign out" }).click();

  await signIn(page, "doctor@demo-physio.test");
  await expect(page.locator(".page")).toContainText("My clinic today");
  await expect(page.locator(".page")).toContainText("Case mix");
  await expect(page.locator(".page th").first()).toHaveText("Patient");
  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, [".page", "aside.sidebar"])).toEqual([]);
  await page.getByRole("button", { name: "Sign out" }).click();

  await signIn(page, "therapist@demo-physio.test");
  await expect(page.locator("aside.sidebar [data-route=dashboard]")).toContainText("My day");
  await expect(page.locator(".page")).toContainText("My schedule today");
  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, [".page", "aside.sidebar"])).toEqual([]);
});

test("concurrent sessions in English: the picker and a running session (no data written)", async ({ page }) => {
  // Writes are refused here, so the session lives on this screen only.
  await page.route("**/api/data", async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.action && body.action !== "select") {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Service unavailable" } }) });
    }
    return route.continue();
  });
  await signIn(page, "therapist@demo-physio.test");
  await page.locator('aside.sidebar [data-route="sessions"]').click();
  await expect(page.locator(".page")).toContainText("Sessions running at the same time: ");
  await page.getByRole("button", { name: "Start session" }).first().click();
  const picker = page.getByRole("dialog", { name: "Start session" });
  await expect(picker).toBeVisible();
  expect(await shellLeftovers(page, ["[role=dialog]"])).toEqual([]);
  await picker.getByRole("button", { name: "Start" }).first().click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".page")).toContainText("Pain and mood");
  await expect(page.getByRole("group", { name: "Pain level (0–10)" })).toBeVisible();
  await page.getByRole("group", { name: "Pain level (0–10)" }).getByRole("button", { name: "3", exact: true }).click();
  await expect(page.getByRole("group", { name: "Pain level (0–10)" }).getByRole("button", { name: "3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "End and record session" })).toBeVisible();
  await expect(page.locator(".page")).toContainText("Pain 3");
  expect(await shellMissing(page)).toEqual([]);
  expect(await shellLeftovers(page, [".page"])).toEqual([]);
  await page.getByRole("button", { name: "End and record session" }).click();
  await expect(page.locator(".page")).toContainText("No active sessions");
});

test("phones (390×844, English): the menu drawer is a dialog (3.23), 44px targets (3.27), no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await noHorizontalScroll(page);
  const menuBtn = page.locator(".mobile-menu-btn");
  const nav = page.getByRole("navigation", { name: "Main menu" });
  await expect(nav).not.toBeInViewport();
  // Touch targets.
  for (const el of [menuBtn, page.locator(".topbar .btn-icon").first()]) {
    const b = await el.boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }

  await menuBtn.click();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  await expect(drawer).toBeVisible();
  await expect(nav).toBeInViewport();
  // Slides in from the left edge in English.
  const box = await drawer.boundingBox();
  expect(box.x).toBeLessThan(2);
  expect(await drawer.getAttribute("aria-modal")).toBe("true");
  await expect(drawer.getByRole("button", { name: "Close menu" })).toBeVisible();
  for (const item of await drawer.locator(".nav-item").all()) {
    expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  // Tab and Shift+Tab never leave it.
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(key);
      expect(await page.evaluate(() => !!document.activeElement.closest("aside.sidebar")), `${key} #${i + 1}`).toBe(true);
    }
  }
  expect(await shellLeftovers(page, ["aside.sidebar"])).toEqual([]);
  // Esc closes it; the focus is back on the menu button.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(menuBtn).toBeFocused();
  await expect(nav).not.toBeInViewport();

  // The close button and a nav link close it too.
  await menuBtn.click();
  await page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name: "Close menu" }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  await expect(menuBtn).toBeFocused();
  await menuBtn.click();
  await page.getByRole("dialog", { name: "Menu" }).locator('[data-route="patients"]').click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  await expect(page.locator('aside.sidebar [data-route="patients"]')).toHaveAttribute("aria-current", "page");
  await noHorizontalScroll(page);
  expect(await shellMissing(page)).toEqual([]);
});

test("phones in Arabic: the drawer is a dialog too and slides from the right", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?org=demo-physio&lang=ar");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.locator(".mobile-menu-btn").click();
  const drawer = page.getByRole("dialog", { name: "القائمة" });
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box.x + box.width).toBeGreaterThan(388);
  await expect(drawer.getByRole("button", { name: "إغلاق القائمة" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".mobile-menu-btn")).toBeFocused();
  await noHorizontalScroll(page);
});

test("back to Arabic with the language switch: dir=rtl, Arabic labels, kept after reload", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await page.locator("[data-lang-switch=ar]").first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  const nav = page.getByRole("navigation", { name: "القائمة الرئيسية" });
  await expect(nav).toBeVisible();
  await expect(nav.locator('[data-route="patients"]')).toContainText("المرضى");
  expect(new URL(page.url()).searchParams.get("lang")).toBeNull();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("navigation", { name: "القائمة الرئيسية" })).toBeVisible();
  // RTL: the sidebar is on the right.
  const side = await page.locator("aside.sidebar").boundingBox();
  expect(side.x + side.width).toBeGreaterThan(1280 - 10);
  await expect(page.locator("[data-lang-switch=en]").first()).toBeVisible();
});
