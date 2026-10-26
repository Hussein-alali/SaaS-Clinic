// The screens of src/screens2.jsx in English (docs/06 task 3.29): treatment
// plans and the physio «Diagnosis» form, sessions, payments and invoices
// (date filter, invoice modal, new invoice, methods, receipts), the quick
// payment and its receipt, packages, campaigns (builder, analytics) and the
// reports C05 (three tabs, «Current branch» / «All branches», Excel export);
// with the Segmented rows (3.24), the list tables as cards on phones (3.20)
// and the one money formatter (3.21, «1,250 ج.م» / «EGP 1,250»).
//
// Other agents translate the shell and the other screens at the same time,
// so the leftover checks look only at what this file draws: a run of Arabic
// counts when it is inside the page (main) or a dialog AND src/screens2.jsx
// contains it as whole words; a missing key counts when it is a literal of
// src/screens2.jsx or of no other source file (a value shown through tt()).
const fs = require("fs");
const path = require("path");
const { test, expect, PASSWORD, untranslatedUi, missingKeys } = require("./fixtures.cjs");

const SRC_DIR = path.join(__dirname, "..", "src");
const codeOf = (f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const MINE = codeOf("screens2.jsx");
const OTHERS = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".jsx") && f !== "screens2.jsx").map(codeOf).join("\n");
const SHOTS = process.env.I18N_SHOTS || "";   // optional folder for screenshots
const RUN = Date.now().toString(36).slice(-5);

const wholeWords = (run, text) => new RegExp("(^|[^\u0600-\u06FF])" + run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^\u0600-\u06FF]|$)").test(text);

