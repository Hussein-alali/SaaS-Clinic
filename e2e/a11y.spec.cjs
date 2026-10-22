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
