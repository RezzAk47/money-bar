// Days that do not exist in a zone (Pacific/Apia skipped 2011-12-30, Pacific/Kiritimati skipped 1994-12-31) are refused the way the
// Mac app refuses them (checked against Model.swift with TZ set), so a rule never creates an entry the Mac then cannot read.
import { describe, expect, it } from 'vitest';
import { isValidLocalDay } from '../src/core/civil';
import { decodeMoneyFile, validateEntry } from '../src/core/model';
import { applyRules, validateRule } from '../src/core/recurring';
import type { RecurringRule } from '../src/core/recurring';
import type { Entry } from '../src/core/model';

const file = (d: string) => JSON.stringify({ entries: [{ kind: 'expense', cents: 100, date: d }] });
describe('skipped calendar days', () => {
  it('isValidLocalDay', () => {
    expect(isValidLocalDay('2011-12-30', 'Pacific/Apia')).toBe(false);
    expect(isValidLocalDay('2011-12-29', 'Pacific/Apia')).toBe(true);
    expect(isValidLocalDay('2011-12-31', 'Pacific/Apia')).toBe(true);
    expect(isValidLocalDay('1994-12-31', 'Pacific/Kiritimati')).toBe(false);
    expect(isValidLocalDay('1994-12-31', 'UTC')).toBe(true);
    expect(isValidLocalDay('2011-12-30', 'America/Sao_Paulo')).toBe(true);
    expect(isValidLocalDay('2018-11-04', 'America/Sao_Paulo')).toBe(true); // a day with no midnight still exists
    expect(isValidLocalDay('2026-02-30', 'UTC')).toBe(false);
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Pacific/Auckland', 'America/Vancouver', 'Asia/Tehran']) expect(isValidLocalDay('2026-10-07', tz), tz).toBe(true);
  });
  it('decoding names the date like the Mac does', () => {
    expect(() => decodeMoneyFile(file('2011-12-30'), 'Pacific/Apia')).toThrow('entries > #1 > date: "2011-12-30" is not a date like 2026-10-15');
    expect(decodeMoneyFile(file('2011-12-30'), 'UTC').entries).toHaveLength(1);
    expect(() => decodeMoneyFile(file('1994-12-31'), 'Pacific/Kiritimati')).toThrow('is not a date');
    expect(decodeMoneyFile(file('2011-12-29'), 'Pacific/Apia').entries).toHaveLength(1);
  });
  it('forms refuse them', () => { expect(validateEntry(100, '', '2011-12-30', 'Pacific/Apia')).toBe('That date is not valid.'); expect(validateEntry(100, '', '2011-12-30', 'UTC')).toBeNull(); });
  it('a monthly rule skips the missing day, advances, and never creates an entry the Mac would refuse', () => {
    const r: RecurringRule = { id: '11111111-2222-3333-4444-555555555555', kind: 'expense', cents: 100, category: 'Rent', note: '', repeatKind: 'monthly', interval: 1, start: '2011-11-30', paused: false };
    const es: Entry[] = [];
    applyRules([r], es, '2012-01-31', 1, 12, 'Pacific/Apia');
    expect(es.map((e) => e.day)).toEqual(['2011-11-30', '2012-01-30']); expect(r.last).toBe('2012-01-30');
    expect(validateRule({ ...r, start: '2011-12-30', end: undefined }, undefined, 'Pacific/Apia')).toBe('The start date is not valid.');
    const none: Entry[] = []; applyRules([{ ...r, start: '2011-12-30', last: undefined }], none, '2011-12-30', 1, 12, 'Pacific/Apia'); expect(none).toEqual([]);
    const text = JSON.stringify({ entries: es.map((e) => ({ kind: e.kind, cents: e.cents, date: e.day })) });
    expect(decodeMoneyFile(text, 'Pacific/Apia').entries).toHaveLength(2);
  });
});
