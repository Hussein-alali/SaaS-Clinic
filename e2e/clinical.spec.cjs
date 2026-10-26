// The patient file and the diagnosis per department (0018_clinical_records;
// owner request 26 Oct 2026; docs/06 CR2–CR5).
//   physio: the diagnosis form saves to the database (it lived in one
//   device's localStorage), the pain points as coordinates only, and the
//   patient file's «التشخيص» tab shows them on the same body picture.
const { test, expect, PASSWORD, untranslatedUi, missingKeys } = require("./fixtures.cjs");

const main = (page) => page.locator("#clinic-main");
const sidebar = (page) => page.locator("aside.sidebar");

async function signIn(page, email, { slug = "demo-physio", lang = "", hash = "" } = {}) {
  await page.goto(`/?org=${slug}${lang ? `&lang=${lang}` : ""}${hash}`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await expect(main(page)).toBeVisible();
}
async function openPatient(page, name) {
  await sidebar(page).locator('[data-route="patients"]').click();
  await main(page).locator("tbody tr[data-clickable]").filter({ hasText: name }).first().click();
  await expect(main(page).locator("h1").filter({ hasText: name })).toBeVisible();
}
// An EntityCombobox (src/ui.jsx): its trigger, then the option by name.
async function pick(page, trigger, option) {
  await main(page).getByRole("button", { name: trigger }).click();
  await page.getByRole("option", { name: new RegExp(option) }).first().click();
}
async function assessmentsOf(page, patientId, slug = "demo-physio") {
  const r = await page.request.post("/api/data", {
    headers: { "X-Requested-With": "clinicsys", "X-Org-Slug": slug },
    data: { table: "assessments", filters: [{ column: "patient_id", op: "eq", value: patientId }], order: [{ column: "created_at", ascending: false }] },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).data;
}
// Taps the body picture at fractions of its size; returns nothing (the
// saved coordinates are read back from the API's answer).
async function tapBody(page, fx, fy) {
  const body = main(page).locator("[data-body-diagram=edit]");
  const box = await body.boundingBox();
  await body.click({ position: { x: box.width * fx, y: box.height * fy } });
}

test.describe.configure({ mode: "serial" });

test("physio: a therapist marks the pain points and saves; the diagnosis is in the database with the points as coordinates", async ({ page }) => {
  // Therapists have no «خطط العلاج» page: the diagnosis opens from the patient file.
  await signIn(page, "therapist@demo-physio.test");
  await openPatient(page, "مريضة ثانية — PHY");
  await main(page).getByRole("button", { name: "التشخيص", exact: true }).click();
  await expect(main(page).getByText("لا تشخيص محفوظ بعد")).toBeVisible();
  await main(page).getByRole("button", { name: "تشخيص جديد" }).click();
  await expect(main(page).locator("h1")).toHaveText("تشخيص");
  await expect(main(page).getByRole("button", { name: /مريضة ثانية — PHY/ })).toBeVisible(); // the patient is chosen
  await pick(page, "Select therapist…", "الأخصائي — PHY");
  await expect(main(page).locator("[data-physio-start]")).toHaveCount(0); // no earlier diagnosis
  await main(page).getByPlaceholder("Clinical diagnosis").fill("التهاب أوتار الكتف الأيمن");
  await tapBody(page, 0.62, 0.22);
  await tapBody(page, 0.64, 0.25);
  await tapBody(page, 0.36, 0.24);
  await expect(main(page).locator("[data-body-diagram=edit] [data-marker]")).toHaveCount(3);
  await expect(main(page)).toContainText("المواضع المحددة: 3");

  const saved = page.waitForResponse((r) => r.url().endsWith("/api/data") && r.request().method() === "POST"
    && (r.request().postDataJSON() || {}).table === "assessments" && (r.request().postDataJSON() || {}).action === "insert");
  await main(page).getByRole("button", { name: "حفظ التشخيص" }).click();
  const body = await (await saved).json();
  const sent = (await saved).request().postDataJSON().values;
  expect(Object.keys(sent).sort()).toEqual(["clinician_id", "clinician_name", "data", "diagnosis", "kind", "markers", "patient_id"]);
  expect(sent.markers).toHaveLength(3);
  for (const p of sent.markers) {
    expect(p).toHaveLength(2);
    for (const n of p) expect(n >= 0 && n <= 100 && Math.round(n * 10) === n * 10).toBe(true);
  }
  expect(body.data.markers).toEqual(sent.markers);
  await expect(page.getByRole("status").filter({ hasText: "تم حفظ التشخيص في ملف المريض" })).toBeVisible();

  // A second save updates the same record (no duplicate on a second click).
  await tapBody(page, 0.9, 0.7);
  await main(page).getByRole("button", { name: "حفظ التعديلات" }).click();
  await expect.poll(async () => (await assessmentsOf(page, "P-PHY-02")).map((a) => a.markers.length)).toEqual([4]);
  const [row] = await assessmentsOf(page, "P-PHY-02");
  expect(row.kind).toBe("physio");
  expect(row.diagnosis).toBe("التهاب أوتار الكتف الأيمن");
  expect(row.clinician_id).toBe("ST-PHY-THERAPIST");
  expect(row.author_name).toBe("الأخصائي — PHY");
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("physio-session:")))).toEqual([]);
});