async function leftovers(page, allow = []) {
  const runs = await untranslatedUi(page, allow);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll("#clinic-main, [role=dialog], [role=status], [role=alert]"))
    .map((el) => [el, ...el.querySelectorAll("[placeholder], [aria-label], [title]")]
      .map((e) => ["placeholder", "aria-label", "title"].map((a) => e.getAttribute(a) || "").join(" "))
      .join(" ") + " " + (el.innerText || el.textContent || "")).join("\n"));
  return runs.filter((r) => shown.includes(r) && wholeWords(r, MINE));
}
async function mineMissing(page) {
  return (await missingKeys(page)).filter((k) => MINE.includes(JSON.stringify(k)) || !OTHERS.includes(k));
}
async function expectClean(page, allow = []) {
  expect(await mineMissing(page)).toEqual([]);
  expect(await leftovers(page, allow)).toEqual([]);
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${page.viewportSize().width}.png`), fullPage: true });
}

async function signIn(page, email, hash = "") {
  await page.goto(`/?org=demo-physio&lang=en${hash}`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await expect(page.locator("#clinic-main")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
}
const main = (page) => page.locator("#clinic-main");
const open = async (page, route) => {
  await page.locator(`aside.sidebar [data-route="${route}"]`).click();
  await expect(main(page).locator("h1").first()).toBeVisible();
};
const dialog = (page) => page.getByRole("dialog");

test("treatment plans, a plan, and the physio «Diagnosis» form in English", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/treatments");
  await expect(main(page).locator("h1")).toHaveText("Treatment plans");
  await expect(main(page)).toContainText(/\d+ active · \d+ drafts · average progress \d+%/);
  const table = main(page).locator("table.tbl-cards");
  await expect(table.locator("thead")).toContainText("Plan");
  await expect(table.locator("thead")).toContainText("Last updated");
  const row = table.locator("tbody tr[data-clickable]").first();
  await expect(row).toContainText("Active");
  await expect(row.getByRole("button", { name: "Delete plan" })).toBeVisible();
  await shot(page, "treatments");
  await expectClean(page);

  await row.click();
  await expect(main(page).getByRole("button", { name: "Print" })).toBeVisible();
  await expect(main(page)).toContainText("Patient:");
  await expect(main(page)).toContainText("· Therapist:");
  await shot(page, "treatment-plan");
  expect(await mineMissing(page)).toEqual([]);   // the plan body is src/screens1.jsx
  await main(page).locator(".crumb").first().click();

  await main(page).getByRole("button", { name: "Diagnosis" }).click();
  await expect(main(page).locator("h1")).toHaveText("Diagnosis");
  await expect(main(page)).toContainText("Patient and therapist");
  await expect(main(page)).toContainText("Responsible therapist");
  await expect(main(page)).toContainText("Tap any spot to add a marker.");
  await expect(main(page)).toContainText("Marked spots: 0");
  await main(page).getByRole("button", { name: "Save session" }).click();
  await expect(page.getByRole("alert")).toHaveText("Choose the responsible therapist");
  // Labels sit at the start (left) of their row in English.
  const card = main(page).getByText("Patient and therapist", { exact: true });
  expect(await card.evaluate((el) => getComputedStyle(el).textAlign)).toBe("start");
  await shot(page, "physio-form");
  await expectClean(page);
});

test("sessions: tabs, history and notes in English (admin and therapist)", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/sessions");
  await expect(main(page).locator("h1")).toHaveText("Therapy sessions");
  const tabs = main(page).getByRole("group", { name: "Sessions view" });
  await expect(tabs.getByRole("button", { name: "Running sessions" })).toHaveAttribute("aria-pressed", "true");
  await tabs.getByRole("button", { name: "Session history" }).click();
  await expect(tabs.getByRole("button", { name: "Session history" })).toHaveAttribute("aria-pressed", "true");
  await expect(main(page).getByPlaceholder("Search by patient or note…")).toBeVisible();
  await expect(main(page).locator("select").first()).toContainText("All therapists");
  await expect(main(page)).toContainText(/Session #1/);
  await expect(main(page)).toContainText("Pain");
  await main(page).getByRole("button", { name: "View notes" }).first().click();
  await expect(dialog(page)).toContainText(/Session #\d+ notes/);
  await expect(dialog(page)).toContainText("Date:");
  await expect(dialog(page)).toContainText("Pain level:");
  await shot(page, "session-notes");
  await expectClean(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^(Sign out|تسجيل الخروج)$/ }).click();
  await page.locator("#login-email").fill("therapist@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await open(page, "sessions");
  await main(page).getByRole("group", { name: "Sessions view" }).getByRole("button", { name: "Session history" }).click();
  await expect(main(page).getByRole("button", { name: "Delete session" }).first()).toBeVisible();
  await expectClean(page);
});

test("payments and invoices in English: filters, invoice, new invoice, methods, receipts", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/payments");
  await expect(main(page).locator("h1")).toHaveText("Payments and invoices");
  for (const label of ["Total revenue", "Pending", "Overdue", "Average invoice", "Total invoiced", "Paid", "Invoices", "Total due"]) {
    await expect(main(page).locator(".grid-stats").filter({ hasText: label }).first()).toBeVisible();
  }
  await expect(main(page).locator(".grid-stats").first()).toContainText("EGP ");
  const sections = main(page).getByRole("group", { name: "Payments sections" });
  await expect(sections.getByRole("button", { name: "Invoices" })).toHaveAttribute("aria-pressed", "true");
  const period = main(page).getByRole("group", { name: "Invoice period" });
  await expect(period.getByRole("button", { name: "This month" })).toHaveAttribute("aria-pressed", "true");
  await period.getByRole("button", { name: "Date range" }).click();
  await expect(main(page).getByLabel("From date")).toBeVisible();
  await expect(main(page).getByLabel("To date")).toBeVisible();
  await period.getByRole("button", { name: "All", exact: true }).click();
  await expect(main(page).getByRole("group", { name: "Invoice status" }).getByRole("button", { name: "Partial" })).toBeVisible();
  await expect(main(page).getByLabel("Payment method")).toContainText("Bank transfer");

  const table = main(page).locator("table.tbl-cards");
  await expect(table.locator("thead")).toContainText("Invoice");
  const row = table.locator("tbody tr[data-clickable]").filter({ hasText: "INV-PHY-B1-1" });
  await expect(row).toContainText("EGP 600");
  await expect(row).toContainText("Pending");
  await shot(page, "payments");
  await expectClean(page);

  await row.click();
  await expect(dialog(page)).toContainText("Invoice INV-PHY-B1-1");
  for (const t of ["Bill to", "Care team", "Subtotal", "VAT (14%)", "Balance due", "EGP 600", "Send via WhatsApp", "Download PDF"]) {
    await expect(dialog(page)).toContainText(t);
  }
  await shot(page, "invoice");
  await expectClean(page);
  await page.keyboard.press("Escape");

  await main(page).getByRole("button", { name: "New invoice" }).click();
  for (const t of ["New invoice", "Due date", "Payment method", "Invoice items", "Add item", "Create invoice", "Save draft"]) {
    await expect(dialog(page)).toContainText(t);
  }
  await expect(dialog(page).locator("select")).toContainText("Vodafone Cash");
  await expectClean(page);
  await page.keyboard.press("Escape");

  await sections.getByRole("button", { name: "Payment methods" }).click();
  await expect(main(page)).toContainText("Payment method mix · this month");
  await expect(main(page)).toContainText("Revenue by method");
  await expectClean(page);
  await sections.getByRole("button", { name: "Receipts" }).click();
  await expect(main(page)).toContainText("No receipts yet");
  await expect(main(page).getByRole("button", { name: "Upload receipt" })).toBeVisible();
  await expectClean(page);
});

test("payments in Arabic keep their text, with money as «600 ج.م» (one formatter)", async ({ page }) => {
  await page.goto("/?org=demo-physio&lang=ar#/payments");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(main(page).locator("h1")).toHaveText("المدفوعات والفواتير");
  await main(page).getByRole("group", { name: "فترة الفواتير" }).getByRole("button", { name: "الكل", exact: true }).click();
  const row = main(page).locator("table.tbl-cards tbody tr").filter({ hasText: "INV-PHY-B1-1" });
  await expect(row).toContainText("600 ج.م");
  await expect(row).toContainText("معلّق");
});

test("quick payment and its receipt in English", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test");
  // A patient and an invoice of this run on the admin's branch.
  const headers = { "X-Requested-With": "clinicsys", "X-Org-Slug": "demo-physio", "X-Branch-Id": await page.evaluate(() => window.ACTIVE_BRANCH_ID) };
  const name = `Payer ${RUN}`, pid = `P-E2E-QP-${RUN}`, inv = `INV-E2E-QP-${RUN}`;
  let r = await page.request.post("/api/data", { headers, data: { table: "patients", action: "insert", values: { patient_id: pid, name } } });
  expect(r.status(), await r.text()).toBe(200);
  r = await page.request.post("/api/data", { headers, data: { table: "invoices", action: "insert", values: { invoice_id: inv, patient_id: pid, amount: 250, paid: 0 } } });
  expect(r.status(), await r.text()).toBe(200);
  await page.reload();
  await expect(page.locator("#clinic-main")).toBeVisible();

  await main(page).getByRole("button", { name: /^(Quick payment|دفع سريع)$/ }).click();
  await expect(dialog(page)).toContainText("Quick payment");
  await expect(dialog(page)).toContainText("Search for the patient by name, phone or file number");
  await dialog(page).getByLabel("Search for the patient").fill(name);
  await dialog(page).getByRole("button", { name: new RegExp(name) }).click();
  await expect(dialog(page)).toContainText("Unpaid invoices");
  await expect(dialog(page)).toContainText(`Invoice ${inv}`);
  await expect(dialog(page)).toContainText("Total EGP 250 · paid EGP 0");
  await dialog(page).getByLabel(`Invoice ${inv}`).check();
  await expect(dialog(page)).toContainText("Amount to pay");
  await dialog(page).getByRole("button", { name: "Cash", exact: true }).click();
  await expect(dialog(page)).toContainText("1 item(s) selected");
  await shot(page, "quick-payment");
  await expectClean(page, [name]);
  await dialog(page).getByRole("button", { name: "Review payment (EGP 250)" }).click();

  await expect(dialog(page)).toContainText("Confirm payment");
  await expect(dialog(page)).toContainText("Selected items");
  await dialog(page).getByRole("button", { name: "Confirm payment" }).click();
  await expect(dialog(page)).toContainText(/Receipt \S+/);
  for (const t of ["Payment completed", "Cashier", "Paid items", "Amount paid", "EGP 250", "Download CSV", "Print / PDF"]) {
    await expect(dialog(page)).toContainText(t);
  }
  await expect(page.getByRole("status").filter({ hasText: "Payment recorded" })).toBeVisible();
  await shot(page, "receipt");
  await expectClean(page, [name]);

  // The printable receipt: English, left to right inside the print page.
  const popup = page.waitForEvent("popup");
  await dialog(page).getByRole("button", { name: "Print / PDF" }).click();
  const printed = await popup;
  await printed.waitForLoadState();
  const ltr = printed.locator(".receipt-ltr[dir=ltr]");
  await expect(ltr).toContainText("Payment receipt");
  await expect(ltr).toContainText("Payment method");
  await expect(ltr).toContainText("Cash");
  await expect(ltr).toContainText("Total paid");
  await expect(ltr).toContainText("EGP 250");
  await printed.close();
});

test("packages in English", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/packages");
  await expect(main(page).locator("h1")).toHaveText("Treatment packages");
  await expect(main(page)).toContainText("EGP 3,000");
  await expect(main(page)).toContainText("/ package");
  await expect(main(page)).toContainText("10 sessions included");
  await expect(main(page)).toContainText("Valid for 90 days");
  await expect(main(page)).toContainText("Sold this month");
  await shot(page, "packages");
  await expectClean(page);
  await main(page).getByRole("button", { name: "New package" }).click();
  for (const t of ["New package", "Name", "Price (EGP)", "Validity (days)", "Save package"]) await expect(dialog(page)).toContainText(t);
  await expectClean(page);
});

test("campaigns, the builder and the analytics in English", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/campaigns");
  await expect(main(page).locator("h1")).toHaveText("WhatsApp campaigns");
  for (const t of ["Messages sent", "Read rate", "Reply rate", "Active campaigns"]) await expect(main(page)).toContainText(t);
  const row = main(page).locator("table.tbl-cards tbody tr[data-clickable]").first();
  await expect(row).toContainText("Draft");
  const status = main(page).getByRole("group", { name: "Campaign status" });
  await status.getByRole("button", { name: "Running" }).click();
  await expect(main(page)).toContainText("No campaigns with this status.");
  await status.getByRole("button", { name: "All", exact: true }).click();
  await shot(page, "campaigns");
  await expectClean(page);

  await main(page).getByRole("button", { name: "Templates" }).click();
  await expect(dialog(page)).toContainText("Campaign templates");
  await expect(dialog(page)).toContainText("Patient satisfaction survey");
  await dialog(page).getByRole("button", { name: "Use" }).first().click();
  await expect(main(page).locator("h1")).toHaveText("Create campaign");
  await expect(main(page).locator("input.input").first()).toHaveValue("Appointment reminder");
  await expect(main(page).locator(".stepper")).toContainText("Basics");
  await expect(main(page)).toContainText("Live preview · WhatsApp");
  await expect(main(page)).toContainText("Hi {{first_name}} 👋");
  await expectClean(page);
  for (const heading of ["Target audience", "Message", "Schedule"]) {
    await main(page).getByRole("button", { name: "Continue" }).click();
    await expect(main(page).locator(".h2").first()).toHaveText(heading);
    if (heading === "Target audience") await expect(main(page)).toContainText(/This audience includes \d+ patients/);
    await expectClean(page);
  }
  await expect(main(page).getByRole("button", { name: "Launch campaign" })).toBeVisible();
  await shot(page, "campaign-builder");
  await main(page).getByRole("button", { name: "Cancel" }).click();

  await main(page).locator("table.tbl-cards tbody tr[data-clickable]").first().click();
  for (const t of ["Messages over time", "Funnel", "Targeted", "Top replies", "Failed messages", "Run now"]) await expect(main(page)).toContainText(t);
  await shot(page, "campaign-analytics");
  await expectClean(page);
});

test("reports in English: three tabs, both scopes, the per-branch breakdown and the Excel export", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", "#/reports");
  await expect(main(page).locator("h1")).toHaveText("Reports");
  const scope = main(page).getByRole("group", { name: "Report scope" });
  await expect(scope).toHaveClass(/report-scope/);
  await expect(scope.getByRole("button", { name: "Current branch" })).toHaveAttribute("aria-pressed", "true");
  await expect(main(page).locator(".report-branch")).toContainText("Branch: ");
  for (const t of ["From date", "To date", "Patient", "Search", "Collected", "Total invoiced", "Remaining", "Invoices"]) await expect(main(page)).toContainText(t);
  await expect(main(page).locator("table.report-rows thead")).toContainText("Payment method");
  await expect(main(page).locator("table.report-rows")).toHaveClass(/tbl-cards/);
  await expect(main(page)).toContainText(/Page 1 of \d+ · results: \d+/);
  await shot(page, "reports-financial");
  await expectClean(page);

  // Excel: English file and sheet names, headers, left-to-right sheet, EGP format.
  const download = page.waitForEvent("download");
  await main(page).getByRole("button", { name: "Export to Excel" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^financial-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const XLSX = require(path.join(process.env.PW_CDN_CACHE || "/tmp/clinicsys-cdn-cache", "xlsx-js-style-1.2.0", "package", "dist", "xlsx.bundle.js"));
  const wb = XLSX.read(fs.readFileSync(await file.path()), { cellStyles: true, bookViews: true });
  expect(wb.SheetNames).toEqual(["Financial report"]);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Financial report"], { header: 1, raw: false });
  expect(rows[1]).toEqual(["Financial report"]);
  expect(String(rows[2][0])).toMatch(/^Created: /);
  expect(String(rows[3][0])).toMatch(/^Filters: {2}Period: \S+ → \S+ {3}\| {3}Branch: /);
  expect(rows.find((x) => x[0] === "Date")).toEqual(["Date", "Patient", "Payment method", "Amount", "Paid", "Outstanding", "Status"]);
  expect(rows.some((x) => x[0] === "Total")).toBe(true);

  await scope.getByRole("button", { name: "All branches" }).click();
  await expect(scope.getByRole("button", { name: "All branches" })).toHaveAttribute("aria-pressed", "true");
  await expect(main(page).locator(".report-branch")).toContainText(/All branches \(\d+\)/);
  const breakdown = main(page).locator(".report-branch-breakdown");
  await expect(breakdown).toContainText("By branch");
  await expect(breakdown.locator("thead")).toContainText("Branch");
  await expect(breakdown.locator('tr[data-branch-row="total"]')).toContainText("Total");
  await expect(breakdown.locator('tr[data-branch-row="total"] [data-metric="invoiced"]')).toContainText("EGP ");
  await expect(main(page).locator("table.report-rows thead")).toContainText("Branch");
  await shot(page, "reports-all");
  await expectClean(page);

  await main(page).locator(".side-tabs .nav-item", { hasText: "Medical" }).click();
  for (const t of ["Patients in treatment", "Average sessions per patient", "Diagnosis mix", "Treatment progress · average pain", "Session no."]) await expect(main(page)).toContainText(t);
  await expect(breakdown).toContainText("By branch");
  await expectClean(page);
  await main(page).locator(".side-tabs .nav-item", { hasText: "Operational" }).click();
  for (const t of ["Booked appointments", "Attendance rate", "No-show rate", "Completion rate", "Appointments by weekday", "Appointments by hour", "Room"]) await expect(main(page)).toContainText(t);
  await expect(main(page).locator("svg text").filter({ hasText: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/ }).first()).toBeVisible();
  await scope.getByRole("button", { name: "Current branch" }).click();
  await expect(breakdown).toHaveCount(0);
  await shot(page, "reports-operational");
  await expectClean(page);
});

test("reports for a doctor in English: the current branch only", async ({ page }) => {
  await signIn(page, "doctor@demo-physio.test", "#/reports");
  await expect(main(page).locator("h1")).toHaveText("Reports");
  await expect(main(page).locator(".report-branch")).toContainText("Switch the branch in the sidebar to see its reports.");
  await expect(main(page).getByRole("group", { name: "Report scope" })).toHaveCount(0);
  await expectClean(page);
});

test.describe("phone width (390×844)", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("payments and reports turn their tables into cards, without sideways scrolling", async ({ page }) => {
    await signIn(page, "admin@demo-physio.test", "#/payments");
    await main(page).getByRole("group", { name: "Invoice period" }).getByRole("button", { name: "All", exact: true }).click();
    const cell = main(page).locator("table.tbl-cards tbody tr[data-clickable] td").nth(1);
    await expect(cell).toHaveAttribute("data-label", "Patient");
    expect(await main(page).locator("table.tbl-cards thead").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    await shot(page, "payments");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.goto("/?org=demo-physio&lang=en#/reports");
    await expect(main(page).locator("table.report-rows")).toBeVisible();
    await expect(main(page).locator("table.report-rows tbody tr td").first()).toHaveAttribute("data-label", /Date|Branch/);
    await shot(page, "reports");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expectClean(page);
  });
});
