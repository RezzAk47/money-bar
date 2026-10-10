// Differential tests against the Mac app's own Model.swift (run through a scratch driver, outputs saved as fixtures):
// whitespace sets from a scan of U+0000..U+1FFFF and U+E0000..U+E0FFF, and 5,000 random Unicode strings for the category
// spelling functions. Zero differences are required.
import { describe, expect, it } from 'vitest';
import ws from './fixtures/swift-whitespace.json';
import rows from './fixtures/swift-categories.json';
import { clip, cleanCategory, foldKey, isDebtName, letterFold, normalize, sameName } from '../src/core/categories';
import { parseMoney } from '../src/core/money';
import { csvCell } from '../src/core/csv';

type Row = { raw?: string; norm?: string; clip?: string; fold?: string; letter?: string; debt?: boolean; cx?: string; ct?: string; ci?: string; a?: string; b?: string; same?: boolean };

describe('whitespace sets match CharacterSet', () => {
  it('whitespacesAndNewlines: normalize() treats exactly those code points as spaces', () => {
    const swift = new Set(ws.whitespacesAndNewlines);
    const diffs: string[] = [];
    for (let c = 0; c < 0x20000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const isWs = normalize('a' + String.fromCodePoint(c) + 'b') === 'a b';
      if (isWs !== swift.has(c)) diffs.push(c.toString(16));
    }
    expect(diffs).toEqual([]);
    expect(normalize('​')).toBe('Other');
    expect(cleanCategory('expense', ' ​ ')).toBe('Other');
  });
  it('whitespaces (around the symbol in an amount): same set minus newlines', () => {
    const sp = new Set(ws.whitespaces);
    const diffs: string[] = [];
    for (let c = 0; c < 0x20000; c++) {
      if (c >= 0xd800 && c <= 0xdfff || /^\p{Nd}$/u.test(String.fromCodePoint(c))) continue;
      const r = parseMoney('$' + String.fromCodePoint(c) + '5');
      if ((r.ok && r.cents === 500) !== sp.has(c)) diffs.push(c.toString(16));
    }
    expect(diffs).toEqual([]);
  });
  it('CSV formula defusing skips the same leading whitespace', () => {
    expect(csvCell('​=1')).toBe("'​=1");
    expect(csvCell('　=1')).toBe("'　=1");
  });
});

describe('category spelling functions match Swift on 5,000 random strings', () => {
  const cats = (rows as Row[]).filter((r) => r.raw !== undefined);
  const sames = (rows as Row[]).filter((r) => r.a !== undefined);
  const check = (name: string, f: (r: Row) => unknown, want: (r: Row) => unknown) => it(name, () => {
    const diffs: string[] = [];
    for (const r of cats) { const g = f(r), w = want(r); if (g !== w) diffs.push(`${JSON.stringify(r.raw)}: ts=${JSON.stringify(g)} swift=${JSON.stringify(w)}`); }
    expect(diffs.slice(0, 8), `${diffs.length} differences`).toEqual([]);
  });
  check('normalize', (r) => normalize(r.raw!), (r) => r.norm);
  check('clip', (r) => clip(r.raw!), (r) => r.clip);
  check('foldKey', (r) => foldKey(clip(r.raw!)), (r) => r.fold);
  check('letterFold', (r) => letterFold(r.raw!), (r) => r.letter);
  check('isDebtName', (r) => isDebtName(r.raw!), (r) => r.debt);
  check('cleanCategory expense', (r) => cleanCategory('expense', r.raw!), (r) => r.cx);
  check('cleanCategory tip', (r) => cleanCategory('tip', r.raw!), (r) => r.ct);
  check('cleanCategory income', (r) => cleanCategory('income', r.raw!), (r) => r.ci);
  it('sameName', () => {
    const diffs = sames.filter((r) => sameName(r.a!, r.b!) !== r.same).map((r) => JSON.stringify([r.a, r.b]));
    expect(diffs.slice(0, 8), `${diffs.length} differences`).toEqual([]);
  });
});
