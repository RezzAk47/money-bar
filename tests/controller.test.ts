import { describe, expect, it, vi } from 'vitest';
import { Controller, UNDO_MS } from '../src/ui/controller';
import type { Backend } from '../src/backend/types';
import { MoneyStore, MAX_ALERT_TRIES } from '../src/core/store';
import type { Notifier } from '../src/core/store';
import { Clock, nodeIO, noon, tmpDir } from './helpers';

const day = '2026-10-06';
function backend(over: Partial<Backend> = {}): Backend & { labels: string[]; io: ReturnType<typeof nodeIO> } {
  const labels: string[] = [];
  const io = nodeIO(tmpDir());
  return { kind: 'browser', platform: 'linux', io, dataDir: io.dir, timeZone: 'UTC', now: new Clock(noon(day)).now, notifier: null, labels,
    async setTrayLabel(l: string) { labels.push(l); }, async hide() {}, holdOpen() {}, async quit() {}, async revealData() {}, autostart: null, onTick: () => () => {}, onShown: () => () => {},
    async exportCsv() { return { ok: true }; }, trayNote: null, ...over } as never;
}

describe('controller', () => {
  it('tick never overlaps and never throws; a failing disk becomes a message', async () => {
    const b = backend(); const c = new Controller(b); await c.init();
    let running = 0, max = 0; const stat = b.io.stat.bind(b.io);
    b.io.stat = async (n) => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 30)); try { return await stat(n); } finally { running--; } };
    await Promise.all([c.tick(), c.tick(), c.tick()]);
    expect(max).toBe(1);
    b.io.stat = async () => { throw new Error('disk gone'); };
    await expect(c.tick()).resolves.toBeUndefined();
    expect(c.store.saveError).toContain('disk gone');
  });
  it('the tray label follows the store (the menu bar text mode)', async () => {
    const b = backend(); const c = new Controller(b); await c.init();
    await c.store.add('income', 5000, 'Job', '', day); expect(b.labels.at(-1)).toBe('+$50 today');
    await c.store.updateSettings((s) => { s.menuBar = 'todayEarned'; }); expect(b.labels.at(-1)).toBe('$50 earned');
  });
  it('delete keeps the entry for 8 seconds of Undo, then forgets it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const b = backend(); const c = new Controller(b); await c.init();
      await c.store.add('expense', 1234, 'Food', 'lunch', day); const e = c.store.entries[0];
      expect(await c.deleteEntry(e)).toBeNull(); expect(c.store.entries).toHaveLength(0); expect(c.undo?.id).toBe(e.id);
      expect(await c.undoDelete()).toBeNull(); expect(c.store.entries.map((x) => x.id)).toEqual([e.id]); expect(c.undo).toBeNull();
      await c.deleteEntry(e); vi.advanceTimersByTime(UNDO_MS + 10); expect(c.undo).toBeNull();
      expect(await c.undoDelete()).toBeNull(); expect(c.store.entries).toHaveLength(0);
      // restoring twice never duplicates
      await c.store.restore(e); await c.store.restore(e); expect(c.store.entries).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

class Fake implements Notifier {
  sent: { title: string; body: string }[] = []; ok = true;
  async requestAuthorization() {}
  async send(title: string, body: string) { if (this.ok) this.sent.push({ title, body }); return this.ok; }
}
const settle = () => new Promise((r) => setTimeout(r, 30));
async function storeWith(n: Fake, categories: string[], spend: number) {
  const clock = new Clock(noon(day));
  const s = new MoneyStore({ io: nodeIO(tmpDir()), nowProvider: clock.now, timeZone: 'UTC', notifier: n }); await s.init();
  for (const c of categories) { await s.addCategory(c); await s.setBudget(c, 10000); await s.add('expense', spend, c, '', day); }
  await s.setBudgetNotify(true);
  return { s, clock };
}
describe('budget alert bursts', () => {
  it('more than three at once become ONE summary, recorded once', async () => {
    const n = new Fake(); const { s } = await storeWith(n, ['A1', 'B2', 'C3', 'D4', 'E5'], 12000);
    await s.tick(); await settle();
    expect(n.sent).toHaveLength(1); expect(n.sent[0].title).toBe('Budgets need attention'); expect(n.sent[0].body).toContain('5 budgets');
    expect(Object.keys(s.settings.budgetAlerts)).toHaveLength(5);
    await s.tick(); await settle(); expect(n.sent).toHaveLength(1);
  });
  it('three or fewer are sent one by one', async () => {
    const n = new Fake(); const { s } = await storeWith(n, ['A1', 'B2', 'C3'], 12000);
    await s.tick(); await settle(); expect(n.sent).toHaveLength(3); expect(n.sent.every((m) => m.title === 'Budget reached')).toBe(true);
  });
  it('a failed summary stays unsent, is retried a minute later, and gives up after three tries per launch', async () => {
    const n = new Fake(); n.ok = false; const { s, clock } = await storeWith(n, ['A1', 'B2', 'C3', 'D4'], 12000);
    for (let i = 0; i < MAX_ALERT_TRIES + 2; i++) { await s.tick(); await settle(); clock.ms += 61_000; }
    expect(n.sent).toHaveLength(0); expect(Object.keys(s.settings.budgetAlerts).filter((k) => !k.includes('|tries'))).toEqual([]);
    n.ok = true; clock.ms += 61_000; await s.tick(); await settle();
    expect(n.sent).toHaveLength(0); // gave up for this launch (three tries)
  });
});

describe('failed alert tries are saved in the alert record', () => {
  it('three tries across restarts, then no more; switching notifications on again resets them', async () => {
    const dir = tmpDir(); const clock = new Clock(noon(day));
    const n = new Fake(); n.ok = false;
    const open = async () => { const s = new MoneyStore({ io: nodeIO(dir), nowProvider: clock.now, timeZone: 'UTC', notifier: n }); await s.init(); return s; };
    let s = await open();
    await s.addCategory('Fun2'); await s.setBudget('Fun2', 10000); await s.add('expense', 9000, 'Fun2', '', day); await s.setBudgetNotify(true);
    for (let launch = 1; launch <= 3; launch++) {
      if (launch > 1) s = await open();
      await s.tick(); await settle();
      expect(s.settings.budgetAlerts['2026-10|fun2|tries80']).toBe(launch);
      clock.ms += 61_000;
    }
    n.ok = true; s = await open(); await s.tick(); await settle();
    expect(n.sent).toHaveLength(0); // three tries are used up: a fourth launch does not try
    expect(s.settings.budgetAlerts['2026-10|fun2|tries80']).toBe(3);
    await s.setBudgetNotify(false); await s.setBudgetNotify(true); clock.ms += 61_000;
    await s.tick(); await settle();
    expect(n.sent).toHaveLength(1); expect(s.settings.budgetAlerts['2026-10|fun2']).toBe(80); expect(s.settings.budgetAlerts['2026-10|fun2|tries80']).toBeUndefined();
    // a changed budget amount forgets the tries too
    await s.setBudget('Fun2', 20000); expect(Object.keys(s.settings.budgetAlerts)).toEqual([]);
  });
});

describe('opt-in self test', () => {
  it('50 saves with no outside writer: 0 conflicts, 0 failures, label reported', async () => {
    const b = backend(); const c = new Controller(b); await c.init();
    await c.runSelfTest();
    const msg = b.labels.at(-1)!;
    expect(msg).toContain('SELFTEST saves=50 failed=0 conflicts=0 saveError=none loadError=none entries=50');
  });
});
