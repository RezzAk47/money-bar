// Inputs found by a hostile review (2026-10-10): each one broke the app before its fix.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMoneyFile, uniqueIds } from '../src/core/model';
import type { Entry } from '../src/core/model';
import { MoneyStore } from '../src/core/store';
import { parseMoney } from '../src/core/money';
import { Clock, nodeIO, noon, tmpDir } from './helpers';

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

describe('a save that reached the disk but was reported as failed', () => {
  async function store() {
    const dir = tmpDir(), io = nodeIO(dir);
    const s = new MoneyStore({ io, nowProvider: new Clock(noon('2026-10-06')).now, timeZone: 'UTC' });
    await s.init();
    return { s, io, file: path.join(dir, 'entries.json') };
  }
  it('the file was written, then the stat after it failed: the add counts, and the next add does not double it', async () => {
    const { s, io, file } = await store();
    const realWrite = io.write.bind(io), realStat = io.stat.bind(io);
    let failNextStat = false;
    io.write = async (n, t, e) => { await realWrite(n, t, e); if (n === 'entries.json') failNextStat = true; };
    io.stat = async (n) => { if (failNextStat) { failNextStat = false; throw new Error('the file did not answer in time'); } return realStat(n); };
    expect(await s.add('expense', 1450, 'Food', 'lunch', '2026-10-06')).toBeNull(); // used to be "Could not save: ..."
    expect(s.entries).toHaveLength(1); // used to be 0 while the file had 1, so the user typed it again
    expect(s.saveError).toBeNull();
    expect(decodeMoneyFile(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1);
    expect(await s.add('expense', 200, 'Food', 'later', '2026-10-06')).toBeNull();
    expect(decodeMoneyFile(fs.readFileSync(file, 'utf8')).entries.map((e) => e.cents).sort()).toEqual([1450, 200].sort());
  });
  it('the write call failed after the file was replaced (the reply was lost): what is on disk is ours, so it counts', async () => {
    const { s, io, file } = await store();
    const realWrite = io.write.bind(io);
    io.write = async (n, t, e) => { await realWrite(n, t, e); if (n === 'entries.json') throw 'the file did not answer in time'; };
    expect(await s.add('expense', 999, 'Food', '', '2026-10-06')).toBeNull();
    expect(s.entries).toHaveLength(1);
    io.write = realWrite;
    expect(await s.add('expense', 1, 'Food', '', '2026-10-06')).toBeNull();
    expect(decodeMoneyFile(fs.readFileSync(file, 'utf8')).entries).toHaveLength(2);
  });
  it('a write that really failed is still reported and undone', async () => {
    const { s, io, file } = await store();
    io.failWrites = true;
    expect(await s.add('expense', 999, 'Food', '', '2026-10-06')).toContain('Could not save');
    expect(s.entries).toHaveLength(0);
    expect(decodeMoneyFile(fs.readFileSync(file, 'utf8')).entries).toHaveLength(0);
  });
});

describe('a currency symbol made of digits or separators', () => {
  // Settings accept any 1 to 3 characters as the symbol. "1" was stripped from the front of "12.50", which then read as $2.50.
  it('never eats part of the amount', () => {
    expect(parseMoney('12.50', '1')).toEqual({ ok: true, cents: 1250 });
    expect(parseMoney('10', '0')).toEqual({ ok: true, cents: 1000 });
    expect(parseMoney('.5', '.')).toEqual({ ok: true, cents: 50 });
    expect(parseMoney('12.50', '١')).toEqual({ ok: true, cents: 1250 }); // Arabic-Indic one
    expect(parseMoney('1,000', ',')).toEqual({ ok: true, cents: 100000 });
  });
  it('ordinary symbols, with letters or a dot after letters, still work', () => {
    expect(parseMoney('kr.12.50', 'kr.')).toEqual({ ok: true, cents: 1250 });
    expect(parseMoney('12.50 Rs.', 'Rs.')).toEqual({ ok: true, cents: 1250 });
    expect(parseMoney('R$ 3', 'R$')).toEqual({ ok: true, cents: 300 });
    expect(parseMoney('$7', '1')).toEqual({ ok: true, cents: 700 });
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
