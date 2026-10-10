// Money in integer cents (a port of Money in Model.swift). A floating point number never touches an amount.
export type MoneyError = 'empty' | 'notANumber' | 'tooManyDecimals' | 'negative' | 'zero' | 'tooLarge';
export const MAX_CENTS = 100_000_000; // $1,000,000.00

export type ParseResult = { ok: true; cents: number } | { ok: false; error: MoneyError };

export function moneyMessage(e: MoneyError): string {
  switch (e) {
    case 'empty': return 'Enter an amount.';
    case 'notANumber': return 'That is not an amount. Try 12.50.';
    case 'tooManyDecimals': return 'Use at most 2 decimals, like 12.50.';
    case 'negative': return 'The amount cannot be negative. Pick the other type instead.';
    case 'zero': return 'The amount must be more than zero.';
    case 'tooLarge': return `That is too large. The most is ${formatMoney(MAX_CENTS, '$')}.`;
  }
}

/** Digits and separators from other scripts (full-width, Arabic-Indic, Persian) become plain ASCII ones first. */
function asciiDigits(t: string): string {
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c < 128) { out += ch; continue; }
    if (c === 0x066b || c === 0xff0e) out += '.';
    else if (c === 0x066c || c === 0xff0c) out += ',';
    else if (c === 0xff0d) out += '-';
    else if (/^\p{Nd}$/u.test(ch)) out += String(digitValue(c));
    else out += ch;
  }
  return out;
}
/** Value of a decimal digit of any script: Unicode decimal digits come in aligned runs of ten, zero first. */
function digitValue(c: number): number {
  let k = 0;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(c - k - 1))) k++;
  return k % 10;
}

import { trimWs as trimSpaces, trimWsNl as trimWs } from './ws';

/** "12.5", "12.50", "$12.50", "12.50 $", "1,234.50", ".5", "5." all work. Commas only as thousands separators. */
export function parseMoney(raw: string, symbol = '$'): ParseResult {
  let s = asciiDigits(trimWs(raw));
  const fail = (error: MoneyError): ParseResult => ({ ok: false, error });
  if (s === '') return fail('empty');
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) { negative = true; s = trimSpaces(s.slice(1)); }
  for (const sym of [symbol, '$']) {
    // a symbol with a digit, or made only of separators, would eat part of the amount ("1" turned "12.50" into 2.50)
    if (sym === '' || /\p{Nd}/u.test(sym) || !/[^.,\-−\s]/u.test(sym)) continue;
    if (s.startsWith(sym)) { s = trimSpaces(s.slice(sym.length)); break; }
    if (s.endsWith(sym)) { s = trimSpaces(s.slice(0, s.length - sym.length)); break; }
  }
  if (s.startsWith('-') || s.startsWith('−')) { negative = true; s = s.slice(1); }
  if (s === '') return fail('notANumber');
  const ps = s.split('.');
  if (ps.length > 2) return fail('notANumber');
  const whole = ps[0], frac = ps.length === 2 ? ps[1] : '';
  const ascii = (t: string) => /^[0-9]*$/.test(t);
  let wholeDigits = whole;
  if (whole.includes(',')) {
    const groups = whole.split(',');
    if (!(groups[0].length >= 1 && groups[0].length <= 3 && ascii(groups[0])) || !groups.slice(1).every((g) => g.length === 3 && ascii(g))) return fail('notANumber');
    wholeDigits = groups.join('');
  }
  if (wholeDigits === '' && frac === '') return fail('notANumber');
  if (!ascii(wholeDigits) || !ascii(frac)) return fail('notANumber');
  if (frac.length > 2) return fail('tooManyDecimals');
  const trimmedWhole = wholeDigits.replace(/^0+/, '');
  if (trimmedWhole.length > 10) return fail(negative ? 'negative' : 'tooLarge');
  const cents = (trimmedWhole === '' ? 0 : Number(trimmedWhole)) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (negative) return fail(cents === 0 ? 'zero' : 'negative');
  if (cents === 0) return fail('zero');
  if (cents > MAX_CENTS) return fail('tooLarge');
  return { ok: true, cents };
}

/** "$1,234.50", "-$5.00". `compact` drops ".00". `sign` adds "+" to positive values. */
export function formatMoney(cents: number, symbol: string, compact = false, sign = false): string {
  const mag = Math.abs(cents);
  const whole = String(Math.floor(mag / 100)), frac = mag % 100;
  let out = symbol + whole.replace(/\B(?=(\d{3})+$)/g, ',');
  if (!(compact && frac === 0)) out += '.' + String(frac).padStart(2, '0');
  if (cents < 0) return '-' + out;
  return (sign && cents > 0 ? '+' : '') + out;
}

/** Plain decimal for CSV and forms: "12.50", "-3.05". Never grouped: a comma would shift CSV columns and the edit form must read it back. */
export function plainMoney(cents: number): string {
  const mag = Math.abs(cents);
  return (cents < 0 ? '-' : '') + String(Math.floor(mag / 100)) + '.' + String(mag % 100).padStart(2, '0');
}

/** Integer division rounded half away from zero. Never divides by zero (returns 0). */
export function divRound(a: number, b: number): number {
  if (b <= 0) return 0;
  const q = Math.floor((2 * Math.abs(a) + b) / (2 * b));
  return a < 0 ? -q : q;
}
/** Math.round, but halves go away from zero (Swift's rounded()). */
export const roundHalfAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

export function cleanSymbol(s: string): string {
  const t = trimWs(s);
  return t === '' ? '$' : Array.from(t).slice(0, 3).join('');
}
