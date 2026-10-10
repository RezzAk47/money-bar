import { describe, expect, it } from 'vitest';
import fx from './fixtures/categories-csv.json';
import { DEBT_PAYMENT, clip, cleanCategory, displayName, foldKey, groupKey, isDebtName, normalize, sameName } from '../src/core/categories';
import { csvCell } from '../src/core/csv';
import { E } from './helpers';
import { isDebtPayment } from '../src/core/model';

describe('reserved Debt payment', () => {
  for (const n of fx.debt) it(`${JSON.stringify(n)} is the reserved name`, () => {
    expect(isDebtName(n)).toBe(true);
    expect(cleanCategory('expense', n)).toBe(DEBT_PAYMENT);
    expect(isDebtPayment(E('expense', 100, '2026-10-05', n))).toBe(true);
  });
  for (const n of fx.notDebt) it(`${JSON.stringify(n)} is not`, () => expect(isDebtName(n)).toBe(false));
  it('income is never a debt payment', () => expect(isDebtPayment(E('income', 100, '2026-10-05', 'Debt-payment'))).toBe(false));
});
describe('spelling rules', () => {
  it('normalizes, clips and folds', () => {
    expect(normalize('  a   b \n c ')).toBe('a b c');
    expect(normalize('   ')).toBe('Other');
    expect(clip('x'.repeat(40))).toHaveLength(30);
    expect(foldKey('CAFÉ')).toBe('cafe');
    expect(sameName('Cafe', 'Café')).toBe(true);
    expect(groupKey('  Café ')).toBe('cafe');
    expect(displayName('Café', 'Cafe')).toBe('Cafe');
    expect(cleanCategory('tip', '  ')).toBe('');
    expect(cleanCategory('tip', ' Cash ')).toBe('Cash');
  });
  it('Persian names survive', () => { expect(normalize('غذا')).toBe('غذا'); expect(isDebtName('غذا')).toBe(false); });
});
describe('CSV cell (Mac vectors)', () => {
  for (const [input, out] of fx.csv) it(`${JSON.stringify(input)}`, () => expect(csvCell(input)).toBe(out));
});
