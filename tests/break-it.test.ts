// Inputs found by a hostile review (2026-10-10): each one broke the app before its fix.
import { describe, expect, it } from 'vitest';
import { decodeMoneyFile, uniqueIds } from '../src/core/model';
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

describe('a lone surrogate escape in entries.json', () => {
  // "\ud800" alone is not a character. This parser accepted it, so the file loaded, but every save sent the note back to Rust as
  // "\ud800", which serde_json refuses (lib.rs test): the app showed the data and could never save again.
  it('is reported as unreadable (with a position) instead of loading a file that can never be saved', () => {
    for (const bad of ['"\\ud800"', '"x\\udc00"', '"\\ud800\\u0041"', '"\\ud800\\ud800"', '"\\udc00\\ud800"']) {
      const text = `{"entries":[{"kind":"expense","cents":100,"date":"2026-10-01","note":${bad}}]}`;
      expect(() => decodeMoneyFile(text, 'UTC'), bad).toThrow(/surrogate.*position/);
    }
  });
  it('a proper pair, escaped or raw, still loads', () => {
    for (const ok of ['"\\ud83d\\ude00"', '"\u{1F600}"', '"\\uD83D\\uDE00 ok"']) {
      const text = `{"entries":[{"kind":"expense","cents":100,"date":"2026-10-01","note":${ok}}]}`;
      expect(decodeMoneyFile(text, 'UTC').entries[0].note).toContain('\u{1F600}');
    }
  });
});
