// The screens of src/screens1.jsx in English (docs/06 task 3.29): the admin
// dashboard, the patients (list as a table and as cards, the file and its
// tabs, the edit dialog, the new-patient wizard), the appointments (the
// calendar's day / therapist / doctor / week views, the list, the booking
// wizard with its month calendar, quick booking, the booking details, the
// fixed schedule and the reschedule dialog) — as the admin, and the same
// screens as the receptionist, the doctor and the therapist, whose home is
// their role dashboard (src/roles.jsx). Plus the owner decisions in these
// screens: Segmented button rows (3.24), list tables as cards on phones
// (3.20) and one money formatter («1,250 ج.م» / «EGP 1,250»).
//
// Other agents translate the rest of the app at the same time, so the
// leftover checks count a run of Arabic only when screens1.jsx draws it, or
// when no other source file contains it (data passed through tt(), text
// put together at run time); runs that only the shell or another screen's
// files contain are checked by their own specs.
//
// I18N_SHOTS=<dir> saves screenshots of the screens (1280×800, 390×844).
const fs = require("fs");
const path = require("path");
const { test, expect, PASSWORD, untranslatedUi, missingKeys } = require("./fixtures.cjs");

const SRC = path.join(__dirname, "..", "src");
const code = (f) => fs.readFileSync(path.join(SRC, f), "utf8")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");   // code, not comments
const MINE = code("screens1.jsx");
const OTHERS = fs.readdirSync(SRC).filter((f) => f.endsWith(".jsx") && f !== "screens1.jsx").map(code).join("\n");
const SHOTS = process.env.I18N_SHOTS || "";

// `run` as whole Arabic words of `text`.
function hasWords(text, run) {
  const esc = run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^\u0600-\u06FF])" + esc + "([^\u0600-\u06FF]|$)").test(text);
}
const mineOrNobodys = (run) => hasWords(MINE, run) || !hasWords(OTHERS, run);

// Collects, per screen, the Arabic left in the interface and the keys
// without English, so one run lists every problem.
function checker(page) {
  const problems = {};
  const seen = new Set();
  return {
    problems,
    async check(screen, allow = []) {
      const left = (await untranslatedUi(page, allow)).filter(mineOrNobodys);
      const miss = (await missingKeys(page))
        .filter((k) => !seen.has(k) && (MINE.includes(JSON.stringify(k)) || !OTHERS.includes(k)));
      miss.forEach((k) => seen.add(k));
      if (left.length || miss.length) problems[screen] = { leftovers: left, missing: miss };
      if (SHOTS) {
        const vp = page.viewportSize();
        await page.screenshot({ path: path.join(SHOTS, `${screen.replace(/[^\w-]+/g, "_")}-${vp.width}.png`), fullPage: false });
      }
    },
  };
}

async function expectEnglish(page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
}

async function signIn(page, email, lang = "en") {
  await page.goto(`/?org=demo-physio&lang=${lang}`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await expect(page.locator("#clinic-main")).toBeVisible();
}

const main = (page) => page.locator("#clinic-main");
const go = (page, route) => page.locator(`aside.sidebar [data-route="${route}"]`).click();
const dialog = (page, name) => page.getByRole("dialog", { name });
const noHorizontalScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);

// ── Screens, shared by the roles ─────────────────────────────────

