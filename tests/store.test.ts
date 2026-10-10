import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MoneyStore, Notifier } from '../src/core/store';
import type { StoreOptions } from '../src/core/store';
import { Clock, bumpMtime, nodeIO, noon, tmpDir } from './helpers';
import { decodeMoneyFile } from '../src/core/model';
import type { RecurringRule } from '../src/core/recurring';

const day = '2026-10-06';
async function mk(over: Partial<StoreOptions> & { dir?: string; start?: string } = {}) {
  const dir = over.dir ?? tmpDir();
  const clock = new Clock(noon(over.start ?? day));
  const io = nodeIO(dir);
  const s = new MoneyStore({ io, nowProvider: clock.now, timeZone: 'UTC', ...over });
  await s.init();
  return { s, dir, clock, io, f: (n: string) => path.join(dir, n) };
}
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('loading and saving', () => {
  it('first run creates an empty file; add, update, delete persist', async () => {
    const { s, f } = await mk();
    expect(s.loadError).toBeNull(); expect(decodeMoneyFile(read(f('entries.json'))).entries).toEqual([]);
    expect(await s.add('expense', 1450, '  Food ', ' lunch ', day)).toBeNull();
    expect(await s.add('expense', 0, 'Food', '', day)).toContain('more than zero');
    expect(await s.add('expense', 100, 'Food', '', 'nope')).toBe('That date is not valid.');
    const id = s.entries[0].id;
    expect(s.entries[0]).toMatchObject({ category: 'Food', note: 'lunch', created: Math.floor(noon(day) / 1000) });
    expect(await s.update(id, 'income', 2000, 'Job', 'pay', day)).toBeNull();
    expect(decodeMoneyFile(read(f('entries.json'))).entries[0]).toMatchObject({ kind: 'income', cents: 2000 });
    expect(await s.update('00000000-0000-4000-8000-000000000000', 'tip', 1, '', '', day)).toContain('gone');
    expect(s.today.earned).toBe(2000); expect(s.menuText).toBe('+$20 today');
    await s.delete(id); expect(s.entries).toEqual([]); expect(s.menuText).toBe('$0 today');
  });
  it('an unreadable file is never overwritten, and nothing saves until start over keeps it', async () => {
    const dir = tmpDir(); const bad = '{"entries":[{"kind":"expense","cents":12.5,"date":"2026-10-05"}]}';
    fs.writeFileSync(path.join(dir, 'entries.json'), bad);
    const { s, f } = await mk({ dir });
    expect(s.loadError).toContain('entries > #1 > cents'); expect(s.menuText).toBe('entries.json?');
    expect(await s.add('expense', 100, 'Food', '', day)).toContain('cannot be read'); expect(await s.updateSettings((x) => { x.theme = 'ocean'; })).toContain('cannot be read');
    expect(await s.save()).toBe(false); expect(read(f('entries.json'))).toBe(bad);
    await s.tick(); expect(read(f('entries.json'))).toBe(bad);
    await s.startOver();
    expect(s.loadError).toBeNull(); const broken = fs.readdirSync(dir).filter((n) => n.startsWith('entries.broken-')); expect(broken).toHaveLength(1); expect(read(path.join(dir, broken[0]))).toBe(bad);
    expect(decodeMoneyFile(read(f('entries.json'))).entries).toEqual([]);
  });
  it('start over on a readable file changes nothing', async () => {
    const { s, f } = await mk(); await s.add('expense', 100, 'Food', '', day);
    const before = read(f('entries.json')); await s.startOver(); expect(read(f('entries.json'))).toBe(before);
  });
  it('failed write is reported, rolled back, and leaves no temp file', async () => {
    const { s, io, dir } = await mk(); io.failWrites = true;
    expect(await s.add('expense', 100, 'Food', '', day)).toContain('Could not save'); expect(s.entries).toEqual([]); expect(s.saveError).toBeTruthy();
    io.failWrites = false; expect(await s.add('expense', 100, 'Food', '', day)).toBeNull(); expect(s.entries).toHaveLength(1); expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
  it('a refusal from the Rust side (a plain string, e.g. a bad symlink) is shown by name', async () => {
    const { s, io } = await mk();
    const w = io.write.bind(io);
    io.write = async () => { throw 'entries.json is a link and its target is not a Money Bar file, so nothing was written.'; };
    expect(await s.add('expense', 100, 'Food', '', day)).toContain('is a link and its target is not a Money Bar file');
    expect(s.saveError).toContain('is a link'); expect(s.entries).toEqual([]);
    io.write = w;
  });
  it('a hand edit is picked up on tick and before every edit; a vanished file is not replaced', async () => {
    const { s, f, dir } = await mk(); await s.add('expense', 100, 'Food', 'a', day);
    const doc = JSON.parse(read(f('entries.json'))); doc.entries.push({ kind: 'tip', cents: 500, date: day, category: 'Cash' });
    fs.writeFileSync(f('entries.json'), JSON.stringify(doc)); bumpMtime(f('entries.json'));
    await s.tick(); expect(s.entries).toHaveLength(2);
    doc.entries.push({ kind: 'tip', cents: 600, date: day }); fs.writeFileSync(f('entries.json'), JSON.stringify(doc)); bumpMtime(f('entries.json'), 9);
    await s.add('expense', 7, 'Food', '', day); expect(s.entries).toHaveLength(4);
    fs.unlinkSync(f('entries.json')); await s.tick(); expect(s.entries).toHaveLength(4); expect(fs.existsSync(f('entries.json'))).toBe(false);
    await s.add('expense', 8, 'Food', '', day); expect(decodeMoneyFile(read(f('entries.json'))).entries).toHaveLength(5);
    expect(fs.readdirSync(dir).some((n) => n.includes('.tmp-'))).toBe(false);
  });
  it('same size, same second: the stamp still notices a replaced file (size + mtime)', async () => {
    const { s, f } = await mk(); await s.add('expense', 111, 'Food', '', day);
    const text = read(f('entries.json')).replace('111', '222'); fs.writeFileSync(f('entries.json'), text); bumpMtime(f('entries.json'), 3);
    await s.tick(); expect(s.entries[0].cents).toBe(222);
  });
  it('keeps unknown keys and a higher version through a save', async () => {
    const dir = tmpDir(); fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ version: 5, extra: { x: 1 }, settings: { future: true }, entries: [] }));
    const { s, f } = await mk({ dir }); await s.add('expense', 100, 'Food', '', day);
    const o = JSON.parse(read(f('entries.json'))); expect(o.version).toBe(5); expect(o.extra).toEqual({ x: 1 }); expect(o.settings.future).toBe(true);
  });
  it('stray temp files older than a minute are cleaned at start; fresh ones are kept', async () => {
    const dir = tmpDir(); const old = path.join(dir, '.entries.json.tmp-1-1'), fresh = path.join(dir, '.entries.json.tmp-2-2'), other = path.join(dir, 'notes.txt');
    for (const p of [old, fresh, other]) fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - 120_000); fs.utimesSync(old, t, t);
    await mk({ dir }); expect(fs.existsSync(old)).toBe(false); expect(fs.existsSync(fresh)).toBe(true); expect(fs.existsSync(other)).toBe(true);
  });
});

