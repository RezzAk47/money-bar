import { describe, expect, it } from 'vitest';
import * as Civil from '../src/core/civil';
import { MAX_RANGE_DAYS, budgetStatuses, buckets, dayCount, dayKeys, glancePercent, groupedCategories, makeGlance, makeRange, makeReport, net, percentChange, quad, rangeContaining, reportFor, shifted, budgetLevel, budgetMessage, alertLevel } from '../src/core/reports';
import { csvExport, csvFileText } from '../src/core/csv';
import { E } from './helpers';

describe('civil dates', () => {
  it('round trips and validates', () => {
    expect(Civil.parts('2026-02-29')).toBeNull(); expect(Civil.parts('2024-02-29')).not.toBeNull(); expect(Civil.parts('2026-13-01')).toBeNull(); expect(Civil.parts('2026-1-01')).toBeNull(); expect(Civil.parts('0000-01-01')).toBeNull();
    for (const k of ['1970-01-01', '2026-10-07', '2000-02-29', '0001-01-01', '9999-12-31']) expect(Civil.keyOfDays(Civil.days(k)!)).toBe(k);
    expect(Civil.days('1970-01-01')).toBe(0);
    expect(Civil.weekday('2026-10-07')).toBe(4); // Wednesday, Sunday = 1
    expect(Civil.weekday('2026-10-04')).toBe(1);
  });
  it('today in a zone', () => {
    const t = Date.parse('2026-10-07T03:00:00Z');
    expect(Civil.dayKeyAt(t, 'America/Vancouver')).toBe('2026-10-06');
    expect(Civil.dayKeyAt(t, 'Asia/Tehran')).toBe('2026-10-07');
  });
});