async function patientsScreens(page, c, who, { edit = true, add = true } = {}) {
  await go(page, "patients");
  await expect(main(page).getByRole("heading", { level: 1, name: "Patients" })).toBeVisible();
  const status = main(page).getByRole("group", { name: "File status", exact: true });
  await expect(status.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  const view = main(page).getByRole("group", { name: "View", exact: true });
  await view.getByRole("button", { name: "Table" }).click();
  await c.check(`${who} patients table`);
  await view.getByRole("button", { name: "Cards" }).click();
  await expect(view.getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
  await c.check(`${who} patients cards`);
  await view.getByRole("button", { name: "Table" }).click();
  for (const s of ["Active", "Inactive", "Incomplete", "All"]) await status.getByRole("button", { name: s, exact: true }).click();

  const rows = main(page).locator("table.tbl-cards tbody tr[data-clickable]");
  if (await rows.count()) {
    if (edit) {
      await rows.first().getByRole("button", { name: /^Edit .+'s details$/ }).click();
      const d = dialog(page, /^Edit patient details/);
      await expect(d.getByText("Identifiers")).toBeVisible();
      await expect(d.getByText(/^Role: .+ · Fields you may not edit are disabled\.$/)).toBeVisible();
      await c.check(`${who} patient edit`);
      await d.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(d).toHaveCount(0);
    }
    await rows.first().click();
    const tabs = ["Overview", "History", "Treatment plan", "Sessions", "Files", "Invoices"];
    await expect(main(page).getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    for (const t of tabs) {
      await main(page).getByRole("button", { name: t, exact: true }).click();
      await page.waitForTimeout(150);
      await c.check(`${who} patient ${t}`);
    }
    await main(page).getByRole("button", { name: "Fixed schedule", exact: true }).click();
    const sched = dialog(page, /^Fixed schedule — /);
    await expect(sched.getByText("Weekly treatment days")).toBeVisible();
    // Saturday + Sunday are consecutive → the rest-day warning.
    for (const day of ["Saturday", "Sunday"]) {
      const b = sched.getByRole("button", { name: day, exact: true });
      if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
    }
    await expect(sched.getByText(/^Note: some days are consecutive/)).toBeVisible();
    await c.check(`${who} fixed schedule`);
    await sched.getByRole("button", { name: "Close" }).first().click();
    await main(page).locator(".crumb").click();
    await expect(main(page).getByRole("heading", { level: 1, name: "Patients" })).toBeVisible();
  }

  if (add) {
    await main(page).getByRole("button", { name: "New patient", exact: true }).click();
    await expect(main(page).getByRole("heading", { level: 1, name: "Register a new patient" })).toBeVisible();
    await c.check(`${who} new patient 1 personal`);
    await main(page).getByPlaceholder("e.g. Hana Mostafa").fill("Test Patient " + who);
    await main(page).getByPlaceholder("+20 …").fill("01000000999");
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(main(page).getByText("Medical details", { exact: true })).toBeVisible();
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();   // no diagnosis → a toast
    await expect(page.getByText("Enter the diagnosis").first()).toBeVisible();
    await c.check(`${who} new patient 2 medical`);
    await main(page).getByPlaceholder("e.g. L4–L5 disc herniation").fill("Low back pain");
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(main(page).getByText("Files and attachments", { exact: true })).toBeVisible();
    await c.check(`${who} new patient 3 attachments`);
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(main(page).getByText("Review & create", { exact: true })).toBeVisible();
    await expect(main(page).getByText(/Looks good\. The patient will be created with file #/)).toBeVisible();
    await c.check(`${who} new patient 4 review`);
    for (let i = 0; i < 4; i++) await main(page).getByRole("button", { name: /^(Back|Cancel)$/ }).first().click();
    await expect(main(page).getByRole("heading", { level: 1, name: "Patients" })).toBeVisible();
  }
}

async function appointmentScreens(page, c, who, { modes, wizard = true } = {}) {
  await go(page, "appointments");
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(/^(Appointments|My schedule)$/);
  const views = main(page).getByRole("group", { name: "Calendar view", exact: true });
  for (const m of modes) {
    await views.getByRole("button", { name: m, exact: true }).click();
    await expect(views.getByRole("button", { name: m, exact: true })).toHaveAttribute("aria-pressed", "true");
    await c.check(`${who} calendar ${m}`);
  }
  // Prev / next / today keep the label in English.
  await main(page).getByRole("button", { name: "Next", exact: true }).click();
  await expect(main(page).getByText(/^Tomorrow, \d+ \w+$/)).toBeVisible();
  await main(page).getByRole("button", { name: "Previous", exact: true }).click();
  await expect(main(page).getByText(/^Today, \d+ \w+$/)).toBeVisible();

  // Today's seeded booking (10:00, the therapist and the doctor) → details → reschedule.
  const block = main(page).locator('div[draggable=true][role="button"]').first();
  if (modes.includes("Therapist") || modes.includes("Doctor")) {
    await views.getByRole("button", { name: modes.includes("Therapist") ? "Therapist" : "Doctor", exact: true }).click();
  }
  if (await block.count()) {
    await block.click();
    const details = dialog(page, "Appointment details");
    await expect(details.getByText("Assigned to")).toBeVisible();
    await expect(details.getByText(/^\d\d:\d\d · \d+ min$/)).toBeVisible();
    await c.check(`${who} booking details`);
    await details.getByRole("button", { name: "Move / edit", exact: true }).click();
    const r = dialog(page, "Reschedule appointment");
    await expect(r.getByRole("group", { name: "New day", exact: true })).toBeVisible();
    await expect(r.getByRole("group", { name: "New day", exact: true }).getByRole("button").first()).toContainText(/^[A-Z][a-z]+day\d+ [A-Z][a-z]+(Open: \d+|Fully booked)$/);
    await c.check(`${who} reschedule`);
    await page.keyboard.press("Escape");
    await expect(r).toHaveCount(0);
  }

  // The list tab and a row menu.
  const tabs = main(page).getByRole("group", { name: "Appointments view", exact: true });
  await tabs.getByRole("button", { name: "List" }).click();
  const status = main(page).getByRole("group", { name: "Appointment status", exact: true });
  for (const s of ["Confirmed", "Pending", "Completed", "Cancelled", "All"]) await status.getByRole("button", { name: s }).click();
  const menu = main(page).locator("table.tbl-cards tbody tr button[aria-expanded]").first();
  if (await menu.count()) {
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "Confirm appointment" }).or(page.getByRole("button", { name: "Confirm appointment" })).first()).toBeVisible();
    await c.check(`${who} appointment list + menu`);
    await page.keyboard.press("Escape");
  } else {
    await c.check(`${who} appointment list`);
  }

  if (wizard) {
    await tabs.getByRole("button", { name: "New booking" }).click();
    await expect(main(page).getByText("Patient details", { exact: true })).toBeVisible();
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();   // nothing chosen → a toast
    await expect(page.getByText("Choose the patient or enter their initial details").first()).toBeVisible();
    await c.check(`${who} wizard 1 patient`);
    await main(page).getByRole("group", { name: "Patient", exact: true }).getByRole("button", { name: "New patient", exact: true }).click();
    await main(page).getByPlaceholder("Full name").fill("Wizard Patient " + who);
    await main(page).getByPlaceholder("+20 1xx xxx xxxx").fill("01110001001");   // a known number
    await expect(main(page).getByText(/Known number — the booking will be linked to .+'s file$/)).toBeVisible();
    await c.check(`${who} wizard 1 new patient`);
    await main(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(main(page).getByText("Choose a therapist — the therapist appointment is required", { exact: true })).toBeVisible();
    await c.check(`${who} wizard 2 therapist`);
    await main(page).locator(".grid-3 > button").first().click();
    await expect(main(page).getByText("Doctor consultation (optional)", { exact: true })).toBeVisible();
    await c.check(`${who} wizard 3 doctor`);
    await main(page).getByRole("button", { name: "Continue without a doctor" }).click();
    await expect(main(page).getByText("Choose a date", { exact: true })).toBeVisible();
    const month = await main(page).locator("[aria-live=polite]").first().textContent();
    expect(month).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    await main(page).getByRole("button", { name: "Next month" }).click();
    await main(page).getByRole("button", { name: "Previous month" }).click();
    await c.check(`${who} wizard 4 date (month)`);
    await main(page).getByRole("button", { name: "Tomorrow", exact: true }).click();
    await expect(main(page).getByText("Booking summary", { exact: true })).toBeVisible();
    await expect(main(page).getByText("Morning", { exact: true })).toBeVisible();
    await c.check(`${who} wizard 5 time`);
    await main(page).getByRole("button", { name: "Cancel", exact: true }).click();
  }

  await main(page).getByRole("button", { name: "Quick booking", exact: true }).click();
  const q = dialog(page, "Quick booking");
  await expect(q.getByText(/^For phone and WhatsApp bookings/)).toBeVisible();
  await q.getByPlaceholder("+20 1xx xxx xxxx").fill("01110001001");
  await expect(q.getByText(/Known number — /)).toBeVisible();
  await q.getByRole("button", { name: "Confirm booking", exact: true }).click();   // no therapist → a toast
  await expect(page.getByText(/^(Enter the patient's name|Choose a therapist)$/).first()).toBeVisible();
  await c.check(`${who} quick booking`);
  await q.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(q).toHaveCount(0);
}

// ── Admin ────────────────────────────────────────────────────────

test("admin dashboard in English: periods (Segmented), stat cards with «EGP …», charts and lists", async ({ page }) => {
  const c = checker(page);
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await go(page, "dashboard");
  await expect(main(page).getByRole("heading", { level: 1 })).toContainText("Good morning");
  await expect(main(page).locator(".crumb")).toHaveText("HomeDashboard");
  const periods = main(page).getByRole("group", { name: "Period", exact: true });
  for (const p of ["Today", "This week", "Month", "Quarter"]) {
    await periods.getByRole("button", { name: p, exact: true }).click();
    await expect(periods.getByRole("button", { name: p, exact: true })).toHaveAttribute("aria-pressed", "true");
    await c.check(`admin dashboard ${p}`);
  }
  await expect(main(page).getByText("Monthly revenue", { exact: true })).toBeVisible();
  await expect(main(page).getByText(/^EGP [\d.,]+K?$/).first()).toBeVisible();
  await expect(main(page).getByText(/ج\.م/)).toHaveCount(0);
  await noHorizontalScroll(page);
  expect(c.problems).toEqual({});
});

test("the Arabic dashboard keeps its text, with money as «… ج.م»", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await go(page, "dashboard");
  await expect(main(page).getByRole("heading", { level: 1 })).toContainText("صباح الخير");
  await expect(main(page).getByRole("group", { name: "الفترة" }).getByRole("button", { name: "هذا الأسبوع" })).toBeVisible();
  await expect(main(page).getByText("الإيرادات الشهرية", { exact: true })).toBeVisible();
  await expect(main(page).getByText(/^[\d.,]+K? ج\.م$/).first()).toBeVisible();
  await expect(main(page).getByText(/^EGP /)).toHaveCount(0);
});

test("admin patients in English: table and cards, file tabs, edit dialog, fixed schedule, new-patient wizard", async ({ page }) => {
  const c = checker(page);
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await patientsScreens(page, c, "admin");
  expect(c.problems).toEqual({});
});

test("admin appointments in English: calendar views, booking details, reschedule, list, booking wizard, quick booking", async ({ page }) => {
  const c = checker(page);
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await appointmentScreens(page, c, "admin", { modes: ["Day", "Therapist", "Doctor", "Week"] });
  expect(c.problems).toEqual({});
});

// ── The other roles ──────────────────────────────────────────────

for (const [role, opts] of [
  ["receptionist", { modes: ["Day", "Therapist", "Doctor", "Week"] }],
  ["doctor", { modes: ["Doctor"] }],
  ["therapist", { modes: ["Therapist"] }],
]) {
  test(`${role} in English: role dashboard, patients, calendar, booking details, wizard, quick booking`, async ({ page }) => {
    test.setTimeout(120_000);
    const c = checker(page);
    await signIn(page, `${role}@demo-physio.test`);
    await expectEnglish(page);
    await go(page, "dashboard");
    await expect(main(page).getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(300);
    await c.check(`${role} dashboard`);
    await patientsScreens(page, c, role);
    await appointmentScreens(page, c, role, opts);
    expect(c.problems).toEqual({});
  });
}

// ── Phones (390×844): cards, Segmented rows that wrap, no sideways scroll ──

test("phone 390×844 in English: the patients table as cards (3.20), the calendar and the wizard fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const c = checker(page);
  await signIn(page, "admin@demo-physio.test");
  await expectEnglish(page);
  await page.goto("/?org=demo-physio&lang=en#/patients");
  await expect(main(page).getByRole("heading", { level: 1, name: "Patients" })).toBeVisible();
  // Phones start with the cards view; the table view is cards too.
  await expect(main(page).getByRole("group", { name: "View", exact: true }).getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
  await c.check("phone patients cards");
  await main(page).getByRole("group", { name: "View", exact: true }).getByRole("button", { name: "Table" }).click();
  const cell = main(page).locator("table.tbl-cards tbody tr td[data-label]").first();
  await expect(cell).toHaveAttribute("data-label", "Patient");
  await expect(main(page).locator("table.tbl-cards thead")).toHaveCSS("position", "absolute");
  await noHorizontalScroll(page);
  await c.check("phone patients table");
  await page.goto("/?org=demo-physio&lang=en#/appointments");
  await expect(main(page).getByRole("heading", { level: 1, name: "Appointments" })).toBeVisible();
  await noHorizontalScroll(page);
  await c.check("phone calendar");
  await main(page).getByRole("group", { name: "Appointments view", exact: true }).getByRole("button", { name: "List" }).click();
  await expect(main(page).locator("table.tbl-cards tbody tr td[data-label]").first()).toHaveAttribute("data-label", "Time");
  await noHorizontalScroll(page);
  await c.check("phone appointment list");
  await main(page).getByRole("group", { name: "Appointments view", exact: true }).getByRole("button", { name: "New booking" }).click();
  await expect(main(page).getByText("Patient details", { exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  await c.check("phone wizard");
  expect(c.problems).toEqual({});
});
