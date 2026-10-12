// Periods, reports, chart buckets, budgets and the month at a glance (ports of DayRange, Period, Reports, Budgets and Glance
// in Model.swift). All on civil "yyyy-MM-dd" days, so DST and zones with no midnight on some day cannot lose or double a day.
import * as Civil from './civil';
import { divRound, roundHalfAway } from './money';
import { DEBT_PAYMENT, clip, displayName, foldKey, groupKey, isDebtName } from './categories';
import { isDebtPayment, recentFirst } from './model';
import type { Entry } from './model';

// ---- ranges and periods

export const MAX_RANGE_DAYS = 3660;
export interface DayRange { start: string; end: string }

/** Start before end (swapped if not), at most 3660 days. */
export function makeRange(a: string, b: string): DayRange {
  let s = a, e = b;
  if (e < s) [s, e] = [e, s];
  if (s < MIN_KEY) s = MIN_KEY;
  if (e > MAX_KEY) e = MAX_KEY;
  if (e < s) e = s;
  const sd = Civil.days(s)!;
  if (Civil.days(e)! > sd + MAX_RANGE_DAYS - 1) e = Civil.keyOfDays(sd + MAX_RANGE_DAYS - 1);
  return { start: s, end: e };
}
export const MIN_KEY = '0001-01-01', MAX_KEY = '9999-12-31';
/** A day key shifted by whole days, or null when it would leave the years 1 to 9999. */
const shiftKey = (key: string, n: number): string | null => { const d = (Civil.days(key) ?? 0) + n; return d < Civil.days(MIN_KEY)! || d > Civil.days(MAX_KEY)! ? null : Civil.keyOfDays(d); };
export const dayCount = (r: DayRange): number => (Civil.days(r.end) ?? 0) - (Civil.days(r.start) ?? 0) + 1;
export function dayKeys(r: DayRange): string[] {
  const s = Civil.days(r.start) ?? 0, n = dayCount(r);
  return Array.from({ length: n }, (_, i) => Civil.keyOfDays(s + i));
}
export const rangeContains = (r: DayRange, key: string): boolean => key >= r.start && key <= r.end;

export type Period = { kind: 'day' } | { kind: 'week' } | { kind: 'month' } | { kind: 'custom'; range: DayRange };

/** The range holding `anchor` (a day key). weekStart: 1 = Sunday ... 7 = Saturday. */
export function rangeContaining(p: Period, anchor: string, weekStart: number): DayRange {
  switch (p.kind) {
    case 'day': return makeRange(anchor, anchor);
    case 'week': {
      const back = (((Civil.weekday(anchor) - weekStart) % 7) + 7) % 7;
      const s = Civil.addDays(anchor, -back);
      return makeRange(s, Civil.addDays(s, 6));
    }
    case 'month': {
      const pt = Civil.parts(anchor)!;
      const s = Civil.keyOf(pt.y, pt.m, 1);
      const next = Civil.addMonthsFirst(s, 1);
      return makeRange(s, next === null ? MAX_KEY : Civil.addDays(next, -1));
    }
    case 'custom': return p.range;
  }
}
/** The range `steps` periods away (negative = earlier). A custom range moves by its own length. */
export function shifted(p: Period, r: DayRange, steps: number, weekStart: number): DayRange {
  switch (p.kind) {
    case 'day': return rangeContaining(p, Civil.addDays(r.start, steps), weekStart);
    case 'week': return rangeContaining(p, Civil.addDays(r.start, 7 * steps), weekStart);
    case 'month': return rangeContaining(p, Civil.addMonthsFirst(r.start, steps) ?? r.start, weekStart);
    case 'custom': { const n = dayCount(r); return makeRange(Civil.addDays(r.start, n * steps), Civil.addDays(r.end, n * steps)); }
  }
}

// ---- totals

