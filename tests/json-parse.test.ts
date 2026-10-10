import { describe, expect, it } from 'vitest';
import { parseJson } from '../src/core/jsonparse';
import { decodeMoneyFile, encodeMoneyFile, cleanBudgets, defaultSettings, setBudgetIn } from '../src/core/model';
import { stableStringify, unknownKeys } from '../src/core/json';
import { MoneyStore } from '../src/core/store';
import { Clock, nodeIO, noon, tmpDir } from './helpers';

describe('duplicate keys: the first value wins, as in the Mac app (checked against Model.swift)', () => {
  it('top level, entry and settings', () => {
    expect(decodeMoneyFile('{"entries":[{"kind":"expense","cents":100,"cents":200,"date":"2026-01-01"}]}').entries[0].cents).toBe(100);
    expect(decodeMoneyFile('{"entries":[{"kind":"expense","cents":200,"cents":100,"date":"2026-01-01"}]}').entries[0].cents).toBe(200);
    expect(decodeMoneyFile('{"entries":[],"entries":[{"kind":"expense","cents":5,"date":"2026-01-01"}]}').entries).toHaveLength(0);
    expect(decodeMoneyFile('{"settings":{"theme":"ocean","theme":"grape"}}').settings.theme).toBe('ocean');
  });
});
describe('the strict parser', () => {
  it('reads what JSON.parse reads', () => {
    const t = '{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e9\\ud83d\\ude00"],"b":{"c":{}},"d":[]}';
    expect(JSON.parse(JSON.stringify(parseJson(t)))).toEqual(JSON.parse(t));
    expect(parseJson(' \n\t[1 , 2] ')).toEqual([1, 2]);
  });
  it('refuses what JSON refuses, with a position (trailing commas too: the Mac app accepts them, this app reports them)', () => {
    for (const bad of ['{"a":1,}', '[1,]', '{a:1}', "{'a':1}", '[01]', '[1.]', '[.5]', '"\\x"', '"a\nb"', '{"a":1} x', '', '[1', '{"a" 1}', 'NaN', '[+1]', '//c\n{}']) expect(() => parseJson(bad), bad).toThrow(/at position|end of|Unexpected/);
  });
  it('a file with a trailing comma is a named error and is never overwritten', async () => {
    expect(() => decodeMoneyFile('{"entries":[],}')).toThrow(/not valid JSON/);
  });
  it('deep nesting is an error, not a crash', () => { expect(() => parseJson('['.repeat(5000) + ']'.repeat(5000))).toThrow(/too deeply/); });
  it('keeps odd keys as own keys', () => {
    const o = parseJson('{"__proto__":{"x":1},"constructor":2,"toString":3}') as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it('is fast on a 20,000 entry file', () => {
    const e = Array.from({ length: 20000 }, (_, i) => ({ id: 'A'.repeat(8) + '-0000-4000-8000-' + String(i).padStart(12, '0'), kind: 'expense', cents: 100 + i, category: 'Food', note: 'n' + i, date: '2026-01-01', created: 1, sample: false }));
    const text = JSON.stringify({ version: 1, entries: e });
    const t = performance.now(); parseJson(text); const ms = performance.now() - t;
    console.log(`PARSE 20000 entries (${(text.length / 1e6).toFixed(1)} MB): ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

describe('names that exist on Object.prototype', () => {
  const names = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];
  it('are ordinary budget and category names', () => {
    const s = defaultSettings();
    for (const n of names) setBudgetIn(s, n, 1234);
    expect(Object.keys(s.budgets).sort()).toEqual([...names].sort());
    expect(Object.entries(cleanBudgets(s.budgets)).length).toBe(5);
    const back = decodeMoneyFile(encodeMoneyFile({ version: 1, settings: s, entries: [] })).settings;
    expect(Object.keys(back.budgets).sort()).toEqual([...names].sort());
    for (const n of names) setBudgetIn(back, n, undefined);
    expect(Object.keys(back.budgets)).toEqual([]);
  });
  it('unknown keys named __proto__ or constructor survive a round trip', () => {
    const f = decodeMoneyFile('{"__proto__":{"a":1},"constructor":{"b":2},"entries":[],"settings":{"toString":7}}');
    const out = encodeMoneyFile(f);
    expect(Object.keys(JSON.parse(out)).sort()).toEqual(['__proto__', 'constructor', 'entries', 'settings', 'version']);
    expect(out).toContain('"__proto__"');
    expect(JSON.parse(out).settings.toString).toBe(7);
    expect(stableStringify(unknownKeys(JSON.parse('{"__proto__":1,"a":2}'), ['a']))).toContain('__proto__');
  });
  it('categories with those names are added, budgeted, reported', async () => {
    const dir = tmpDir();
    const s = new MoneyStore({ io: nodeIO(dir), nowProvider: new Clock(noon('2026-10-06')).now, timeZone: 'UTC' });
    await s.init();
    for (const n of names) { expect((await s.addCategory(n)).error).toBeNull(); expect(await s.setBudget(n, 5000)).toBeNull(); expect(await s.add('expense', 1000, n, '', '2026-10-06')).toBeNull(); }
    expect(s.budgetStatuses().map((b) => b.name).sort()).toEqual([...names].sort());
    expect(s.report({ kind: 'day' }).categories.map((c) => c.name).sort()).toEqual([...names].sort());
    expect(s.glance().rows).toHaveLength(5);
    const s2 = new MoneyStore({ io: nodeIO(dir), nowProvider: new Clock(noon('2026-10-06')).now, timeZone: 'UTC' });
    await s2.init();
    expect(s2.loadError).toBeNull(); expect(Object.keys(s2.settings.budgets)).toHaveLength(5);
  });
});