describe('periods', () => {
  it('week start 1..7 and month shifts', () => {
    for (let ws = 1; ws <= 7; ws++) {
      const r = rangeContaining({ kind: 'week' }, '2026-10-07', ws);
      expect(dayCount(r)).toBe(7); expect(Civil.weekday(r.start)).toBe(ws); expect(r.start <= '2026-10-07' && '2026-10-07' <= r.end).toBe(true);
    }
    expect(rangeContaining({ kind: 'week' }, '2026-10-07', 2)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(rangeContaining({ kind: 'month' }, '2024-02-10', 2)).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    const m = rangeContaining({ kind: 'month' }, '2026-03-31', 2);
    expect(shifted({ kind: 'month' }, m, -1, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(shifted({ kind: 'month' }, rangeContaining({ kind: 'month' }, '2026-01-15', 2), -1, 2)).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(shifted({ kind: 'day' }, makeRange('2026-03-01', '2026-03-01'), -1, 2)).toEqual({ start: '2026-02-28', end: '2026-02-28' });
    expect(shifted({ kind: 'custom', range: makeRange('2026-10-01', '2026-10-10') }, makeRange('2026-10-01', '2026-10-10'), -1, 2)).toEqual({ start: '2026-09-21', end: '2026-09-30' });
  });
  it('a custom range is swapped and capped at 3660 days', () => {
    expect(makeRange('2026-10-10', '2026-10-01')).toEqual({ start: '2026-10-01', end: '2026-10-10' });
    const r = makeRange('2000-01-01', '2026-01-01');
    expect(dayCount(r)).toBe(MAX_RANGE_DAYS); expect(dayKeys(r)).toHaveLength(3660);
  });
  it('no day is lost around DST or a day without midnight (America/Sao_Paulo 2018-11-04)', () => {
    expect(dayKeys(makeRange('2018-11-03', '2018-11-06'))).toEqual(['2018-11-03', '2018-11-04', '2018-11-05', '2018-11-06']);
    expect(dayKeys(makeRange('2018-11-04', '2018-11-06'))).toEqual(['2018-11-04', '2018-11-05', '2018-11-06']);
    expect(dayKeys(makeRange('2026-03-07', '2026-03-10'))).toHaveLength(4); // US DST start
    expect(dayKeys(makeRange('2026-11-01', '2026-11-02'))).toHaveLength(2); // US DST end
    // and "today" in that zone on the day without midnight is that day
    expect(Civil.dayKeyAt(Date.parse('2018-11-04T12:00:00Z'), 'America/Sao_Paulo')).toBe('2018-11-04');
  });
});

describe('reports', () => {
  const day = '2026-10-05';
  const mixed = [E('expense', 4160, day, 'Food', 'dinner'), E('expense', 21600, day, 'Debt payment', 'Card payment'), E('expense', 1000, day, '  debt PAYMENT '), E('income', 50000, day, 'Job')];
  it('debt payments are excluded from Spent, Net, averages and the chart, and shown separately', () => {
    const r = reportFor(mixed, { kind: 'day' }, day, 2);
    expect(r.totals.spent).toBe(4160); expect(r.totals.debtPaid).toBe(22600); expect(net(r.totals)).toBe(50000 - 4160);
    expect(r.categories.map((c) => c.name)).toEqual(['Food']); expect(r.avgAllDays.spent).toBe(4160); expect(r.entryCount).toBe(4);
    expect(csvExport(r)).toContain('Paid toward card debt');
    expect(csvExport(reportFor(mixed, { kind: 'day' }, '2026-10-06', 2))).not.toContain('Paid toward card debt');
  });
  it('a day with only a card payment is not active; a debt day with income is', () => {
    const only = reportFor([E('expense', 500, '2026-10-06', 'Debt payment')], { kind: 'week' }, '2026-10-06', 2);
    expect(only.activeDays).toBe(0); expect(only.bestDay).toBeUndefined(); expect(only.avgNetActiveDays).toBe(0);
    const w = reportFor([...mixed, E('expense', 100, '2026-10-06', 'Debt payment')], { kind: 'week' }, day, 2);
    expect(w.activeDays).toBe(1);
  });
  it('integer cents add up with no float error', () => { expect(quad([E('expense', 10, day, 'Food'), E('expense', 20, day, 'Food')]).spent).toBe(30); });
  it('best, worst, averages, tips and trend', () => {
    const es = [E('income', 10000, '2026-10-05', 'Job'), E('tip', 500, '2026-10-05', 'Cash'), E('expense', 3000, '2026-10-06', 'Food'), E('tip', 700, '2026-10-07', 'Card'),
      E('expense', 1000, '2026-09-28', 'Food')];
    const r = reportFor(es, { kind: 'week' }, '2026-10-07', 2);
    expect(r.bestDay?.day).toBe('2026-10-05'); expect(r.worstDay?.day).toBe('2026-10-06');
    expect(r.dayCount).toBe(7); expect(r.activeDays).toBe(3); expect(r.tipDays).toBe(2); expect(r.avgTipPerTipDay).toBe(600);
    expect(r.avgAllDays.spent).toBe(429); expect(r.avgActiveDays.spent).toBe(1000); expect(r.trend.spent).toBe(200); expect(r.trend.earned).toBeNull();
    expect(percentChange(50, 100)).toBe(-50); expect(percentChange(5, 0)).toBeNull(); expect(percentChange(-150, -100)).toBe(-50);
  });
  it('categories merge spellings and show the smallest spelling', () => {
    const r = reportFor([E('expense', 100, day, 'Cafe'), E('expense', 200, day, 'Café'), E('expense', 50, day, 'CAFÉ')], { kind: 'day' }, day, 2);
    expect(r.categories).toEqual([{ name: 'CAFÉ', cents: 350, count: 3, percent: 100 }]);
    expect(groupedCategories(Array.from({ length: 10 }, (_, i) => ({ name: 'c' + i, cents: 10 - i, count: 1, percent: 10 })), 4).map((c) => c.name)).toEqual(['c0', 'c1', 'c2', 'Other categories (7)']);
  });
  it('buckets keep the totals', () => {
    const r = makeReport([E('expense', 100, '2026-01-01', 'Food'), E('income', 300, '2026-12-31', 'Job')], makeRange('2026-01-01', '2026-12-31'), makeRange('2025-01-01', '2025-12-31'));
    const b = buckets(r.daily); expect(b.length).toBeLessThanOrEqual(62); expect(b.reduce((a, x) => a + x.spent, 0)).toBe(100); expect(b.reduce((a, x) => a + x.days, 0)).toBe(365);
  });
  it('CSV: Recurring column only when needed, oldest first, BOM only in file text', () => {
    const plain = reportFor([E('expense', 300, '2026-10-04', 'C'), E('expense', 400, '2026-10-05', 'D')], { kind: 'week' }, '2026-10-05', 1);
    const csv = csvExport(plain);
    expect(csv).toContain('2026-10-04,Expense,3.00,C,'); expect(csv.indexOf('2026-10-04,Expense')).toBeLessThan(csv.indexOf('2026-10-05,Expense'));
    expect(csv.endsWith('\r\n')).toBe(true); expect(csv).not.toContain('Recurring'); expect(csv.charCodeAt(0)).not.toBe(0xfeff); expect(csvFileText(plain).charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Spending by category,Amount,Percent of spending'); expect(csv).toContain('C,3.00,43');
    const rec = reportFor([E('expense', 300, '2026-10-04', 'C', '', { recurringID: 'X' }), E('expense', 400, '2026-10-05', 'D')], { kind: 'week' }, '2026-10-05', 1);
    expect(csvExport(rec)).toContain('Note,Recurring'); expect(csvExport(rec)).toContain(',Yes');
    expect(csvExport(reportFor([E('expense', 100, '2026-10-05', '=cmd|x', '+1,2')], { kind: 'day' }, '2026-10-05', 2))).toContain("'=cmd|x,\"'+1,2\"");
  });
});

describe('budgets', () => {
  const month = makeRange('2026-10-01', '2026-10-31');
  it('statuses, levels, calm wording, debt excluded', () => {
    const es = [E('expense', 8000, '2026-10-02', 'Food'), E('expense', 5000, '2026-10-03', 'Café'), E('expense', 20000, '2026-10-03', 'Debt payment'), E('expense', 999, '2026-09-30', 'Food')];
    const s = budgetStatuses(es, { Food: 10000, Cafe: 5000, 'Debt payment': 100 }, month);
    expect(s.map((x) => x.name)).toEqual(['Café', 'Food']);
    expect(budgetLevel(s[0])).toBe('atLimit'); expect(budgetLevel(s[1])).toBe('near'); expect(alertLevel(s[0])).toBe(100); expect(alertLevel(s[1])).toBe(80);
    const f = (c: number) => '$' + (c / 100).toFixed(2);
    expect(budgetMessage(s[0], f)).toBe('Budget used up'); expect(budgetMessage(s[1], f)).toBe('$20.00 left');
    expect(budgetMessage({ name: 'x', id: 'x', limit: 100, spent: 1240 }, f)).toBe('$11.40 over');
    expect(budgetLevel({ name: 'x', id: 'x', limit: 100, spent: 79 })).toBe('ok'); expect(budgetLevel({ name: 'x', id: 'x', limit: 100, spent: 80 })).toBe('near');
  });
});

describe('month at a glance', () => {
  it('compares the same days of last month; per-day average when lengths differ', () => {
    const es = [E('expense', 1000, '2026-10-02', 'Food'), E('expense', 500, '2026-10-03', 'Fun'), E('expense', 2000, '2026-09-02', 'Food'), E('expense', 900, '2026-09-20', 'Food'), E('expense', 7000, '2026-10-03', 'Debt payment')];
    const g = makeGlance(es, makeRange('2026-10-01', '2026-10-31'), '2026-10-05');
    expect(g.days).toBe(5); expect(g.spent).toBe(1500); expect(g.avgPerDay).toBe(300);
    expect(g.rows).toEqual([{ name: 'Food', current: 1000, previous: 2000, percent: -50 }, { name: 'Fun', current: 500, previous: 0, percent: null }]);
    expect(makeGlance(es, makeRange('2026-11-01', '2026-11-30'), '2026-10-05').days).toBe(0);
    expect(glancePercent(3100, 31, 2800, 28)).toBe(Math.round((3100 / 31 - 100) / 100 * 100));
    const g31 = makeGlance([E('expense', 100, '2026-03-31', 'Food'), E('expense', 280, '2026-02-10', 'Food')], makeRange('2026-03-01', '2026-03-31'), '2026-03-31');
    expect(g31.previousDays).toBe(28);
  });
});

describe('navigation limits (years 1 to 9999)', () => {
  it('ranges are clamped and the controls stop at the ends', async () => {
    const { canStep, stepPeriod } = await import('../src/core/reports');
    const wk = { kind: 'week' } as const, mo = { kind: 'month' } as const, dy = { kind: 'day' } as const;
    expect(rangeContaining(mo, '9999-12-15', 2)).toEqual({ start: '9999-12-01', end: '9999-12-31' });
    expect(rangeContaining(wk, '9999-12-31', 2).end).toBe('9999-12-31');
    expect(rangeContaining(wk, '0001-01-01', 2).start >= '0001-01-01').toBe(true);
    expect(dayKeys(rangeContaining(wk, '9999-12-31', 2)).every((k) => k.length === 10)).toBe(true);
    expect(canStep(mo, rangeContaining(mo, '9999-12-15', 2), 1, 2)).toBe(false);
    expect(canStep(mo, rangeContaining(mo, '9999-11-15', 2), 1, 2)).toBe(true);
    expect(canStep(wk, rangeContaining(wk, '9999-12-30', 2), 1, 2)).toBe(false);
    expect(canStep(dy, rangeContaining(dy, '9999-12-31', 2), 1, 2)).toBe(false);
    expect(canStep(dy, rangeContaining(dy, '9999-12-30', 2), 1, 2)).toBe(true);
    expect(canStep(mo, rangeContaining(mo, '0001-01-20', 2), -1, 2)).toBe(false);
    expect(canStep(dy, rangeContaining(dy, '0001-01-01', 2), -1, 2)).toBe(false);
    const c = { kind: 'custom', range: makeRange('9999-12-01', '9999-12-31') } as const;
    expect(canStep(c, c.range, 1, 2)).toBe(false); expect(canStep(c, c.range, -1, 2)).toBe(true);
    expect(stepPeriod(mo, rangeContaining(mo, '2026-10-07', 2), 1, 2)).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(stepPeriod(mo, rangeContaining(mo, '9999-12-15', 2), 1, 2)).toBeNull();
    // the report for the last month works and has 31 days
    expect(reportFor([], mo, '9999-12-31', 2).dayCount).toBe(31);
  });
});