export interface Quad { spent: number; earned: number; tips: number; debtPaid: number }
export const net = (q: Quad): number => q.earned + q.tips - q.spent;
export const made = (q: Quad): number => q.earned + q.tips;
export interface DayTotals { day: string; totals: Quad; count: number }
export const isActive = (d: DayTotals): boolean => d.totals.spent !== 0 || d.totals.earned !== 0 || d.totals.tips !== 0;
export interface CategoryTotal { name: string; cents: number; count: number; percent: number }
export interface Trend { spent: number | null; earned: number | null; tips: number | null; net: number | null }

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return roundHalfAway(((current - previous) / Math.abs(previous)) * 100);
}
export function quad(entries: Iterable<Entry>): Quad {
  const q: Quad = { spent: 0, earned: 0, tips: 0, debtPaid: 0 };
  for (const e of entries) {
    if (e.kind === 'expense') { if (isDebtPayment(e)) q.debtPaid += e.cents; else q.spent += e.cents; }
    else if (e.kind === 'income') q.earned += e.cents;
    else q.tips += e.cents;
  }
  return q;
}
export const entriesIn = (all: Entry[], r: DayRange): Entry[] => all.filter((e) => e.day >= r.start && e.day <= r.end);
const averages = (q: Quad, days: number): Quad => ({ spent: divRound(q.spent, days), earned: divRound(q.earned, days), tips: divRound(q.tips, days), debtPaid: 0 });

/** Fits a category list into `slots` rows: the smallest are merged into one "Other categories (N)" row, so rows add up to the full spend. */
const OTHER_PREFIX = 'Other categories (';
/** A report row that can get a budget: a real spending category, not the grouped "Other categories (N)" row or card payments. */
export function budgetable(name: string): boolean {
  return !name.startsWith(OTHER_PREFIX) && !isDebtName(name);
}

export function groupedCategories(cats: CategoryTotal[], slots: number): CategoryTotal[] {
  const n = Math.max(2, slots);
  if (cats.length <= n) return cats;
  const rest = cats.slice(n - 1);
  const other: CategoryTotal = { name: `${OTHER_PREFIX}${rest.length})`, cents: rest.reduce((a, c) => a + c.cents, 0), count: rest.reduce((a, c) => a + c.count, 0), percent: rest.reduce((a, c) => a + c.percent, 0) };
  return [...cats.slice(0, n - 1), other];
}

export interface Report {
  range: DayRange;
  dayCount: number;
  activeDays: number;
  entryCount: number;
  totals: Quad;
  avgAllDays: Quad;
  avgActiveDays: Quad;
  avgNetAllDays: number;
  avgNetActiveDays: number;
  daily: DayTotals[];
  bestDay?: DayTotals;
  worstDay?: DayTotals;
  tipDays: number;
  avgTipPerTipDay: number;
  categories: CategoryTotal[];
  previousRange: DayRange;
  previous: Quad;
  trend: Trend;
  /** The entries in the period, newest first. */
  entries: Entry[];
}