describe('rolling and daily backups', () => {
  it('entries.backup.json rolls only when entries change; settings taps leave it alone', async () => {
    const { s, f } = await mk(); expect(fs.existsSync(f('entries.backup.json'))).toBe(false);
    await s.add('expense', 100, 'Food', 'first', day); // old file = empty first-run file
    expect(decodeMoneyFile(read(f('entries.backup.json'))).entries).toHaveLength(0);
    await s.add('expense', 200, 'Food', 'second', day);
    expect(decodeMoneyFile(read(f('entries.backup.json'))).entries).toHaveLength(1);
    const b = read(f('entries.backup.json'));
    await s.updateSettings((x) => { x.theme = 'grape'; }); await s.setBudget('Food', 5000);
    expect(read(f('entries.backup.json'))).toBe(b);
  });
  it('a file that does not decode never replaces a good backup', async () => {
    const { s, f } = await mk(); await s.add('expense', 100, 'Food', '', day); await s.add('expense', 200, 'Food', '', day);
    const good = read(f('entries.backup.json'));
    fs.writeFileSync(f('entries.json'), '{ broken'); bumpMtime(f('entries.json'));
    await s.tick(); expect(s.loadError).toBeTruthy(); expect(read(f('entries.backup.json'))).toBe(good);
  });
  it('one daily backup: the first change of a local day only', async () => {
    const real = Civil_today();
    const { s, f, clock } = await mk({ start: real }); clock.ms = Date.now(); await s.add('expense', 100, 'Food', 'a', real);
    expect(fs.existsSync(f('entries.backup-daily.json'))).toBe(true);
    await s.add('expense', 200, 'Food', 'b', real);
    expect(decodeMoneyFile(read(f('entries.backup-daily.json'))).entries).toHaveLength(0); // still the first one of the day
    // another day: age the daily file by a day, then move the clock
    const old = new Date(Date.now() - 86400_000 * 2); fs.utimesSync(f('entries.backup-daily.json'), old, old);
    await s.add('expense', 300, 'Food', 'c', real);
    expect(decodeMoneyFile(read(f('entries.backup-daily.json'))).entries).toHaveLength(2);
  });
});
describe('daily backup and a clock that moved', () => {
  it('a daily backup dated in the future (the clock jumped back) is not rewritten on every save and keeps the older good snapshot', async () => {
    const real = Civil_today();
    const { s, f, clock } = await mk({ start: real }); clock.ms = Date.now();
    await s.add('expense', 100, 'Food', 'a', real); await s.add('expense', 200, 'Food', 'b', real);
    const snapshot = read(f('entries.backup-daily.json'));
    const future = new Date(Date.now() + 5 * 86400_000); fs.utimesSync(f('entries.backup-daily.json'), future, future);
    for (let i = 0; i < 5; i++) await s.add('expense', 300 + i, 'Food', 'later' + i, real);
    expect(read(f('entries.backup-daily.json'))).toBe(snapshot);
    // the day catches up: the next change after that day starts a new snapshot
    const past = new Date(Date.now() - 2 * 86400_000); fs.utimesSync(f('entries.backup-daily.json'), past, past);
    await s.add('expense', 999, 'Food', 'new day', real);
    expect(decodeMoneyFile(read(f('entries.backup-daily.json'))).entries.length).toBeGreaterThan(decodeMoneyFile(snapshot).entries.length);
  });
});
function Civil_today(): string { return new Date().toISOString().slice(0, 10); }

