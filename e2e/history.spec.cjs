// Bounded loading (docs/06 S9): at startup the clinic screens read
// bookings, sessions, invoices and payments from 180 days ago onwards
// (KineticData.windowFrom()), not the clinic's whole past. Older rows come
// when a screen shows them: the patient file (the patient's whole history)
// and a report of an older period.
const { test, expect } = require("./fixtures.cjs");

const PHYSIO = "عيادة العلاج الطبيعي التجريبية";
const PASSWORD = "Dev@12345";
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sidebar = (page) => page.locator("aside.sidebar");
const main = (page) => page.locator("main");
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };

async function clinicLogin(page, email) {
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
}

test("2,000 bookings of two years ago stay out of startup; the patient file and a report of last year still show the old rows", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?org=demo-physio");
  await clinicLogin(page, "admin@demo-physio.test");
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect.poll(() => page.evaluate(() => window.ACTIVE_BRANCH_ID)).toBeTruthy();
  const branch = await page.evaluate(() => window.ACTIVE_BRANCH_ID);

  // Two patients of this run (written as the screens would, with the branch).
  const run = uniq();
  const name = `مريض السجل ${run}`;
  const other = `مريض تقرير قديم ${run}`;
  const note = `جلسة قديمة ${run}`;
  const pid = `P-E2E-HIS-${run}`;
  const pid2 = `P-E2E-HIS2-${run}`;
  const headers = { "X-Requested-With": "clinicsys", "X-Org-Slug": "demo-physio", "X-Branch-Id": branch };
  const post = async (data) => {
    const r = await page.request.post("/api/data", { headers, data });
    expect(r.status(), await r.text()).toBe(200);
  };
  await post({ table: "patients", action: "insert", values: [{ patient_id: pid, name }, { patient_id: pid2, name: other }] });
  for (let k = 0; k < 2; k++) {
    await post({ table: "bookings", action: "insert", values: Array.from({ length: 1000 }, (_, i) => ({
      booking_id: `B-E2E-HIS-${run}-${k}-${i}`, patient_id: pid, date: daysAgo(700 + (i % 60)), time: "09:00", status: "مكتمل",
    })) });
  }
  const old = daysAgo(730);
  await post({ table: "sessions", action: "insert", values: { session_id: `S-E2E-HIS-${run}`, patient_id: pid, date: old, session_number: 7, status: "completed", session_notes: note } });
  // Last year's invoice of a patient whose file is never opened: only the report reads it.
  const lastYear = new Date().getFullYear() - 1;
  await post({ table: "invoices", action: "insert", values: { invoice_id: `INV-E2E-HIS-${run}`, patient_id: pid2, amount: 4321, paid: 4321, status: "paid", created_at: `${lastYear}-03-15T10:00:00+00:00` } });

  // Startup: bookings are asked from the window's first day; none of the 2,000 come back.
  const bookingBodies = [];
  page.on("response", (r) => {
    const req = r.request();
    if (r.url().endsWith("/api/data") && req.method() === "POST" && (req.postDataJSON() || {}).table === "bookings") {
      bookingBodies.push(Promise.all([req.postDataJSON(), r.json().catch(() => null)]));
    }
  });
  await page.reload();
  await expect(sidebar(page)).toContainText(PHYSIO);
  await expect.poll(() => page.evaluate(() => window.DATA_LOADED === true)).toBe(true);
  const from = await page.evaluate(() => window.KineticData.windowFrom());
  expect(from).toBe(daysAgo(180));
  const startup = await Promise.all(bookingBodies);
  expect(startup.length).toBeGreaterThan(0);
  // The window from its first day, and the undated bookings (shown as today's).
  for (const [req] of startup) {
    expect([[{ column: "date", op: "gte", value: from }], [{ column: "date", op: "is", value: null }]]).toContainEqual(
      req.filters.filter((f) => f.column === "date"));
  }
  expect(startup.some(([req]) => req.filters.some((f) => f.op === "gte"))).toBe(true);
  expect(startup.flatMap(([, res]) => (res && res.data) || []).filter((b) => b.patient_id === pid)).toEqual([]);
  expect(await page.evaluate((id) => window.DATA.appts.filter((a) => a.patient_id === id).length, pid)).toBe(0);

  // The patient file: the two-year-old session is in the patient's history.
  await sidebar(page).locator('[data-route="patients"]').click();
  await main(page).getByPlaceholder("ابحث بالاسم، رقم الملف، التشخيص…").fill(run);
  await main(page).locator("tbody tr[data-clickable]").filter({ hasText: name }).first().click();
  await main(page).getByRole("button", { name: "السجل", exact: true }).click();
  await expect(main(page).getByText(note)).toBeVisible();
  await expect(main(page).getByText(old, { exact: true })).toBeVisible();
  expect(await page.evaluate((id) => window.DATA.appts.filter((a) => a.patient_id === id).length, pid)).toBe(2000);

  // A report of last year: its invoice and totals, read for that period.
  await sidebar(page).locator('[data-route="reports"]').click();
  const rows = main(page).locator(".report-rows tbody tr[data-branch]");
  await main(page).getByPlaceholder("بحث بالمريض أو طريقة الدفع…").fill(run);
  await expect(rows).toHaveCount(0); // the last 30 days
  await main(page).getByLabel("من تاريخ").fill(`${lastYear}-01-01`);
  await main(page).getByLabel("إلى تاريخ").fill(`${lastYear}-12-31`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(other);
  await expect(rows.first()).toContainText(/4,321/);
  expect(await page.evaluate(() => window.KineticData.windowFrom())).toBe(`${lastYear}-01-01`);
});
