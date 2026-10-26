// The patient file and the diagnosis per department (0018_clinical_records;
// owner request 26 Oct 2026; docs/06 CR2–CR5).
//   physio: the diagnosis form saves to the database (it lived in one
//   device's localStorage), the pain points as coordinates only, and the
//   patient file's «التشخيص» tab shows them on the same body picture.
//   dental: the owner's picture — header with the medical alerts, tooth
//   chart (FDI) from dental_findings, tooth panel and history, treatment,
//   visit notes, prescriptions; the receptionist sees no clinical part.
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
async function rowsOf(page, table, patientId, slug) {
  const r = await page.request.post("/api/data", {
    headers: { "X-Requested-With": "clinicsys", "X-Org-Slug": slug },
    data: { table, filters: [{ column: "patient_id", op: "eq", value: patientId }], order: [{ column: "created_at", ascending: false }] },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).data;
}
const assessmentsOf = (page, patientId, slug = "demo-physio") => rowsOf(page, "assessments", patientId, slug);
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

// ── dental ────────────────────────────────────────────────────
const DEN = "مريض أول — DEN";
const tooth = (page, n) => main(page).locator(`[data-tooth-chart] [data-tooth="${n}"]`);

test("dental: the dentist's patient list has their patient; the file opens on the tooth chart drawn from the database", async ({ page }) => {
  // The doctor's caseload matched p.dr, which was never filled from doctor_id: every doctor's list was empty.
  await signIn(page, "doctor@demo-dental.test", { slug: "demo-dental" });
  await openPatient(page, DEN);
  const header = main(page).locator("[data-clinical-header]");
  await expect(header).toContainText("ملف رقم MF-1");
  await expect(header).toContainText("34 سنة");
  await expect(header).toContainText("تذكيرات واتساب مفعّلة");
  await expect(header.locator("[data-medical-alerts]")).toContainText("لا تنبيهات طبية");
  for (const name of ["ملاحظة زيارة جديدة", "وصفة جديدة", "حجز موعد"]) await expect(header.getByRole("button", { name })).toBeVisible();
  expect(await main(page).getByRole("tab").allInnerTexts()).toEqual(
    ["نظرة عامة", "مخطط الأسنان", "العلاج", "الفواتير", "ملاحظات الزيارات", "الوصفات", "المواعيد", "الملفات"]);
  await expect(main(page).getByRole("tab", { name: "مخطط الأسنان" })).toHaveAttribute("aria-selected", "true");

  // The seeded findings (db/seed/dev.sql DF-DEN-*), as in the owner's picture.
  const expected = { 16: ["restored", "F"], 14: ["attention", "C"], 11: ["planned", "V"], 21: ["restored", "Cr"], 24: ["restored", "F"],
    26: ["planned", "RCT Cr"], 36: ["attention", "C"], 37: ["restored", "F"], 45: ["attention", "W"], 46: ["restored", "Imp"], 48: ["missing", "M"], 13: ["none", ""] };
  for (const [n, [cat, label]] of Object.entries(expected)) {
    await expect(tooth(page, n)).toHaveAttribute("data-category", cat);
    expect((await tooth(page, n).innerText()).replace(/\s+/g, " ").trim()).toBe(`${n} ${label}`.trim());
  }
  await expect(main(page).locator("[data-tooth-chart] [data-tooth]")).toHaveCount(32);
  // Facing the patient whatever the language: 18 on the left of 11, 21 on the right.
  const x = async (n) => (await tooth(page, n).boundingBox()).x;
  expect(await x(18)).toBeLessThan(await x(11));
  expect(await x(11)).toBeLessThan(await x(21));
  await expect(tooth(page, 26)).toHaveAttribute("aria-label", "السن 26: علاج عصب (تم)، تاج (مخطط)");

  // Child teeth.
  await main(page).getByRole("group", { name: "الأسنان" }).getByRole("button", { name: "طفل" }).click();
  await expect(main(page).locator("[data-tooth-chart=child] [data-tooth]")).toHaveCount(20);
  await main(page).getByRole("group", { name: "الأسنان" }).getByRole("button", { name: "بالغ" }).click();

  // Tooth 26: the panel and its history, newest first.
  await tooth(page, 26).click();
  await expect(tooth(page, 26)).toHaveAttribute("aria-pressed", "true");
  const history = main(page).locator("[data-tooth-history='26'] [data-finding]");
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("تاج");
  await expect(history.nth(0)).toContainText("مخطط");
  await expect(history.nth(0)).toContainText("الطبيب — DEN");
  await expect(history.nth(1)).toContainText("علاج عصب");
  await expect(main(page).locator("[data-tooth-panel='26']")).toContainText("حدد الأسطح إن لزم، ثم اضغط حالة لحفظها.");
});

test("dental: a condition saved from the tooth panel is one new row; caries stays «needs attention» until its filling is done", async ({ page }) => {
  await signIn(page, "doctor@demo-dental.test", { slug: "demo-dental" });
  await openPatient(page, DEN);
  await tooth(page, 36).click();
  const panel = main(page).locator("[data-tooth-panel='36']");
  await panel.locator("[data-surface=M]").click();
  await panel.locator("[data-surface=O]").click();
  await expect(panel.locator("[data-surface=M]")).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("group", { name: "الحالة", exact: true }).getByRole("button", { name: "مخطط" }).click();
  await panel.getByLabel("ملاحظة على السن (اختياري)").fill("حشوة كومبوزيت بعد إزالة التسوس");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/data") && (r.request().postDataJSON() || {}).table === "dental_findings"
    && (r.request().postDataJSON() || {}).action === "insert");
  await panel.locator("[data-condition=filling]").click();
  const sent = (await saved).request().postDataJSON().values;
  expect(sent).toEqual({ patient_id: "P-DEN-01", tooth: 36, surfaces: ["M", "O"], condition: "filling", status: "planned", notes: "حشوة كومبوزيت بعد إزالة التسوس" });
  await expect(page.getByRole("status").filter({ hasText: "تم الحفظ: السن 36 — حشوة (مخطط)" })).toBeVisible();
  // The panel is ready for the next condition.
  await expect(panel.locator("[data-surface=M]")).toHaveAttribute("aria-pressed", "false");
  await expect(tooth(page, 36)).toHaveAttribute("data-category", "attention");
  await expect(tooth(page, 36)).toContainText("C F");
  const history = main(page).locator("[data-tooth-history='36'] [data-finding]");
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("حشوة");
  await expect(history.first()).toContainText("MO");

  // «العلاج»: planned, then done from there.
  await main(page).getByRole("tab", { name: "العلاج" }).click();
  const plan = main(page).locator("[data-tab=treatment] [data-treatment]").filter({ hasText: "حشوة" });
  await expect(plan).toHaveCount(1);
  await plan.getByRole("button", { name: "تم" }).click();
  await expect(page.getByRole("status").filter({ hasText: "تم تسجيل الإنجاز" })).toBeVisible();
  await expect(main(page).locator("[data-tab=treatment] [data-treatment]").filter({ hasText: "حشوة" })).toHaveCount(1); // now under «ما أُنجز»
  await main(page).getByRole("tab", { name: "مخطط الأسنان" }).click();
  await expect(tooth(page, 36)).toHaveAttribute("data-category", "restored");
  await expect(tooth(page, 36)).toContainText("F");
  await expect(tooth(page, 36)).not.toContainText("C");

  const rows = (await rowsOf(page, "dental_findings", "P-DEN-01", "demo-dental")).filter((r) => r.tooth === 36);
  expect(rows.map((r) => [r.condition, r.status])).toEqual([["filling", "done"], ["filling", "planned"], ["caries", "existing"]]);
  expect(rows[0].surfaces).toEqual(["M", "O"]);
  expect(rows[0].author_name).toBe("الطبيب — DEN");
});