describe('categories and budgets in the store', () => {
  it('custom categories, debt reserved, orphans', async () => {
    const { s } = await mk();
    expect(await s.addCategory('  Coffee  ')).toEqual({ name: 'Coffee', error: null }); expect((await s.addCategory('coffee')).name).toBe('Coffee'); expect(s.settings.customCategories).toEqual(['Coffee']);
    expect(await s.addCategory('Debt-payment')).toEqual({ name: 'Debt payment', error: null }); expect(s.settings.customCategories).toEqual(['Coffee']);
    expect((await s.addCategory('   ')).error).toBe('Type a category name.'); expect((await s.addCategory('x'.repeat(31))).error).toContain('under 30');
    expect(s.expenseCategories().filter((c) => c === 'Debt payment')).toHaveLength(1);
    expect(await s.setBudget('Debt payment', 100)).toContain('Card payments'); expect(await s.setBudget('Coffee', 0)).toContain('more than zero'); expect(await s.setBudget('Coffee', 2000)).toBeNull();
    expect(s.activeBudgets()).toEqual({ Coffee: 2000 });
    await s.updateSettings((x) => { x.customCategories = []; });
    expect(s.activeBudgets()).toEqual({}); expect(s.orphanBudgets()).toEqual(['Coffee']); expect(s.budgetStatuses()).toEqual([]);
    await s.setBudget('Coffee', 2000); await s.addCategory('Coffee'); await s.removeCategory('Coffee'); expect(s.settings.budgets).toEqual({});
    await s.setBudget('Food', 1000); await s.removeCategory('Food'); expect(s.settings.budgets).toEqual({ Food: 1000 }); // built-in stays
  });
  it('settings are clamped and saved', async () => {
    const { s, f } = await mk(); await s.updateSettings((x) => { x.weekStart = 12; x.maxItems = 99; x.currencySymbol = ' € '; x.glass = 140; });
    expect(s.settings).toMatchObject({ weekStart: 7, maxItems: 30, currencySymbol: '€', glass: 100 }); expect(JSON.parse(read(f('entries.json'))).settings.weekStart).toBe(7);
  });
});

