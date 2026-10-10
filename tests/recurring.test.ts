import { describe, expect, it } from 'vitest';
import { CATCH_UP_CAP, RecurringRule, applyRules, due, effectiveLast, entryId, latest, nextDue, occurrences, repeatText, validateRule } from '../src/core/recurring';
import type { Entry } from '../src/core/model';

const R = (o: Partial<RecurringRule> = {}): RecurringRule => ({ id: '11111111-2222-3333-4444-555555555555', kind: 'expense', cents: 100, category: 'Rent', note: '', repeatKind: 'monthly', interval: 1, start: '2026-01-31', paused: false, ...o });

describe('occurrences (Mac vectors)', () => {
  it('month-end clamp', () => {
    expect(occurrences(R(), undefined, '2026-06-30', 99)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(occurrences(R(), '2026-02-28', '2026-04-30', 99)).toEqual(['2026-03-31', '2026-04-30']);
    expect(occurrences(R({ start: '2024-02-29' }), undefined, '2025-03-31', 99).filter((d) => d.includes('-02-'))).toEqual(['2024-02-29', '2025-02-28']);
    expect(occurrences(R({ start: '2027-01-30' }), undefined, '2027-03-31', 9)).toEqual(['2027-01-30', '2027-02-28', '2027-03-30']);
    expect(occurrences(R({ start: '2027-12-15' }), undefined, '2028-02-20', 9)).toEqual(['2027-12-15', '2028-01-15', '2028-02-15']);
  });
  it('weekly, every N days, end date, limit, before start', () => {
    expect(occurrences(R({ repeatKind: 'weekly', start: '2026-10-01' }), undefined, '2026-10-30', 9)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
    expect(occurrences(R({ repeatKind: 'days', interval: 10, start: '2026-10-01' }), '2026-10-11', '2026-11-15', 9)).toEqual(['2026-10-21', '2026-10-31', '2026-11-10']);
    expect(occurrences(R({ start: '2026-10-10' }), undefined, '2026-10-09', 9)).toEqual([]);
    expect(occurrences(R({ start: '2026-01-01', end: '2026-03-15' }), undefined, '2026-12-31', 99)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(occurrences(R({ repeatKind: 'days', interval: 1, start: '2026-01-01' }), undefined, '2026-12-31', 5)).toHaveLength(5);
  });
  it('latest, nextDue, repeatText, year 9999 does not loop', () => {
    expect(latest(R({ start: '2026-01-15' }), '2026-05-20')).toBe('2026-05-15');
    expect(latest(R({ start: '2026-01-15', end: '2026-03-01' }), '2026-05-20')).toBe('2026-02-15');
    expect(nextDue(R({ start: '2026-01-15', last: '2026-03-15' }))).toBe('2026-04-15');
    expect(nextDue(R({ start: '9999-12-31', last: '9999-12-31' }))).toBeUndefined();
    expect(repeatText(R({ repeatKind: 'days', interval: 14 }))).toBe('every 14 days'); expect(repeatText(R({ repeatKind: 'days', interval: 1 }))).toBe('every day');
  });
});

describe('ids', () => {
  it('stable per rule and date, different otherwise, a valid UUID', () => {
    const a = R(), b = R();
    expect(entryId(a, '2026-02-15')).toBe(entryId(b, '2026-02-15'));
    expect(entryId(a, '2026-02-15')).not.toBe(entryId(a, '2026-02-16'));
    expect(entryId(a, '2026-02-15')).not.toBe(entryId(R({ id: '11111111-2222-3333-4444-555555555556' }), '2026-02-15'));
    expect(entryId(a, '2026-02-15')).toBe('7A40137D-69BD-33C0-C3ED-561542B6425E'); // the id the Mac app's Model.swift makes for the same rule and day
    expect(entryId(a, '2026-02-15')).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });
});

describe('apply', () => {
  it('adds due entries once, oldest first, and a deleted entry is never added again', () => {
    const rules = [R({ start: '2026-08-15' })], entries: Entry[] = [];
    expect(applyRules(rules, entries, '2026-10-20', 1)).toBe(3);
    expect(entries.map((e) => e.day)).toEqual(['2026-08-15', '2026-09-15', '2026-10-15']);
    expect(entries.every((e) => e.recurringID === rules[0].id && !e.sample)).toBe(true);
    expect(rules[0].last).toBe('2026-10-15');
    entries.length = 0;
    expect(applyRules(rules, entries, '2026-10-20', 1)).toBe(0);
    expect(due(rules, '2026-10-20')).toBe(false); expect(due(rules, '2026-11-15')).toBe(true);
  });
  it('an existing id is skipped (two copies never double-add)', () => {
    const rules = [R({ start: '2026-10-01' })], entries: Entry[] = [];
    applyRules(rules, entries, '2026-10-05', 1);
    const rules2 = [R({ start: '2026-10-01' })];
    expect(applyRules(rules2, entries, '2026-10-05', 1)).toBe(0); expect(entries).toHaveLength(1);
  });
  it('12 catch-ups per check; the rest on the next ticks', () => {
    const rules = [R({ repeatKind: 'days', interval: 1, start: '2026-09-01' })], entries: Entry[] = [];
    expect(applyRules(rules, entries, '2026-10-20', 1)).toBe(CATCH_UP_CAP);
    expect(applyRules(rules, entries, '2026-10-20', 1)).toBe(12);
    let n = 0; while (applyRules(rules, entries, '2026-10-20', 1) > 0) n++;
    expect(entries).toHaveLength(50); expect(n).toBeGreaterThan(0);
  });
  it('a 400-day backfill limit: far-past occurrences are skipped, never added', () => {
    const rules = [R({ repeatKind: 'days', interval: 1, start: '2020-01-01' })];
    const eff = effectiveLast(rules[0], '2026-10-20')!;
    expect(eff).toBe('2025-09-14'); // 401 days before today
    const entries: Entry[] = []; applyRules(rules, entries, '2026-10-20', 1);
    expect(entries[0].day).toBe('2025-09-15');
  });
  it('paused rules do nothing', () => { const e: Entry[] = []; expect(applyRules([R({ paused: true, start: '2026-10-01' })], e, '2026-10-20', 1)).toBe(0); expect(due([R({ paused: true })], '2026-10-20')).toBe(false); });
});

describe('validate', () => {
  const ok = { cents: 100, start: '2026-10-01', end: undefined, interval: 1, repeatKind: 'monthly' as const, note: '' };
  it('messages', () => {
    expect(validateRule(ok)).toBeNull();
    expect(validateRule({ ...ok, cents: 0 })).toContain('more than zero');
    expect(validateRule({ ...ok, start: '2026-02-30' })).toBe('The start date is not valid.');
    expect(validateRule({ ...ok, end: '2026-09-01' })).toBe('The end date is before the start date.');
    expect(validateRule({ ...ok, repeatKind: 'days', interval: 366 })).toBe('Repeat every 1 to 365 days.');
    expect(validateRule({ ...ok, start: '2002-10-01' }, '2026-10-01')).toContain('more than 400 days ago');
    expect(validateRule({ ...ok, start: '2002-10-01' })).toBeNull();
    expect(validateRule({ ...ok, note: 'x'.repeat(301) })).toContain('too long');
  });
});
