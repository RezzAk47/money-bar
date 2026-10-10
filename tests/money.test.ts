import { describe, expect, it } from 'vitest';
import fx from './fixtures/money-parse.json';
import { MAX_CENTS, cleanSymbol, divRound, formatMoney, moneyMessage, parseMoney, plainMoney, roundHalfAway } from '../src/core/money';

describe('Money.parse (vectors from the Mac tests)', () => {
  for (const c of fx.ok) it(`reads ${JSON.stringify(c.input.slice(0, 20))} as ${c.cents}`, () => expect(parseMoney(c.input)).toEqual({ ok: true, cents: c.cents }));
  for (const c of fx.err) it(`refuses ${JSON.stringify(c.input.slice(0, 20))} as ${c.error}`, () => expect(parseMoney(c.input)).toEqual({ ok: false, error: c.error }));
  for (const c of fx.symbols) it(`custom symbol ${c.symbol}`, () => expect(parseMoney(c.input, c.symbol)).toEqual({ ok: true, cents: c.cents }));
  it('messages are readable', () => {
    expect(moneyMessage('zero')).toContain('more than zero');
    expect(moneyMessage('tooLarge')).toContain('$1,000,000.00');
  });
});

describe('format', () => {
  it('groups for display, plain for CSV and forms', () => {
    expect(formatMoney(123450, '$')).toBe('$1,234.50');
    expect(formatMoney(-500, '$')).toBe('-$5.00');
    expect(formatMoney(500, '$', true)).toBe('$5');
    expect(formatMoney(550, '$', true)).toBe('$5.50');
    expect(formatMoney(1250, '$', false, true)).toBe('+$12.50');
    expect(formatMoney(0, '$', true, true)).toBe('$0');
    expect(plainMoney(123450)).toBe('1234.50');
    expect(plainMoney(-305)).toBe('-3.05');
    expect(plainMoney(MAX_CENTS)).toBe('1000000.00');
    expect(parseMoney(plainMoney(123450))).toEqual({ ok: true, cents: 123450 });
  });
  it('divRound goes half away from zero and never divides by zero', () => {
    expect(divRound(5, 2)).toBe(3); expect(divRound(-5, 2)).toBe(-3); expect(divRound(7, 3)).toBe(2); expect(divRound(10, 0)).toBe(0); expect(divRound(10, -1)).toBe(0);
    expect(roundHalfAway(-2.5)).toBe(-3); expect(roundHalfAway(2.5)).toBe(3);
  });
  it('currency symbol is trimmed and cut to 3', () => { expect(cleanSymbol('  ')).toBe('$'); expect(cleanSymbol('USDX')).toBe('USD'); });
});