class FakeNotifier implements Notifier {
  sent: string[] = []; ok = true; asked = 0;
  async requestAuthorization() { this.asked++; }
  async send(title: string, body: string) { if (this.ok) this.sent.push(`${title}|${body}`); return this.ok; }
}
describe('budget alerts', () => {
  it('off by default; 80 then 100 once each; recorded only after delivery; failure retried once a minute later', async () => {
    const n = new FakeNotifier(); const { s, clock } = await mk({ notifier: n });
    await s.setBudget('Food', 10000); await s.add('expense', 8500, 'Food', '', day);
    await s.tick(); expect(n.sent).toEqual([]);
    await s.setBudgetNotify(true); expect(n.asked).toBe(1);
    n.ok = false; await s.tick(); await settle(); expect(n.sent).toEqual([]); expect(Object.keys(s.settings.budgetAlerts).filter((k) => !k.includes('|tries'))).toEqual([]);
    await s.tick(); await settle(); // within a minute: not retried
    n.ok = true; clock.ms += 61_000; await s.tick(); await settle();
    expect(n.sent).toHaveLength(1); expect(n.sent[0]).toContain('Budget heads-up'); expect(n.sent[0]).toContain('85%'); expect(s.settings.budgetAlerts).toEqual({ '2026-10|food': 80 });
    await s.tick(); await settle(); expect(n.sent).toHaveLength(1);
    await s.add('expense', 2000, 'Food', '', day); await s.tick(); await settle();
    expect(n.sent).toHaveLength(2); expect(n.sent[1]).toContain('Budget reached'); expect(n.sent[1]).toContain('over its monthly budget'); expect(s.settings.budgetAlerts['2026-10|food']).toBe(100);
  });
  it('only the current month is kept, and a clock that jumps back keeps the record', async () => {
    const n = new FakeNotifier(); const { s, clock } = await mk({ notifier: n });
    await s.setBudget('Food', 100000); await s.updateSettings((x) => { x.budgetNotify = true; x.budgetAlerts = { '2026-09|food': 100, '2026-10|food': 80 }; });
    await s.tick(); await settle(); expect(Object.keys(s.settings.budgetAlerts)).toEqual(['2026-10|food']);
    clock.ms = noon('2026-08-15'); await s.tick(); await settle(); expect(Object.keys(s.settings.budgetAlerts)).toEqual(['2026-10|food']);
  });
  it('a changed budget amount forgets the announced levels', async () => {
    const n = new FakeNotifier(); const { s } = await mk({ notifier: n });
    await s.setBudget('Food', 10000); await s.add('expense', 9000, 'Food', '', day); await s.setBudgetNotify(true); await s.tick(); await settle();
    expect(s.settings.budgetAlerts['2026-10|food']).toBe(80);
    await s.setBudget('Food', 20000); expect(s.settings.budgetAlerts).toEqual({});
  });
});
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('recurring in the store', () => {
  const rule = (o: Partial<RecurringRule> = {}): RecurringRule => ({ id: '0D0D0D0D-0000-4000-8000-000000000001', kind: 'expense', cents: 120000, category: 'Rent', note: ' monthly ', repeatKind: 'monthly', interval: 1, start: '2026-08-01', paused: true, ...o });
  it('addRule backfills, trims, ignores the paused/last of the form, caps at 100 rules', async () => {
    const { s } = await mk(); expect(await s.addRule(rule({ last: '2026-09-01' }))).toBeNull();
    expect(s.entries.map((e) => e.day).sort()).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']); expect(s.settings.recurring[0]).toMatchObject({ paused: false, last: '2026-10-01', note: 'monthly' });
    expect(await s.addRule(rule({ id: '0D0D0D0D-0000-4000-8000-000000000002', start: '2002-01-01' }))).toContain('more than 400 days');
    for (let i = 0; i < 99; i++) await s.addRule(rule({ id: `0E0E0E0E-0000-4000-8000-${String(i + 10).padStart(12, '0')}`, start: '2026-10-30' }));
    expect(s.settings.recurring).toHaveLength(100);
    expect(await s.addRule(rule({ id: '0F0F0F0F-0000-4000-8000-000000000001', start: '2026-10-30' }))).toContain('at most 100');
  });
  it('runs on launch, never re-adds a deleted entry, pause/resume skips the paused time, edit keeps history, delete with entries', async () => {
    const { s, clock, dir } = await mk(); await s.addRule(rule({ start: '2026-10-01' }));
    const id = s.entries[0].id; await s.delete(id); await s.tick(); expect(s.entries).toHaveLength(0);
    await s.setRulePaused(rule().id, true); clock.ms = noon('2026-12-20'); await s.tick(); expect(s.entries).toHaveLength(0);
    await s.setRulePaused(rule().id, false); expect(s.settings.recurring[0].last).toBe('2026-12-01'); await s.tick(); expect(s.entries).toHaveLength(0);
    clock.ms = noon('2027-01-02'); await s.tick(); expect(s.entries.map((e) => e.day)).toEqual(['2027-01-01']);
    expect(await s.updateRule({ ...rule({ start: '2026-10-01' }), cents: 130000, note: 'raised' })).toBeNull();
    expect(s.settings.recurring[0]).toMatchObject({ cents: 130000, last: '2027-01-01', paused: false }); expect(s.entries[0].cents).toBe(120000);
    expect(s.entryCount(rule().id)).toBe(1);
    // a fresh launch on the same file: nothing added twice
    const s2 = new MoneyStore({ io: nodeIO(dir), nowProvider: clock.now, timeZone: 'UTC' }); await s2.init(); expect(s2.entries).toHaveLength(1);
    await s.add('expense', 5, 'Food', 'by hand', '2027-01-02'); await s.deleteRuleAndEntries(rule().id);
    expect(s.settings.recurring).toEqual([]); expect(s.entries.map((e) => e.note)).toEqual(['by hand']);
    expect(await s.updateRule(rule())).toContain('gone'); expect(await s.setRulePaused(rule().id, true)).toContain('gone');
  });
  it('deleting a rule keeps its entries', async () => {
    const { s } = await mk(); await s.addRule(rule({ start: '2026-10-01' })); await s.deleteRule(rule().id); expect(s.entries).toHaveLength(1); expect(s.settings.recurring).toEqual([]);
  });
});