export function makeReport(all: Entry[], range: DayRange, previousRange: DayRange): Report {
  const inRange = entriesIn(all, range).sort(recentFirst);
  const byDay = new Map<string, Entry[]>();
  for (const e of inRange) { const l = byDay.get(e.day); if (l) l.push(e); else byDay.set(e.day, [e]); }
  const daily: DayTotals[] = dayKeys(range).map((k) => ({ day: k, totals: quad(byDay.get(k) ?? []), count: byDay.get(k)?.length ?? 0 }));
  const total = quad(inRange);
  const days = daily.length;
  const active = daily.filter(isActive);
  const tipDayCount = daily.filter((d) => d.totals.tips > 0).length;
  // Best and worst by net; ties go to the earliest day.
  let best: DayTotals | undefined, worst: DayTotals | undefined;
  for (const d of active) {
    if (!best || net(d.totals) > net(best.totals)) best = d;
    if (!worst || net(d.totals) < net(worst.totals)) worst = d;
  }
  const cat = new Map<string, { cents: number; count: number }>(), display = new Map<string, string>();
  const names = new Map<string, { name: string; key: string }>();
  for (const e of inRange) {
    if (e.kind !== 'expense' || isDebtPayment(e)) continue;
    let nk = names.get(e.category);
    if (!nk) { const n = clip(e.category); nk = { name: n, key: foldKey(n) }; names.set(e.category, nk); }
    display.set(nk.key, displayName(display.get(nk.key), nk.name));
    const old = cat.get(nk.key) ?? { cents: 0, count: 0 };
    cat.set(nk.key, { cents: old.cents + e.cents, count: old.count + 1 });
  }
  const categories: CategoryTotal[] = [...cat].map(([key, v]) => ({ name: display.get(key) ?? key, cents: v.cents, count: v.count, percent: total.spent > 0 ? (v.cents / total.spent) * 100 : 0 }))
    .sort((a, b) => (a.cents !== b.cents ? b.cents - a.cents : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const prev = quad(entriesIn(all, previousRange));
  const trend: Trend = { spent: percentChange(total.spent, prev.spent), earned: percentChange(total.earned, prev.earned), tips: percentChange(total.tips, prev.tips), net: percentChange(net(total), net(prev)) };
  return {
    range, dayCount: days, activeDays: active.length, entryCount: inRange.length, totals: total,
    avgAllDays: averages(total, days), avgActiveDays: averages(total, active.length),
    avgNetAllDays: divRound(net(total), days), avgNetActiveDays: divRound(net(total), active.length),
    daily, bestDay: best, worstDay: worst, tipDays: tipDayCount, avgTipPerTipDay: divRound(total.tips, tipDayCount),
    categories, previousRange, previous: prev, trend, entries: inRange,
  };
}
export function reportFor(all: Entry[], p: Period, anchor: string, weekStart: number): Report {
  const range = rangeContaining(p, anchor, weekStart);
  return makeReport(all, range, shifted(p, range, -1, weekStart));
}

// ---- chart buckets: a long range is grouped so the bar chart stays readable
export interface Bucket { start: string; days: number; spent: number; made: number }
export function buckets(daily: DayTotals[], maxBars = 62): Bucket[] {
  if (daily.length === 0 || maxBars <= 0) return [];
  const size = Math.ceil(daily.length / maxBars), out: Bucket[] = [];
  for (let i = 0; i < daily.length; i += size) {
    const chunk = daily.slice(i, i + size);
    out.push({ start: chunk[0].day, days: chunk.length, spent: chunk.reduce((a, d) => a + d.totals.spent, 0), made: chunk.reduce((a, d) => a + made(d.totals), 0) });
  }
  return out;
}

// ---- budgets
export type BudgetLevel = 'ok' | 'near' | 'atLimit' | 'over';
export interface BudgetStatus { name: string; id: string; limit: number; spent: number }
export const budgetRemaining = (b: BudgetStatus): number => b.limit - b.spent;
export const budgetFraction = (b: BudgetStatus): number => b.spent / b.limit;
export const budgetPercent = (b: BudgetStatus): number => Math.floor((b.spent * 100) / b.limit);
export function budgetLevel(b: BudgetStatus): BudgetLevel {
  if (b.spent > b.limit) return 'over';
  if (b.spent === b.limit) return 'atLimit';
  return b.spent * 5 >= b.limit * 4 ? 'near' : 'ok';
}
/** 100 at or past the limit, 80 from 80 percent, else 0: what the optional notifications go by. */
export const alertLevel = (b: BudgetStatus): number => (b.spent >= b.limit ? 100 : b.spent * 5 >= b.limit * 4 ? 80 : 0);
/** Calm wording: "$12.40 over", "$7.60 left", "Budget used up". */
export function budgetMessage(b: BudgetStatus, fmt: (c: number) => string): string {
  switch (budgetLevel(b)) {
    case 'over': return fmt(-budgetRemaining(b)) + ' over';
    case 'atLimit': return 'Budget used up';
    default: return fmt(budgetRemaining(b)) + ' left';
  }
}
/** Spending against each budget for the days of `month`. Only expenses count; Debt payment never does. Worst first, then by name. */
export function budgetStatuses(entries: Entry[], budgets: Record<string, number>, month: DayRange): BudgetStatus[] {
  if (Object.keys(budgets).length === 0) return [];
  const limits = new Map<string, { name: string; cents: number }>();
  for (const [name, cents] of Object.entries(budgets)) if (!isDebtName(name)) limits.set(groupKey(name), { name, cents });
  const spent = new Map<string, number>(), names = new Map<string, string>(), folds = new Map<string, { name: string; key: string }>();
  for (const e of entries) {
    if (e.kind !== 'expense' || e.day < month.start || e.day > month.end) continue;
    let f = folds.get(e.category);
    if (!f) { const n = clip(e.category); f = { name: n, key: foldKey(n) }; folds.set(e.category, f); }
    if (limits.has(f.key) && !isDebtPayment(e)) { spent.set(f.key, (spent.get(f.key) ?? 0) + e.cents); names.set(f.key, displayName(names.get(f.key), f.name)); }
  }
  return [...limits].map(([id, v]) => ({ name: names.get(id) ?? clip(v.name), id, limit: v.cents, spent: spent.get(id) ?? 0 }))
    .sort((x, y) => { const l = x.spent * y.limit, r = y.spent * x.limit; return l !== r ? r - l : x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
}

// ---- month at a glance
export interface GlanceRow { name: string; current: number; previous: number; percent: number | null }
export interface Glance { days: number; spent: number; avgPerDay: number; rows: GlanceRow[]; previousDays: number }

/** Change of the per-day average: this month's `current` over `days` days against last month's `previous` over `prevDays`. */
export function glancePercent(current: number, days: number, previous: number, prevDays: number): number | null {
  if (days === prevDays) return percentChange(current, previous);
  if (previous === 0 || days <= 0 || prevDays <= 0) return null;
  const cur = current / days, prev = previous / prevDays;
  return roundHalfAway(((cur - prev) / prev) * 100);
}
/** This month so far against the same number of days of the month before. Card payments are not spending and never appear. */
export function makeGlance(entries: Entry[], month: DayRange, today: string): Glance {
  const empty: Glance = { days: 0, spent: 0, avgPerDay: 0, rows: [], previousDays: 0 };
  const s = Civil.parts(month.start);
  const ed = Civil.days(today < month.end ? today : month.end);
  if (!s || ed === null || today < month.start) return empty;
  const days = ed - Civil.daysOfParts(s) + 1;
  const curEnd = Civil.keyOfDays(ed);
  const py = s.m === 1 ? s.y - 1 : s.y, pm = s.m === 1 ? 12 : s.m - 1;
  const prevStart = Civil.keyOf(py, pm, 1), prevDays = Math.min(days, Civil.daysInMonth(py, pm)), prevEnd = Civil.keyOf(py, pm, prevDays);
  const cur = new Map<string, number>(), prev = new Map<string, number>(), names = new Map<string, string>(), folds = new Map<string, string>();
  let total = 0;
  for (const e of entries) {
    if (e.kind !== 'expense') continue;
    const inCur = e.day >= month.start && e.day <= curEnd, inPrev = e.day >= prevStart && e.day <= prevEnd;
    if (!(inCur || inPrev) || isDebtPayment(e)) continue;
    let f = folds.get(e.category);
    if (f === undefined) { const n = clip(e.category); f = foldKey(n); folds.set(e.category, f); names.set(f, displayName(names.get(f), n)); }
    if (inCur) { cur.set(f, (cur.get(f) ?? 0) + e.cents); total += e.cents; } else prev.set(f, (prev.get(f) ?? 0) + e.cents);
  }
  const rows: GlanceRow[] = [];
  for (const f of new Set([...cur.keys(), ...prev.keys()])) {
    const c = cur.get(f) ?? 0, p = prev.get(f) ?? 0;
    rows.push({ name: names.get(f) ?? f, current: c, previous: p, percent: glancePercent(c, days, p, prevDays) });
  }
  rows.sort((a, b) => (a.current !== b.current ? b.current - a.current : a.previous !== b.previous ? b.previous - a.previous : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { days, spent: total, avgPerDay: divRound(total, days), rows, previousDays: prevDays };
}
export { DEBT_PAYMENT };

/** The range one step (n = -1 or 1) away, or null at the ends of the calendar (years 1 and 9999). */
export function stepPeriod(p: Period, r: DayRange, n: number, weekStart: number): DayRange | null {
  if (p.kind === 'month') {
    const first = Civil.addMonthsFirst(r.start, n);
    return first === null ? null : rangeContaining(p, first, weekStart);
  }
  const len = p.kind === 'custom' ? dayCount(r) : p.kind === 'week' ? 7 : 1;
  if (p.kind === 'custom') {
    const s = shiftKey(r.start, n * len), e = shiftKey(r.end, n * len);
    return s === null || e === null ? null : makeRange(s, e);
  }
  const start = shiftKey(r.start, n * len);
  if (start === null) return null;
  const moved = rangeContaining(p, start, weekStart);
  // a week that would cross either end of the calendar is not a real week
  return (n > 0 && r.end >= MAX_KEY) || (n < 0 && r.start <= MIN_KEY) ? null : moved;
}
export const canStep = (p: Period, r: DayRange, n: number, weekStart: number): boolean => stepPeriod(p, r, n, weekStart) !== null;
