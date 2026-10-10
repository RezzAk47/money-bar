// Categories (a port of Categories in Model.swift), including the reserved "Debt payment".
export const EXPENSE_CATEGORIES = ['Food', 'Transport', 'Rent', 'School', 'Bills', 'Fun', 'Other', 'Debt payment'] as const;
/** Paying a credit card is not new spending: it is listed and totalled separately and never added to Spent, Net, averages or the category chart. */
export const DEBT_PAYMENT = 'Debt payment';
export const INCOME_SOURCES = ['Job', 'Other'];
export const TIP_METHODS = ['Cash', 'Card'];
export const MAX_CATEGORY_LENGTH = 30;
export const MAX_NOTE = 300;

import { splitWsNl, trimWsNl } from './ws';
export const strip = trimWsNl;

// Full case folding of a single code point, as Foundation does it (measured against Model.swift, tests/unicode-parity.test.ts).
// Lower-case letters whose upper case is one different letter fold to something else only in these few cases (Unicode
// CaseFolding "C" entries); letters whose upper case is several letters (ß, ﬁ, ŉ ...) fold to those letters in lower case.
const FOLD_LOWER: Record<string, string> = { 'ς': 'σ', 'ſ': 's', 'µ': 'μ', 'ẛ': 'ṡ', 'ι': 'ι', 'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε' };
function foldChar(ch: string): string {
  if (ch === 'ẞ' || ch === 'ß') return 'ss';
  const lower = ch.toLowerCase();
  if (lower !== ch) return lower === 'ß' ? 'ss' : lower;
  const f = FOLD_LOWER[ch];
  if (f !== undefined) return f;
  const upper = ch.toUpperCase();
  return upper.length > 1 && upper !== ch ? upper.toLowerCase() : ch;
}
/** Characters Foundation's diacritic-insensitive folding drops: nonspacing and enclosing marks (spacing marks stay), ZWNJ, the half-width voiced marks, emoji skin tones, tag characters. */
const DROPPED = /^[\p{Mn}\p{Me}\uFF9E\uFF9F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
/**
 * A ZWNJ (U+200C) is dropped by Foundation's folding only after a Latin, Greek or Cyrillic letter, digit or punctuation (the
 * folded character before it is in these ranges); after Arabic, CJK and others, where it matters (Persian), it is kept.
 * Measured by scanning every preceding character (tests/unicode-parity.test.ts).
 */
const ZWNJ_DROPPED_AFTER = (cp: number): boolean =>
  (cp >= 0x01 && cp <= 0x08) || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x21 && cp <= 0x84) || (cp >= 0x86 && cp <= 0x9f) || (cp >= 0xa1 && cp <= 0x52f) ||
  (cp >= 0x1e00 && cp <= 0x1fff) || (cp >= 0x2c60 && cp <= 0x2c7f);
/**
 * Foundation's `folding(options: [.caseInsensitive, .diacriticInsensitive])`: combining marks removed after canonical
 * decomposition (Hangul syllables are not decomposed), then full case folding (ß and ẞ become "ss", ς becomes σ, ſ becomes s,
 * ligatures such as ﬁ become "fi", ǅ becomes ǆ). `width` also folds full-width and half-width forms (.widthInsensitive).
 */
export function foldText(s: string, width = false): string {
  let out = '';
  for (const ch of s) {
    let c = ch;
    if (width) {
      const cp = c.codePointAt(0)!;
      if (cp >= 0xff01 && cp <= 0xff5e) c = String.fromCodePoint(cp - 0xfee0);
      else if (cp === 0x3000) c = ' ';
      else if ((cp >= 0xff61 && cp <= 0xff9f) || (cp >= 0xffe0 && cp <= 0xffee)) c = c.normalize('NFKC');
    }
    const cp = c.codePointAt(0)!;
    const parts = cp >= 0xac00 && cp <= 0xd7a3 ? [c] : Array.from(c.normalize('NFD'));
    for (const p of parts) {
      if (p === '\u200C') { const last = Array.from(out).pop(); if (last !== undefined && ZWNJ_DROPPED_AFTER(last.codePointAt(0)!)) continue; out += p; continue; }
      if (!DROPPED.test(p)) out += foldChar(p);
    }
  }
  return out;
}

/** Letters only, lower case, without accents, width or spacing: "Debt-payment", "DEBT_PAYMENT", full-width text all become "debtpayment". */
export function letterFold(s: string): string {
  let ascii = true, out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128) { ascii = false; break; }
    if (c >= 65 && c <= 90) out += String.fromCharCode(c + 32);
    else if (c >= 97 && c <= 122) out += s[i];
  }
  if (ascii) return out;
  // CharacterSet.letters is the L and M categories
  return Array.from(foldText(s, true)).filter((ch) => /^[\p{L}\p{M}]$/u.test(ch)).join('');
}
/** True for every spelling of the reserved "Debt payment" category (also "Debt payments"). */
export function isDebtName(s: string): boolean { const k = letterFold(s); return k === 'debtpayment' || k === 'debtpayments'; }

/** Trimmed, whitespace collapsed, canonical unicode form. Empty becomes "Other". */
export function normalize(s: string): string {
  const t = splitWsNl(s).filter((p) => p !== '').join(' ').normalize('NFC');
  return t === '' ? 'Other' : t;
}
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');
/** The one spelling rule for a stored category: normalized and cut to 30 characters. */
export const clip = (raw: string): string => cut(normalize(raw), MAX_CATEGORY_LENGTH);
/** Case and accent folding: "Cafe", "Café", "CAFÉ" are one category. */
export const foldKey = (normalized: string): string => foldText(normalized);
export const groupKey = (raw: string): string => foldKey(clip(raw));
/** The one display name for several spellings of a category: the smallest, so it never flickers. */
export const displayName = (a: string | undefined, b: string): string => (a === undefined ? b : a < b ? a : b);
// Foundation's compare(options:) (used by sameName) also case-folds the nine Cyrillic small letters U+1C80..U+1C88 that its
// folding(options:) (used by foldKey) leaves alone; this is the only difference found in 4,500 random pairs.
const CYRILLIC_VARIANTS: Record<string, string> = { '\u1C80': 'в', '\u1C81': 'д', '\u1C82': 'о', '\u1C83': 'с', '\u1C84': 'т', '\u1C85': 'т', '\u1C86': 'ъ', '\u1C87': 'ѣ', '\u1C88': 'ꙋ' };
const compareKey = (s: string): string => foldKey(normalize(s)).replace(/[\u1C80-\u1C88]/g, (c) => CYRILLIC_VARIANTS[c]);
export const sameName = (a: string, b: string): boolean => compareKey(a) === compareKey(b);

export type Kind = 'expense' | 'income' | 'tip';

/** What is stored for a category: a tip method may be empty, every spelling of the debt name maps to the reserved name. */
export function cleanCategory(kind: Kind, raw: string): string {
  if (kind === 'tip') {
    const t = strip(raw);
    return t === '' ? '' : cut(normalize(t), MAX_CATEGORY_LENGTH);
  }
  if (isDebtName(raw)) return DEBT_PAYMENT;
  return cut(normalize(raw), MAX_CATEGORY_LENGTH);
}
