// Recurring entry rules (a port of RecurringRule and Recurring in Model.swift): monthly with month-end clamp, weekly,
// every N days; stable entry ids from rule + date so two launches or two apps never add the same entry twice.
import * as Civil from './civil';
import { MAX_CENTS, moneyMessage } from './money';
import { MAX_NOTE, cleanCategory, strip } from './categories';
import type { Kind } from './categories';
import type { Entry } from './model';

export type RepeatKind = 'monthly' | 'weekly' | 'days';
export const REPEAT_KINDS: RepeatKind[] = ['monthly', 'weekly', 'days'];
export const REPEAT_LABEL: Record<RepeatKind, string> = { monthly: 'Every month', weekly: 'Every week', days: 'Every N days' };
export const MAX_INTERVAL = 365;
/** How far back a rule may start, and how far back it ever creates entries: older occurrences are skipped, never added. */
export const MAX_BACKFILL_DAYS = 400;
export const MAX_RULES = 100;
/** At most this many catch-up entries per rule per check; the rest follow on the next ticks (2 seconds apart). */
export const CATCH_UP_CAP = 12;

export interface RecurringRule {
  id: string;
  kind: Kind;
  cents: number;
  category: string;
  note: string;
  repeatKind: RepeatKind;
  /** Used by "every N days" only (1 otherwise). */
  interval: number;
  /** "yyyy-MM-dd": the first occurrence. A monthly rule keeps this day of the month (clamped in shorter months). */
  start: string;
  end?: string;
  paused: boolean;
  /** The latest occurrence already handled. Nothing on or before it is ever added again, even if the entry was deleted. */
  last?: string;
}

/** nil when fine, otherwise the message for the form. `today` also rejects a start date more than 400 days in the past. */
export function validateRule(r: Pick<RecurringRule, 'cents' | 'start' | 'end' | 'interval' | 'repeatKind' | 'note'>, today?: string, tz?: string): string | null {
  if (!(r.cents > 0)) return moneyMessage('zero');
  if (r.cents > MAX_CENTS) return moneyMessage('tooLarge');
  if (Array.from(r.note).length > MAX_NOTE) return `The note is too long (${MAX_NOTE} characters at most).`;
  if (!Civil.isValidLocalDay(r.start, tz)) return 'The start date is not valid.';
  if (today !== undefined) {
    const t = Civil.days(today), s = Civil.days(r.start);
    if (t !== null && s !== null && t - s > MAX_BACKFILL_DAYS) return `The start date is more than ${MAX_BACKFILL_DAYS} days ago (the limit). Check the year.`;
  }
  if (r.end !== undefined) {
    if (Civil.parts(r.end) === null) return 'The end date is not valid.';
    if (r.end < r.start) return 'The end date is before the start date.';
  }
  if (r.repeatKind === 'days' && !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= MAX_INTERVAL)) return `Repeat every 1 to ${MAX_INTERVAL} days.`;
  return null;
}

const step = (r: RecurringRule) => (r.repeatKind === 'weekly' ? 7 : Math.max(1, r.interval));

function occurrence(r: RecurringRule, k: number, s: Civil.Parts, s0: number): string | null {
  if (r.repeatKind === 'monthly') {
    const idx = s.y * 12 + s.m - 1 + k;
    const y = Math.floor(idx / 12), m = idx % 12 + 1;
    if (y > 9999) return null;
    return Civil.keyOf(y, m, Math.min(s.d, Civil.daysInMonth(y, m)));
  }
  const d = s0 + k * step(r);
  return d > Civil.MAX_DAY ? null : Civil.keyOfDays(d);
}

/** Occurrence days after `after` (exclusive) up to `through` (inclusive) and the end date, oldest first, at most `limit`. */
export function occurrences(r: RecurringRule, after: string | undefined, through: string, limit: number): string[] {
  const s = Civil.parts(r.start);
  if (limit <= 0 || !s) return [];
  const s0 = Civil.daysOfParts(s);
  const stop = r.end !== undefined && r.end < through ? r.end : through;
  let k = 0;
  const ap = after !== undefined ? Civil.parts(after) : null;
  if (after !== undefined && ap) {
    if (r.repeatKind === 'monthly') k = Math.max(0, ap.y * 12 + ap.m - 1 - (s.y * 12 + s.m - 1) - 1);
    else { const ad = Civil.daysOfParts(ap); if (ad >= s0) k = Math.floor((ad - s0) / step(r)); }
  }
  const out: string[] = [];
  for (;;) {
    if (out.length >= limit) break;
    const key = occurrence(r, k, s, s0);
    if (key === null || key > stop) break;
    if (after === undefined || key > after) out.push(key);
    k++;
  }
  return out;
}