describe('sample data and derived values', () => {
  it('load and clear sample leave hand entries; the report and glance work on it', async () => {
    const { s } = await mk(); await s.add('expense', 100, 'Food', 'mine', day);
    await s.loadSample(); expect(s.hasSample).toBe(true); const n = s.entries.length; await s.loadSample(); expect(s.entries.length).toBe(n);
    expect(s.entries.filter((e) => e.sample).every((e) => e.note !== 'mine')).toBe(true);
    expect(s.report({ kind: 'month' }).totals.spent).toBeGreaterThan(0); expect(s.glance().days).toBe(6);
    await s.clearSample(); expect(s.entries.map((e) => e.note)).toEqual(['mine']); expect(s.hasSample).toBe(false);
  });
  it('the published day changes only when the day does (and for a zone change)', async () => {
    const { s, clock } = await mk(); let n = 0; s.subscribe(() => n++); await s.tick(); await s.tick(); expect(n).toBe(0);
    clock.ms += 86400_000; await s.tick(); expect(n).toBe(1); expect(s.todayKey).toBe('2026-10-07');
  });
});

describe('lost updates: compare-and-swap writes and re-applying the change', () => {
  it('two stores on one file, 25 adds each, interleaved: nothing is lost', async () => {
    const dir = tmpDir(); const clock = new Clock(noon(day));
    const mkStore = async () => { const s = new MoneyStore({ io: nodeIO(dir), nowProvider: clock.now, timeZone: 'UTC' }); await s.init(); return s; };
    const a = await mkStore(), b = await mkStore();
    const jobs: Promise<string | null>[] = [];
    for (let i = 0; i < 25; i++) { jobs.push(a.add('expense', 100 + i, 'Food', `a${i}`, day)); jobs.push(b.add('expense', 200 + i, 'Fun', `b${i}`, day)); }
    expect((await Promise.all(jobs)).filter((r) => r !== null)).toEqual([]);
    const text = fs.readFileSync(path.join(dir, 'entries.json'), 'utf8');
    const notes = decodeMoneyFile(text).entries.map((e) => e.note).sort();
    expect(notes).toEqual([...Array.from({ length: 25 }, (_, i) => `a${i}`), ...Array.from({ length: 25 }, (_, i) => `b${i}`)].sort());
  });
  it('an external writer that appends entries between the read and the write loses nothing either way', async () => {
    const { s, f, io } = await mk(); await s.add('expense', 100, 'Food', 'mine-1', day);
    // another process appends an entry after this app's last read, then this app adds (the write sees a changed stamp)
    const doc = JSON.parse(read(f('entries.json'))); doc.entries.push({ kind: 'tip', cents: 777, date: day, category: 'Cash', note: 'external' });
    const w = io.write.bind(io); let first = true;
    io.write = async (n, t, e) => { if (first && n === 'entries.json') { first = false; fs.writeFileSync(f('entries.json'), JSON.stringify(doc)); bumpMtime(f('entries.json'), 3); } return w(n, t, e); };
    expect(await s.add('expense', 300, 'Food', 'mine-2', day)).toBeNull();
    expect(decodeMoneyFile(read(f('entries.json'))).entries.map((e) => e.note).sort()).toEqual(['external', 'mine-1', 'mine-2']);
    expect(s.entries).toHaveLength(3);
  });
  it('a second conflict in a row is reported and the change is not half-applied', async () => {
    const { s, f, io } = await mk(); await s.add('expense', 100, 'Food', 'one', day);
    const w = io.write.bind(io); let n = 0;
    io.write = async (name, t, e) => { if (name === 'entries.json' && n++ < 2) { fs.appendFileSync(f('entries.json'), ' '); bumpMtime(f('entries.json'), 4 + n); } return w(name, t, e); };
    expect(await s.add('expense', 200, 'Food', 'two', day)).toContain('keeps changing');
    expect(s.entries.map((e) => e.note)).toEqual(['one']);
  });
  it('the stamp includes the inode and ctime: a same-size, same-mtime replacement is a conflict', async () => {
    const { s, f } = await mk(); await s.add('expense', 111, 'Food', 'x', day);
    const text = read(f('entries.json')); const st = fs.statSync(f('entries.json'));
    fs.writeFileSync(f('entries.json') + '.new', text.replace('111', '222')); fs.renameSync(f('entries.json') + '.new', f('entries.json')); fs.utimesSync(f('entries.json'), st.atime, st.mtime);
    expect(await s.add('expense', 5, 'Food', 'y', day)).toBeNull();
    expect(s.entries.find((e) => e.note === 'x')?.cents).toBe(222);
  });
});

