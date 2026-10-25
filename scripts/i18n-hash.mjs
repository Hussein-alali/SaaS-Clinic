// The key hash of the English dictionary chunk (scripts/build.mjs): FNV-1a
// 32-bit over the UTF-16 code units of the Arabic source text, in base 36.
// src/i18n.jsx has the same function (__i18nHash); test/i18n.test.mjs
// checks that the two agree.
export function i18nHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
