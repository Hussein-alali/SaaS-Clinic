// Unit tests for src/i18n.jsx: the two interface languages (Arabic default,
// English), placeholders, missing keys and the shared number/money/date
// formatters. The file is compiled like scripts/build.mjs does and run in a
// node:vm context with a fake window, once per language.
//
//   npm test        (node --test test/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { i18nHash } from "../scripts/i18n-hash.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const I18N_JS = transformSync(fs.readFileSync(path.join(ROOT, "src/i18n.jsx"), "utf8"), {
  loader: "jsx", target: "es2017", sourcefile: "src/i18n.jsx",
}).code;

// A tiny React stand-in: enough for ttx() and LangSwitch.
const FakeReact = {
  createElement: (type, props, ...children) => ({ $el: true, type, props: { ...(props || {}), children } }),
  isValidElement: (v) => !!(v && v.$el),
  cloneElement: (el, extra) => ({ ...el, props: { ...el.props, ...extra } }),
};

function load({ lang, search = "", saved = null, dict = {}, hashed = null, cookie = "" } = {}) {
  const store = new Map(saved ? [["clinicsys.lang", saved]] : []);
  const window = {
    CLINICSYS_LANG: lang,
    I18N_EN: dict,
    I18N_EN_H: hashed,
    document: { cookie },
    location: { search, href: "http://demo.localhost/" + search },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  };
  const ctx = vm.createContext({ window, React: FakeReact, Intl, Date, URL, Set, Object, Number, String, Math, Array });
  vm.runInContext(I18N_JS, ctx);
  return window;
}

test("Arabic is the default and returns the source text", () => {
  const w = load();
  assert.equal(w.LANG, "ar");
  assert.equal(w.IS_RTL, true);
  assert.equal(w.tt("المرضى"), "المرضى");
  assert.equal(w.tt("المقاعد: {n} من {max}", { n: 3, max: 10 }), "المقاعد: 3 من 10");
  assert.equal(w.I18N_MISSING.size, 0);
});

test("the language comes from the boot script, else ?lang=, else the saved choice", () => {
  assert.equal(load({ lang: "en" }).LANG, "en");
  assert.equal(load({ search: "?lang=en" }).LANG, "en");
  assert.equal(load({ saved: "en" }).LANG, "en");
  assert.equal(load({ saved: "fr" }).LANG, "ar");
  assert.equal(load({ lang: "en", search: "?lang=ar" }).LANG, "en", "the boot script decided already");
  assert.equal(load({ cookie: "a=1; clinicsys_lang=en" }).LANG, "en", "the cookie shared by the subdomains");
  assert.equal(load({ cookie: "clinicsys_lang=en", saved: "ar" }).LANG, "en", "the cookie wins over this address's saved choice");
  assert.equal(load({ cookie: "clinicsys_lang=en", search: "?lang=ar" }).LANG, "ar", "?lang= wins over the cookie");
});

test("English: dictionary lookup, placeholders, fallback to Arabic recorded as missing", () => {
  const w = load({ lang: "en", dict: { "المرضى": "Patients", "المقاعد: {n} من {max}": "Seats: {n} of {max}" } });
  assert.equal(w.IS_RTL, false);
  assert.equal(w.tt("المرضى"), "Patients");
  assert.equal(w.tt("المقاعد: {n} من {max}", { n: 3, max: 10 }), "Seats: 3 of 10");
  assert.equal(w.tt("المقاعد: {n} من {max}", { n: 3 }), "Seats: 3 of {max}", "an unknown placeholder stays visible");
  assert.equal(w.tt("نص غير مترجم"), "نص غير مترجم");
  assert.deepEqual([...w.I18N_MISSING], ["نص غير مترجم"]);
  assert.equal(w.tt("EGP"), "EGP", "non-Arabic text is never reported");
  assert.equal(w.I18N_MISSING.size, 1);
  assert.equal(w.tt(undefined), undefined);
  assert.equal(w.tt(null), null);
});

test("ttx() places React nodes in the translated sentence", () => {
  const w = load({ lang: "en", dict: { "أُرسلت دعوة إلى {email} بدور {role}": "Invitation sent to {email} as {role}" } });
  const email = FakeReact.createElement("bdi", { dir: "ltr" }, "a@b.test");
  const out = w.ttx("أُرسلت دعوة إلى {email} بدور {role}", { email, role: "Doctor" });
  assert.equal(out.length, 4);
  assert.equal(out[0], "Invitation sent to ");
  assert.equal(out[1].type, "bdi");
  assert.equal(out[1].props.key, "ttx0");
  assert.equal(out[2], " as ");
  assert.equal(out[3], "Doctor");
});

test("money: «1,250 ج.م» in Arabic, «EGP 1,250» in English, Latin digits in both", () => {
  const ar = load(), en = load({ lang: "en" });
  assert.equal(ar.fmtMoney(1250), "1,250 ج.م");
  assert.equal(en.fmtMoney(1250), "EGP 1,250");
  assert.equal(en.fmtMoney(416.667), "EGP 416.67");
  assert.equal(en.fmtMoney("x"), "EGP 0");
  assert.equal(ar.fmtMoneyShort(1250), "1.3K ج.م");
  assert.equal(en.fmtMoneyShort(200), "EGP 200");
  assert.equal(ar.fmtNumber(1234567), "1,234,567");
  assert.equal(ar.fmtNumber(NaN), "—");
});

test("dates: Arabic and English month names, Latin digits, no timezone shift for YYYY-MM-DD", () => {
  const ar = load(), en = load({ lang: "en" });
  assert.equal(ar.fmtDate("2026-10-22"), "22 أكتوبر 2026");
  assert.equal(en.fmtDate("2026-10-22"), "22 October 2026");
  assert.equal(en.fmtDate("2026-10-22", "dateShort"), "22/10/2026");
  assert.equal(en.fmtDate("", "date"), "—");
  assert.equal(en.fmtDate("not a date"), "—");
  assert.equal(en.weekdayNames("long")[0], "Sunday");
  assert.equal(ar.weekdayNames("long")[0], "الأحد");
  assert.equal(en.monthNames("long")[9], "October");
  assert.ok(!/[٠-٩]/.test(ar.fmtDate("2026-10-22", "dateTime")), "no Arabic-Indic digits");
});

test("the shipped chunk is keyed by a hash of the Arabic text; src/i18n.jsx and the build agree", () => {
  const w = load({ lang: "en" });
  for (const s of ["المرضى", "المقاعد: {n} من {max}", "x", "", "تخطَّ إلى المحتوى"]) assert.equal(w.__i18nHash(s), i18nHash(s), s);
  const hashed = { [i18nHash("المرضى")]: "Patients", [i18nHash("المقاعد: {n} من {max}")]: "Seats: {n} of {max}" };
  const h = load({ lang: "en", hashed, dict: { "المرضى": "ignored when the hashed chunk is there" } });
  assert.equal(h.tt("المرضى"), "Patients");
  assert.equal(h.tt("المرضى"), "Patients", "cached lookup");
  assert.equal(h.tt("المقاعد: {n} من {max}", { n: 1, max: 2 }), "Seats: 1 of 2");
  assert.equal(h.tt("غير موجود"), "غير موجود");
  assert.deepEqual([...h.I18N_MISSING], ["غير موجود"]);
  assert.equal(load({ hashed }).tt("المرضى"), "المرضى", "Arabic ignores the dictionary");
});