describe('every read is inside a try', () => {
  it('UTF-16 and other non-UTF-8 text, a BOM, a fifo-like error: a named load error, never an overwrite, never a rejection', async () => {
    const dir = tmpDir(); const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"entries":[]}', 'utf16le')]);
    fs.writeFileSync(path.join(dir, 'entries.json'), raw);
    const io = nodeIO(dir); const r = io.read.bind(io);
    io.read = async (n) => { const t = await r(n); if (t !== null && t.includes('�')) throw new Error('entries.json is not valid UTF-8 text: save it again as UTF-8'); return t; };
    const s = new MoneyStore({ io, nowProvider: new Clock(noon(day)).now, timeZone: 'UTC' });
    await expect(s.init()).resolves.toBeUndefined();
    expect(s.loadError).toContain('UTF-8'); expect(await s.add('expense', 100, 'Food', '', day)).toContain('cannot be read');
    expect(fs.readFileSync(path.join(dir, 'entries.json')).equals(raw)).toBe(true);
    await expect(s.tick()).resolves.toBeUndefined();
  });
  it('a BOM at the start of a valid file is accepted', async () => {
    const dir = tmpDir(); fs.writeFileSync(path.join(dir, 'entries.json'), '﻿{"entries":[{"kind":"tip","cents":5,"date":"2026-10-06"}]}');
    const { s } = await mk({ dir }); expect(s.loadError).toBeNull(); expect(s.entries).toHaveLength(1);
  });
  it('io failures in tick and in every action become messages, not rejections', async () => {
    const { s, io } = await mk();
    const stat = io.stat.bind(io); io.stat = async () => { throw new Error('stat exploded'); };
    await expect(s.tick()).resolves.toBeUndefined(); expect(s.saveError).toContain('stat exploded');
    expect(await s.add('expense', 100, 'Food', '', day)).toContain('stat exploded');
    io.stat = stat;
  });
});