test("physio: another account opens the patient file → «التشخيص» shows the same points on the same picture", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test");
  const [row] = await assessmentsOf(page, "P-PHY-02");
  await openPatient(page, "مريضة ثانية — PHY");
  await main(page).getByRole("button", { name: "التشخيص", exact: true }).click();
  const view = main(page).locator("[data-body-diagram=view]");
  await expect(view).toBeVisible();
  await expect(view.locator("[data-marker]")).toHaveCount(4);
  expect(await view.locator("[data-marker]").evaluateAll((els) => els.map((e) => e.getAttribute("data-marker"))))
    .toEqual(row.markers.map(([x, y]) => `${x},${y}`));
  // Each point sits where it was tapped: percentages of the same picture.
  const box = await view.boundingBox();
  const first = await view.locator("[data-marker]").first().boundingBox();
  expect(Math.abs(first.x + first.width / 2 - (box.x + box.width * row.markers[0][0] / 100))).toBeLessThan(2);
  await expect(main(page)).toContainText("التهاب أوتار الكتف الأيمن");
  await expect(main(page)).toContainText("الأخصائي — PHY");
  await expect(main(page)).toContainText("المواضع المحددة: 4");
});

test("physio: the receptionist's patient file has no clinical tab", async ({ page }) => {
  await signIn(page, "receptionist@demo-physio.test");
  await openPatient(page, "مريضة ثانية — PHY");
  await expect(main(page).getByRole("button", { name: "الفواتير", exact: true })).toBeVisible();
  await expect(main(page).getByRole("button", { name: "التشخيص", exact: true })).toHaveCount(0);
});

test("physio: a draft kept on this device (before the database) is offered once and moved to the patient file", async ({ page }) => {
  await signIn(page, "therapist@demo-physio.test");
  await page.evaluate(() => localStorage.setItem("physio-session:P-PHY-01", JSON.stringify({
    diagnosis: "مسودة قديمة على الجهاز", modalities: { Laser: true }, markers: [{ view: "back", x: 30, y: 40 }],
  })));
  const before = (await assessmentsOf(page, "P-PHY-01")).length;
  await openPatient(page, "مريض أول — PHY");
  await main(page).getByRole("button", { name: "التشخيص", exact: true }).click();
  // The seeded diagnosis of this patient: three points.
  await expect(main(page).locator("[data-body-diagram=view] [data-marker]")).toHaveCount(3);
  await main(page).getByRole("button", { name: "تشخيص جديد" }).click();
  await expect(main(page).locator("[data-physio-start=device]")).toBeVisible();
  await expect(main(page).getByPlaceholder("Clinical diagnosis")).toHaveValue("مسودة قديمة على الجهاز");
  await expect(main(page).locator("[data-body-diagram=edit] [data-marker]")).toHaveCount(1);
  await pick(page, "Select therapist…", "الأخصائي — PHY");
  await main(page).getByRole("button", { name: "حفظ التشخيص" }).click();
  await expect(page.getByRole("status").filter({ hasText: "تم حفظ التشخيص في ملف المريض" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("physio-session:P-PHY-01"))).toBeNull();
  const rows = await assessmentsOf(page, "P-PHY-01");
  expect(rows.length).toBe(before + 1);
  expect(rows[0].markers).toEqual([[30, 40]]);
  expect(rows[0].data.modalities).toEqual(["Laser"]);

  // Back in the file: the newest diagnosis first, the earlier one selectable.
  await main(page).locator(".crumb").first().click();
  await expect(main(page).locator("[data-body-diagram=view] [data-marker]")).toHaveCount(1);
  const options = main(page).getByRole("option");
  await expect(options).toHaveCount(before + 1);
  await options.nth(1).click();
  await expect(main(page).locator("[data-body-diagram=view] [data-marker]")).toHaveCount(3);
  // A new diagnosis now starts from the latest one.
  await main(page).getByRole("button", { name: "تشخيص جديد" }).click();
  await expect(main(page).locator("[data-physio-start=latest]")).toBeVisible();
});

test("physio: the patient file's diagnosis tab in English", async ({ page }) => {
  await signIn(page, "admin@demo-physio.test", { lang: "en" });
  await openPatient(page, "مريض أول — PHY");
  await main(page).getByRole("button", { name: "Diagnosis", exact: true }).click();
  await expect(main(page).getByRole("heading", { name: "Pain chart and diagnosis" })).toBeVisible();
  await expect(main(page).getByRole("button", { name: "New diagnosis" })).toBeVisible();
  await expect(main(page)).toContainText(/Marked spots: \d/);
  expect(await missingKeys(page)).toEqual([]);
  // The diagnoses' own text is data (written in Arabic by the earlier tests).
  expect(await untranslatedUi(page, ["مسودة قديمة على الجهاز"])).toEqual([]);
});
