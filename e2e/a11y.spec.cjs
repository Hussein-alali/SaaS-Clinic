// Keyboard accessibility of the shared dialog (src/ui.jsx Modal, docs/04
// «إمكانية الوصول», docs/06 task 3.17): focus moves into the dialog, Tab
// and Shift+Tab never reach the page behind it, Esc closes it (only when it
// may be closed), focus returns to the element that opened it, and with
// stacked dialogs only the top one does this.
const { test, expect, PASSWORD } = require("./fixtures.cjs");

// Where the focus is: inside which dialog (its aria-labelledby title text),
// or null when it is outside every dialog.
async function focusDialog(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest('[role="dialog"]');
    if (!box) return null;
    const title = document.getElementById(box.getAttribute("aria-labelledby") || "");
    return title ? title.textContent : "(untitled)";
  });
}
const focusedLabel = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? (el.getAttribute("aria-label") || el.id || (el.textContent || "").trim() || el.tagName) : "";
});

// Presses `key` `times` times; after every press the focus must still be in
// the dialog titled `title`. Returns the labels of the elements visited.
async function tabAround(page, key, times, title) {
  const seen = [];
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    expect(await focusDialog(page), `${key} #${i + 1} left the dialog «${title}»`).toBe(title);
    seen.push(await focusedLabel(page));
  }
  return seen;
}

test("C06 «دعوة موظف»: focus moves in, Tab / Shift+Tab stay inside, Esc closes, focus returns to the button (task 3.17)", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await page.locator("#login-email").fill("admin@demo-physio.test");
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.locator('aside.sidebar [data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  await expect(page.locator(".staff-panel")).toBeVisible();

  // Opened from the keyboard.
  const trigger = page.getByRole("button", { name: "دعوة موظف" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "دعوة موظف" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#staff-invite-email")).toBeFocused(); // its autoFocus field

  // Forward: round and round inside (the close button and «إرسال الدعوة»
  // are both reached, so the focus wrapped past both ends).
  const forward = await tabAround(page, "Tab", 20, "دعوة موظف");
  expect(forward).toContain("إغلاق");
  expect(forward.some((l) => l.includes("إرسال الدعوة"))).toBe(true);
  // Backward too.
  const backward = await tabAround(page, "Shift+Tab", 20, "دعوة موظف");
  expect(backward).toContain("إغلاق");
  expect(backward).toContain("staff-invite-email");

  // Esc closes it; the focus is back on «دعوة موظف».
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Modal: stacked dialogs trap focus in the top one only; Esc closes the top one; a dialog that may not be closed ignores Esc (task 3.17)", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await expect(page.locator("#login-email")).toBeVisible();
  // A small screen of its own built from the shared Modal.
  await page.evaluate(() => {
    const h = React.createElement;
    function Harness() {
      const [outer, setOuter] = React.useState(false);
      const [inner, setInner] = React.useState(false);
      const [locked, setLocked] = React.useState(false);
      return h("div", { id: "harness" },
        h("button", { id: "open-outer", type: "button", onClick: () => setOuter(true) }, "فتح النافذة"),
        h("button", { id: "open-locked", type: "button", onClick: () => setLocked(true) }, "فتح نافذة الحفظ"),
        outer && h(window.Modal, {
          title: "النافذة الخارجية", onClose: () => setOuter(false),
          footer: h("button", { id: "outer-ok", type: "button", className: "btn" }, "موافق"),
        },
          h("input", { id: "outer-field", "aria-label": "حقل خارجي" }),
          h("button", { id: "open-inner", type: "button", className: "btn", onClick: () => setInner(true) }, "فتح نافذة داخلية"),
          inner && h(window.Modal, { title: "النافذة الداخلية", onClose: () => setInner(false) },
            h("input", { id: "inner-field", "aria-label": "حقل داخلي" }),
            h("button", { id: "inner-ok", type: "button", className: "btn" }, "تم"))),
        locked && h(window.Modal, { title: "جارٍ الحفظ", onClose: undefined },
          h("button", { id: "locked-done", type: "button", className: "btn", onClick: () => setLocked(false) }, "إنهاء")));
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(h(Harness));
  });

  // No field asks for focus: the dialog itself gets it.
  await page.locator("#open-outer").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "النافذة الخارجية" })).toBeVisible();
  expect(await focusDialog(page)).toBe("النافذة الخارجية");
  expect(await page.evaluate(() => document.activeElement.getAttribute("role"))).toBe("dialog");
  // Shift+Tab from the dialog itself goes to its last element, not behind it.
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#outer-ok")).toBeFocused();
  await tabAround(page, "Tab", 9, "النافذة الخارجية");
  await tabAround(page, "Shift+Tab", 9, "النافذة الخارجية");

  // The inner dialog: only it traps now.
  await page.locator("#open-inner").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "النافذة الداخلية" })).toBeVisible();
  const innerSeen = await tabAround(page, "Tab", 8, "النافذة الداخلية");
  expect(innerSeen).toContain("inner-ok");
  expect(innerSeen).toContain("حقل داخلي");
  expect(innerSeen).not.toContain("حقل خارجي");
  await tabAround(page, "Shift+Tab", 8, "النافذة الداخلية");
  // Esc closes the inner one only; focus back on its opener in the outer.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "النافذة الداخلية" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "النافذة الخارجية" })).toBeVisible();
  await expect(page.locator("#open-inner")).toBeFocused();
  await tabAround(page, "Tab", 6, "النافذة الخارجية");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "النافذة الخارجية" })).toHaveCount(0);
  await expect(page.locator("#open-outer")).toBeFocused();

  // While saving (no onClose) Esc does nothing; focus still stays inside.
  await page.locator("#open-locked").focus();
  await page.keyboard.press("Enter");
  const locked = page.getByRole("dialog", { name: "جارٍ الحفظ" });
  await expect(locked).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(locked).toBeVisible();
  await tabAround(page, "Tab", 4, "جارٍ الحفظ");
  await page.locator("#locked-done").click();
  await expect(locked).toHaveCount(0);
});