/** The latest occurrence on or before `day` (the end date counts), without walking every one of them. */
export function latest(r: RecurringRule, day: string): string | null {
  const s = Civil.parts(r.start);
  if (!s) return null;
  const s0 = Civil.daysOfParts(s);
  const stop = r.end !== undefined && r.end < day ? r.end : day;
  const sp = Civil.parts(stop);
  if (stop < r.start || !sp) return null;
  let k = r.repeatKind === 'monthly' ? sp.y * 12 + sp.m - 1 - (s.y * 12 + s.m - 1) + 1 : Math.floor((Civil.daysOfParts(sp) - s0) / step(r)) + 1;
  while (k >= 0) { const key = occurrence(r, k, s, s0); if (key !== null && key <= stop) return key; k--; }
  return null;
}

/** `last`, moved forward past every occurrence older than 400 days: those are skipped for good, never added. */
export function effectiveLast(r: RecurringRule, today: string): string | undefined {
  const t = Civil.days(today);
  const skip = t === null ? null : latest(r, Civil.keyOfDays(t - MAX_BACKFILL_DAYS - 1));
  if (skip === null) return r.last;
  return skip > (r.last ?? '') ? skip : r.last;
}

/** The next occurrence after the last handled one, or undefined when the rule has ended. */
export const nextDue = (r: RecurringRule): string | undefined => occurrences(r, r.last, '9999-12-31', 1)[0];

const hex = (id: string) => id.replace(/-/g, '');
/** The same id for the same rule and day, always (same 128-bit FNV-1a mix as the Mac app, so both apps make the same ids). */
export function entryId(r: RecurringRule, day: string): string {
  const src: number[] = [];
  const h = hex(r.id);
  for (let i = 0; i < 16; i++) src.push(parseInt(h.slice(i * 2, i * 2 + 2), 16));
  for (const b of new TextEncoder().encode(day)) src.push(b);
  const M = (1n << 64n) - 1n;
  const bytes = new Array<number>(16).fill(0);
  for (let half = 0; half < 2; half++) {
    let x = half === 0 ? 0xcbf29ce484222325n : 0x84222325cbf29ce4n;
    for (const b of src) x = ((x ^ BigInt(b)) * 0x100000001b3n) & M;
    x ^= x >> 29n;
    for (let i = 0; i < 8; i++) bytes[half * 8 + i] = Number((x >> BigInt(8 * i)) & 0xffn);
  }
  const s = bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function repeatText(r: RecurringRule): string {
  switch (r.repeatKind) {
    case 'monthly': return 'every month';
    case 'weekly': return 'every week';
    case 'days': return r.interval === 1 ? 'every day' : `every ${r.interval} days`;
  }
}

/** True when a running rule has an occurrence on or before `today` that is not yet handled. Cheap: no entries are touched. */
export function due(rules: RecurringRule[], today: string): boolean {
  return rules.some((r) => !r.paused && occurrences(r, effectiveLast(r, today), today, 1).length > 0);
}

/**
 * Adds the missed occurrences (oldest first, up to `cap` per rule) and moves each rule's `last` forward. An occurrence whose
 * id is already present is skipped, so running this twice, or in two copies, adds nothing twice.
 */
export function applyRules(rules: RecurringRule[], entries: Entry[], today: string, createdSeconds: number, cap = CATCH_UP_CAP, tz?: string): number {
  let existing: Set<string> | null = null, added = 0;
  for (const r of rules) {
    if (r.paused) continue;
    const from = effectiveLast(r, today);
    if (from !== r.last) r.last = from;
    const ds = occurrences(r, from, today, cap);
    if (ds.length === 0) continue;
    if (existing === null) existing = new Set(entries.map((e) => e.id));
    for (const d of ds) {
      const id = entryId(r, d);
      if (Civil.isValidLocalDay(d, tz) && !existing.has(id)) {
        existing.add(id);
        entries.push({ id, kind: r.kind, cents: r.cents, category: r.category, note: r.note, day: d, created: createdSeconds, sample: false, recurringID: r.id });
        added++;
      }
      r.last = d;
    }
  }
  return added;
}

/** Trim, clean the category, fix interval and empty end (what addRule/updateRule do before validating). */
export function cleanRule(rule: RecurringRule): RecurringRule {
  const r = { ...rule };
  r.note = strip(r.note);
  r.category = cleanCategory(r.kind, r.category);
  if (r.repeatKind !== 'days') r.interval = 1;
  if (r.end === '') delete r.end;
  return r;
}
