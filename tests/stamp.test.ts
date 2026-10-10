import { describe, expect, it } from 'vitest';
import { sameStamp } from '../src/core/io';
import type { FileStamp } from '../src/core/io';

describe('stamps are exact integers', () => {
  it('10,000 realistic nanosecond-derived stamps survive JSON unchanged', () => {
    let x = 123456789n;
    for (let i = 0; i < 10_000; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const ns = 1_600_000_000_000_000_000n + (x % 400_000_000_000_000_000n);
      const s: FileStamp = { size: Number(x % 100_000_000n), mtimeUs: Number(ns / 1000n), ctimeUs: Number((ns + x % 1000n) / 1000n), ino: (x >> 8n).toString() };
      expect(Number.isSafeInteger(s.mtimeUs) && Number.isSafeInteger(s.ctimeUs)).toBe(true);
      const back = JSON.parse(JSON.stringify(s)) as FileStamp;
      expect(back).toEqual(s); expect(sameStamp(s, back)).toBe(true);
    }
  });
  it('1 microsecond, 1 byte or another inode make a different stamp', () => {
    const a: FileStamp = { size: 10, mtimeUs: 1_760_000_000_000_000, ctimeUs: 1_760_000_000_000_000, ino: '5' };
    expect(sameStamp(a, { ...a })).toBe(true); expect(sameStamp(a, null)).toBe(false); expect(sameStamp(null, null)).toBe(true);
    for (const o of [{ mtimeUs: a.mtimeUs + 1 }, { ctimeUs: a.ctimeUs + 1 }, { size: 11 }, { ino: '6' }]) expect(sameStamp(a, { ...a, ...o })).toBe(false);
  });
});