// ── Dialogs that draw their own box (task 3.10): the same keyboard rules
// through useDialogFocus in src/ui.jsx.

async function clinicLogin(page, email) {
  await page.goto("/?org=demo-physio");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator("aside.sidebar")).toBeVisible();
}

test("C03 reschedule: a booking opens from the keyboard; «إعادة جدولة الموعد» is a named dialog that keeps Tab inside, closes on Esc and gives focus back to the booking (task 3.10)", async ({ page }) => {
  await clinicLogin(page, "admin@demo-physio.test");
  await page.locator('aside.sidebar [data-route="appointments"]').click();
  // Today's seeded booking in the main branch, reached with the keyboard.
  const block = page.locator('div[draggable=true][role="button"]').filter({ hasText: "مريض أول — PHY" }).first();
  await expect(block).toBeVisible();
  await block.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "تفاصيل الموعد" })).toBeVisible();
  await page.getByRole("button", { name: "نقل / تعديل" }).focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "إعادة جدولة الموعد" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: "تفاصيل الموعد" })).toHaveCount(0);
  expect(await focusDialog(page)).toBe("إعادة جدولة الموعد");
  // Round and round: the close button, the day/time/specialist choices and
  // «إلغاء» are visited, nothing behind the dialog is.
  const forward = await tabAround(page, "Tab", 45, "إعادة جدولة الموعد");
  expect(forward).toContain("إغلاق");
  expect(forward).toContain("إلغاء");
  await tabAround(page, "Shift+Tab", 45, "إعادة جدولة الموعد");
  // The choices say which one is picked.
  await expect(dialog.getByRole("group", { name: "الأخصائي" }).locator('[aria-pressed="true"]')).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(block).toBeFocused();
});

test("command palette: «البحث الشامل» is a dialog with a combobox and a listbox; arrows move the active option, Tab stays inside, Esc closes back to the search button (task 3.10)", async ({ page }) => {
  await clinicLogin(page, "admin@demo-physio.test");
  const trigger = page.locator(".topbar button.search-wrap");
  await expect(trigger).toHaveAccessibleName(/ابحث عن مرضى/);
  await trigger.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "البحث الشامل" });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole("combobox");
  await expect(box).toBeFocused();
  await tabAround(page, "Tab", 4, "البحث الشامل");
  await tabAround(page, "Shift+Tab", 4, "البحث الشامل");
  await expect(box).toBeFocused();

  // Pages first (no query), in Arabic.
  const list = dialog.getByRole("listbox", { name: "النتائج" });
  await expect(list.getByRole("option").first()).toContainText("لوحة التحكم");
  await box.fill("مريض أول");
  const options = list.getByRole("option");
  await expect(options.first()).toContainText("مريض أول — PHY");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).toContainText("مريض");
  const firstId = await options.first().getAttribute("id");
  await expect(box).toHaveAttribute("aria-activedescendant", firstId);
  if (await options.count() > 1) {
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(box).toHaveAttribute("aria-activedescendant", await options.nth(1).getAttribute("id"));
  }
  await expect(dialog.getByRole("status")).toContainText("النتائج:");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("patient booking flow (demo patient portal): «احجز زيارة» is a named dialog, keeps Tab inside, a reason chosen with the keyboard moves on, Esc closes back to its button (task 3.10)", async ({ page }) => {
  // The patient portal exists in demo mode only (role «مريض» from storage).
  await page.addInitScript(() => {
    localStorage.setItem("kinetic.user", JSON.stringify({ name: "مريض تجريبي", role: "مريض", email: "patient@demo.test" }));
  });
  await page.goto("/?demo=1");
  const trigger = page.getByRole("button", { name: "احجز زيارة" }).first();
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "احجز زيارة" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await focusDialog(page)).toBe("احجز زيارة");
  const seen = await tabAround(page, "Tab", 12, "احجز زيارة");
  expect(seen).toContain("إغلاق");
  await tabAround(page, "Shift+Tab", 12, "احجز زيارة");

  // Step 1 → 2 in one keypress on a reason (no «اختر سبب الزيارة» error).
  const reason = dialog.getByRole("button", { name: /مشكلة جديدة/ });
  await reason.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("من تود زيارته؟")).toBeVisible();
  await expect(page.getByText("اختر سبب الزيارة")).toHaveCount(0);
  expect(await focusDialog(page)).toBe("احجز زيارة");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("C06 row menu «المزيد»: opens on the first item, ↑/↓ move, Esc returns to the trigger; a dialog opened from it returns focus there too (task 3.10)", async ({ page }) => {
  await clinicLogin(page, "admin@demo-physio.test");
  await page.locator('aside.sidebar [data-route="settings"]').click();
  await page.locator('[data-settings-tab="users"]').click();
  const row = page.locator('tr[data-member="doctor@demo-physio.test"]');
  await expect(row).toBeVisible();
  const more = row.getByRole("button", { name: "المزيد" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "تعديل الدور والفروع" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "تعديل الاسم" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".row-menu-pop button").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".row-menu-pop")).toHaveCount(0);
  await expect(more).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "تعديل الدور والفروع" })).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("clinic shell: the first Tab stop is «تخطَّ إلى المحتوى», and it moves the focus to the page (task 3.10)", async ({ page }) => {
  await clinicLogin(page, "admin@demo-physio.test");
  await page.reload();
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "تخطَّ إلى المحتوى" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#clinic-main")).toBeFocused();
});
