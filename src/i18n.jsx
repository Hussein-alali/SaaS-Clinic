// ===== src/i18n.jsx =====
// Two interface languages: Arabic (default, RTL) and English (LTR)
// (docs/02-TRD.md "اللغات"; docs/04 "اللغتان"). The first script of the app.
//
// The page language is fixed for the page's lifetime. index.html picks it
// before anything renders (?lang=ar|en, else the cookie clinicsys_lang that
// the main site, admin. and every clinic subdomain share, else the saved
// choice localStorage "clinicsys.lang", else Arabic), sets <html lang dir> and, for
// English, loads the dictionary chunk (dist/lang-en.<hash>.js, built from
// src/lang/en-*.jsx) ahead of the app. Switching language saves the choice
// and reloads, so every label, date and number is rendered once, in one
// language, and constants evaluated at load time are translated too.
//
// The key of a translation is the Arabic source text itself:
//   tt("المرضى")                       → "Patients" in English, as is in Arabic
//   tt("المقاعد: {n} من {max}", {n, max})   placeholders {name}
//   ttx("أُرسلت دعوة إلى {email}", {email: <Ltr>{x}</Ltr>})   → React children
// Only text shown to people goes through tt(): values that are stored or
// compared (roles such as "مدير", statuses, filter values) stay as they are,
// and their label is translated where it is shown, e.g. tt(row.status).
// A string missing from the English dictionary falls back to Arabic and is
// recorded in window.I18N_MISSING (the browser tests read it).

const I18N_STORAGE_KEY = "clinicsys.lang";
const I18N_LANGS = ["ar", "en"];

const LANG = (function () {
  const fromBoot = typeof window !== "undefined" && window.CLINICSYS_LANG;
  if (I18N_LANGS.includes(fromBoot)) return fromBoot;
  try {
    const q = /[?&]lang=(ar|en)\b/.exec(window.location.search);
    if (q) return q[1];
    const c = /(?:^|;\s*)clinicsys_lang=(ar|en)\b/.exec(window.document ? window.document.cookie : "");
    if (c) return c[1];
    const saved = window.localStorage.getItem(I18N_STORAGE_KEY);
    if (I18N_LANGS.includes(saved)) return saved;
  } catch (_) {}
  return "ar";
})();
const IS_RTL = LANG === "ar";
// BCP 47 tags for Intl: Latin digits in both languages (docs/04 «الأرقام»).
const LANG_LOCALE = IS_RTL ? "ar-EG-u-nu-latn" : "en-GB";

// Dictionaries register themselves on window.I18N_EN (src/lang/en-*.jsx,
// keyed by the Arabic text: `npm run dev`). The build ships them as
// window.I18N_EN_H, keyed by __i18nHash(Arabic text) instead, which is
// much smaller (scripts/build.mjs; same hash in scripts/i18n-hash.mjs).
const I18N_DICT_H = LANG === "en" && typeof window !== "undefined" && window.I18N_EN_H ? window.I18N_EN_H : null;
const I18N_DICT = LANG === "en" && !I18N_DICT_H ? ((typeof window !== "undefined" && window.I18N_EN) || {}) : null;
if (typeof window !== "undefined") window.I18N_MISSING = window.I18N_MISSING || new Set();

// FNV-1a 32-bit over UTF-16 code units, base 36 (= scripts/i18n-hash.mjs).
function __i18nHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
const __i18nCache = new Map();

function __i18nLookup(ar) {
  if ((!I18N_DICT && !I18N_DICT_H) || typeof ar !== "string") return ar;
  let hit;
  if (I18N_DICT_H) {
    hit = __i18nCache.get(ar);
    if (hit === undefined) { hit = I18N_DICT_H[__i18nHash(ar)]; __i18nCache.set(ar, hit === undefined ? null : hit); }
  } else hit = I18N_DICT[ar];
  if (typeof hit === "string") return hit;
  if (ar.trim() && /[؀-ۿ]/.test(ar)) window.I18N_MISSING.add(ar);
  return ar;
}