test("dental: a visit note and a prescription from the header; the prescription prints with its values escaped", async ({ page }) => {
  await signIn(page, "doctor@demo-dental.test", { slug: "demo-dental" });
  await openPatient(page, DEN);
  await main(page).locator("[data-clinical-header]").getByRole("button", { name: "ملاحظة زيارة جديدة" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("اكتب الشكوى أو التشخيص أو ما تم اليوم");
  await dialog.getByLabel("الشكوى الرئيسية").fill("حساسية في الأسنان الأمامية");
  await dialog.getByLabel("التشخيص").fill("تآكل المينا في 11 و 21");
  await dialog.getByLabel("ما تم اليوم").fill("تطبيق فلورايد");
  await dialog.getByLabel("الزيارة القادمة").fill("بعد 3 أشهر");
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByRole("status").filter({ hasText: "تم حفظ ملاحظة الزيارة" })).toBeVisible();
  await expect(main(page).getByRole("tab", { name: "ملاحظات الزيارات" })).toHaveAttribute("aria-selected", "true");
  const note = main(page).locator("[data-tab=visits] [data-assessment]").first();
  await expect(note).toContainText("تآكل المينا في 11 و 21");
  await expect(note).toContainText("الزيارة القادمة");
  await expect(note).toContainText("بعد 3 أشهر");
  const [visit] = await assessmentsOf(page, "P-DEN-01", "demo-dental");
  expect([visit.kind, visit.complaint, visit.data.treatment_done, visit.data.next_visit]).toEqual(["dental", "حساسية في الأسنان الأمامية", "تطبيق فلورايد", "بعد 3 أشهر"]);
  expect(visit.markers).toEqual([]); // no body chart outside physiotherapy

  await main(page).locator("[data-clinical-header]").getByRole("button", { name: "وصفة جديدة" }).click();
  const rx = page.getByRole("dialog");
  await rx.getByRole("button", { name: "إضافة دواء" }).click();
  const meds = rx.locator("fieldset");
  await expect(meds).toHaveCount(2);
  await meds.nth(0).getByRole("textbox", { name: "الدواء" }).fill("Ibuprofen <i>x</i>");
  await meds.nth(0).getByRole("textbox", { name: "الجرعة" }).fill("400 mg");
  await meds.nth(0).getByRole("textbox", { name: "عدد المرات" }).fill("كل 8 ساعات");
  await meds.nth(1).getByRole("textbox", { name: "الجرعة" }).fill("5 ml");
  await rx.getByRole("button", { name: "حفظ الوصفة" }).click();
  await expect(rx.getByRole("alert")).toHaveText("اكتب اسم كل دواء");
  await rx.getByRole("button", { name: "حذف الدواء 2" }).click();
  await rx.getByLabel("تعليمات للمريض").fill("بعد الأكل");
  await rx.getByRole("button", { name: "حفظ الوصفة" }).click();
  await expect(page.getByRole("status").filter({ hasText: "تم حفظ الوصفة" })).toBeVisible();
  const card = main(page).locator("[data-tab=prescriptions] [data-rx]").first();
  await expect(card).toContainText("Ibuprofen <i>x</i>");
  await expect(card).toContainText("400 mg");
  const [saved] = await rowsOf(page, "prescriptions", "P-DEN-01", "demo-dental");
  expect(saved.items).toEqual([{ name: "Ibuprofen <i>x</i>", dose: "400 mg", frequency: "كل 8 ساعات" }]);
  expect(saved.notes).toBe("بعد الأكل");

  const popup = page.waitForEvent("popup");
  await card.getByRole("button", { name: "طباعة" }).click();
  const win = await popup;
  await expect(win.locator("table")).toContainText("Ibuprofen <i>x</i>");
  await expect(win.locator("table i")).toHaveCount(0);
  await expect(win.locator("body")).toContainText(DEN);
  await win.close();
});

test("dental: the receptionist's file has the patient's details, billing and appointments, and asks for no clinical record", async ({ page }) => {
  const clinical = [];
  page.on("request", (r) => {
    const t = r.url().endsWith("/api/data") && r.method() === "POST" ? (r.postDataJSON() || {}).table : null;
    if (["assessments", "dental_findings", "prescriptions"].includes(t)) clinical.push(t);
  });
  await signIn(page, "receptionist@demo-dental.test", { slug: "demo-dental" });
  await openPatient(page, DEN);
  expect(await main(page).getByRole("tab").allInnerTexts()).toEqual(["نظرة عامة", "الفواتير", "المواعيد", "الملفات"]);
  await expect(main(page).locator("[data-patient-details]")).toContainText("01110002001");
  await expect(main(page).locator("[data-count]")).toHaveCount(0);
  const header = main(page).locator("[data-clinical-header]");
  await expect(header.getByRole("button", { name: "ملاحظة زيارة جديدة" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "وصفة جديدة" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "حجز موعد" })).toBeVisible();
  await main(page).getByRole("tab", { name: "المواعيد" }).click();
  await expect(main(page).locator("[data-tab=appointments] tbody tr")).not.toHaveCount(0);
  expect(clinical).toEqual([]);
});

test("dental: the patient file in English", async ({ page }) => {
  await signIn(page, "admin@demo-dental.test", { slug: "demo-dental", lang: "en" });
  await openPatient(page, DEN);
  expect(await main(page).getByRole("tab").allInnerTexts()).toEqual(
    ["Overview", "Tooth chart", "Treatment", "Invoices", "Visit notes", "Prescriptions", "Appointments", "Files"]);
  await expect(main(page).locator("[data-clinical-header]")).toContainText("File #MF-1");
  await expect(main(page).locator("[data-clinical-header]")).toContainText("WhatsApp reminders on");
  await expect(main(page)).toContainText("Patient's right");
  await expect(tooth(page, 26)).toHaveAttribute("aria-label", "Tooth 26: Root canal (Done), Crown (Planned)");
  await tooth(page, 26).click();
  await expect(main(page).locator("[data-tooth-panel='26']")).toContainText("Tap surfaces if needed, then tap a condition to save it.");
  for (const tab of ["Overview", "Treatment", "Visit notes", "Prescriptions", "Appointments", "Tooth chart"]) {
    await main(page).getByRole("tab", { name: tab }).click();
    expect(await missingKeys(page), tab).toEqual([]);
    // The records' own text is data (written in Arabic by the tests above).
    expect(await untranslatedUi(page, ["كل 8 ساعات"]), tab).toEqual([]);
  }
});
