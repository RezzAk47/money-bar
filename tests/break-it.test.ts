// Inputs found by a hostile review (2026-10-10): each one broke the app before its fix.
import { describe, expect, it } from 'vitest';
import { uniqueIds } from '../src/core/model';
import type { Entry } from '../src/core/model';

const X = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const entry = (id: string, i: number): Entry => ({ id, kind: 'expense', cents: 100 + i, category: 'Food', note: '', day: '2026-10-01', created: 1_760_000_000 + i, sample: false });

describe('duplicate ids in a hand-edited file', () => {
  it('a third copy of an id at position 256 does not hang the load (it used to loop forever)', () => {
    // entries #1 and #2 share an id, #256 is a third copy: its salt step was 256, so it retried the same taken id forever
    const list = Array.from({ length: 256 }, (_, i) => entry(i === 0 || i === 1 || i === 255 ? X : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i));
    const out = uniqueIds(list);
    expect(new Set(out.map((e) => e.id)).size).toBe(256);
    expect(uniqueIds(list).map((e) => e.id)).toEqual(out.map((e) => e.id)); // still the same ids on every load
  });
  it('hundreds of copies of one id all get distinct, stable ids', () => {
    const list = Array.from({ length: 600 }, (_, i) => entry(X, i));
    const out = uniqueIds(list);
    expect(new Set(out.map((e) => e.id)).size).toBe(600);
    expect(uniqueIds(list).map((e) => e.id)).toEqual(out.map((e) => e.id));
  });
});