function __i18nFill(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// Translate a text (see the header).
function tt(ar, vars) {
  if (ar === undefined || ar === null) return ar;
  return __i18nFill(__i18nLookup(String(ar)), vars);
}

// The same Arabic word can need two English words («ملغاة»: a cancelled
// appointment, a revoked invitation). ttc("invitation", "ملغاة") looks up
// the key "invitation|ملغاة" first, then "ملغاة"; Arabic shows "ملغاة".
function ttc(context, ar, vars) {
  if (ar === undefined || ar === null) return ar;
  const key = context + "|" + String(ar);
  const hit = __i18nLookup(key);
  if (hit !== key) return __i18nFill(hit, vars);
  if (window.I18N_MISSING) window.I18N_MISSING.delete(key);
  return tt(ar, vars);
}

// Translate a text whose placeholders are React nodes; returns an array of
// children (strings and the given nodes), keyed for React.
function ttx(ar, parts) {
  const s = __i18nLookup(String(ar));
  const out = [];
  let last = 0, i = 0;
  s.replace(/\{(\w+)\}/g, (m, k, at) => {
    if (at > last) out.push(s.slice(last, at));
    const v = parts && Object.prototype.hasOwnProperty.call(parts, k) ? parts[k] : m;
    out.push(React.isValidElement(v) ? React.cloneElement(v, { key: "ttx" + (i++) }) : v);
    last = at + m.length;
    return m;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// Save the choice and reload the page in that language (?lang= is dropped
// from the address so it does not override the choice later).
function setLang(lang) {
  if (!I18N_LANGS.includes(lang) || lang === LANG) return;
  try { window.localStorage.setItem(I18N_STORAGE_KEY, lang); } catch (_) {}
  // The cookie carries the choice to the other subdomains (index.html).
  try { if (window.clinicsysLangCookie) window.clinicsysLangCookie(lang); } catch (_) {}
  const url = new URL(window.location.href);
  url.searchParams.delete("lang");
  // Same address (only a #hash): replace() would just scroll, not reload.
  if (url.toString() === window.location.href) window.location.reload();
  else window.location.replace(url.toString());
}

// ── Formatting (one place for numbers, money and dates) ───────────
function fmtNumber(n, opts) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat(LANG_LOCALE, { maximumFractionDigits: 2, ...(opts || {}) }).format(v);
}

// Egyptian pounds: «1,250 ج.م» in Arabic, «EGP 1,250» in English (decision
// in docs/04: one formatter for the whole app).
function fmtMoney(n, opts) {
  const v = Number(n);
  const num = fmtNumber(Number.isFinite(v) ? v : 0, opts);
  return IS_RTL ? num + " ج.م" : "EGP " + num;
}

// Compact money for charts and tiles: «1.2K ج.م» / «EGP 1.2K».
function fmtMoneyShort(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 1000) return fmtMoney(Math.round(v));
  const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v / 1000) + "K";
  return IS_RTL ? num + " ج.م" : "EGP " + num;
}

const __I18N_DATE_STYLES = {
  date:      { day: "numeric", month: "long", year: "numeric" },     // 22 أكتوبر 2026 / 22 October 2026
  dateShort: { day: "2-digit", month: "2-digit", year: "numeric" },  // 22/10/2026
  dayMonth:  { day: "numeric", month: "short" },                     // 22 أكتوبر / 22 Oct
  month:     { month: "long", year: "numeric" },                     // أكتوبر 2026 / October 2026
  weekday:   { weekday: "long" },                                    // الخميس / Thursday
  weekdayDate: { weekday: "long", day: "numeric", month: "long" },
  time:      { hour: "2-digit", minute: "2-digit" },
  dateTime:  { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
};

// fmtDate(value, style = "date" | Intl options) → text, "—" when empty or
// invalid. A plain "YYYY-MM-DD" is read as a local date (no timezone shift).
function fmtDate(value, style) {
  if (value === undefined || value === null || value === "") return "—";
  let d = value instanceof Date ? value : null;
  if (!d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  }
  if (Number.isNaN(d.getTime())) return "—";
  const opts = typeof style === "object" && style ? style : (__I18N_DATE_STYLES[style || "date"] || __I18N_DATE_STYLES.date);
  return new Intl.DateTimeFormat(LANG_LOCALE, opts).format(d);
}

// Weekday names, Sunday first: weekdayNames("long" | "short" | "narrow").
function weekdayNames(width) {
  const f = new Intl.DateTimeFormat(LANG_LOCALE, { weekday: width || "long" });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2026, 0, 4 + i)));
}
// Month names, January first: monthNames("long" | "short").
function monthNames(width) {
  const f = new Intl.DateTimeFormat(LANG_LOCALE, { month: width || "long" });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(2026, i, 1)));
}

// ── Language switch ───────────────────────────────────────────────
// One button that names the OTHER language in that language («English» /
// «العربية»), with lang= so screen readers pronounce it right.
function LangSwitch({ className, style, compact }) {
  const other = IS_RTL ? "en" : "ar";
  const label = other === "en" ? "English" : "العربية";
  return (
    <button type="button" className={className || "btn btn-ghost btn-sm"} style={style}
      lang={other} dir={other === "ar" ? "rtl" : "ltr"} data-lang-switch={other}
      aria-label={other === "en" ? "Switch to English" : "التبديل إلى العربية"}
      onClick={() => setLang(other)}>
      {compact ? (other === "en" ? "EN" : "ع") : label}
    </button>
  );
}

Object.assign(window, {
  LANG, IS_RTL, LANG_LOCALE, tt, ttc, ttx, setLang, LangSwitch, __i18nHash,
  fmtNumber, fmtMoney, fmtMoneyShort, fmtDate, weekdayNames, monthNames,
});
