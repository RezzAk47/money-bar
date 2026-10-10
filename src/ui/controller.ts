// Wires the pure core to a Backend: the store, the 2 second tick and the tray label.
import type { Backend } from '../backend/types';
import { MoneyStore } from '../core/store';
import type { Entry } from '../core/model';
import { errMessage } from '../core/io';

export const UNDO_MS = 8000;

export class Controller {
  store: MoneyStore;
  private lastLabel = '';
  private listeners = new Set<() => void>();
  private offTick: () => void;
  private ticking = false;
  /** The entry deleted last, offered back for UNDO_MS. */
  undo: Entry | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(public backend: Backend) {
    this.store = new MoneyStore({ io: backend.io, nowProvider: backend.now, timeZone: backend.timeZone, notifier: backend.notifier ?? undefined });
    this.store.subscribe(() => { this.emit(); this.pushLabel(); });
    this.offTick = backend.onTick(() => { void this.tick(); });
  }
  async init(): Promise<void> { await this.store.init(); this.pushLabel(); this.emit(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(): void { for (const l of [...this.listeners]) l(); }
  dispose(): void { this.offTick(); }
  /** One tick at a time (a slow disk must not pile ticks up), and a failure is shown, never thrown. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.store.tick(); this.pushLabel(); } catch (e) { this.store.reportError(e); } finally { this.ticking = false; }
  }
  /** Deletes an entry and keeps it for an 8 second Undo. Resolves to an error message or null. */
  async deleteEntry(e: Entry): Promise<string | null> {
    const err = await this.store.delete(e.id);
    if (err === null) { this.undo = e; if (this.undoTimer) clearTimeout(this.undoTimer); this.undoTimer = setTimeout(() => { this.undo = null; this.undoTimer = null; this.emit(); }, UNDO_MS); this.emit(); }
    return err;
  }
  async undoDelete(): Promise<string | null> {
    const e = this.undo;
    if (!e) return null;
    this.undo = null; if (this.undoTimer) { clearTimeout(this.undoTimer); this.undoTimer = null; }
    const err = await this.store.restore(e);
    this.emit();
    return err;
  }
  /**
   * Opt-in self test (MONEYBAR_SELFTEST=1, never on by default, only with a data dir override): 50 sequential adds through the real
   * file commands with no outside writer. Every one must save without a single compare-and-swap conflict. The result goes to the
   * tray label (the Rust side prints it to stderr when the variable is set).
   */
  async runSelfTest(): Promise<void> {
    const before = this.store.conflicts;
    let failed = 0;
    for (let i = 0; i < 50; i++) {
      const err = await this.store.add(i % 3 === 0 ? 'income' : 'expense', 100 + i, i % 3 === 0 ? 'Job' : 'Food', `selftest ${i}`, this.store.todayKey);
      if (err !== null) failed++;
      if (i % 10 === 9) await this.store.tick();
    }
    const msg = `SELFTEST saves=50 failed=${failed} conflicts=${this.store.conflicts - before} saveError=${this.store.saveError ?? 'none'} loadError=${this.store.loadError ?? 'none'} entries=${this.store.entries.length}`;
    await this.backend.setTrayLabel(msg).catch(() => {});
  }
  /** Shows any error from outside the store (a rejected promise from a UI action). */
  reportError(e: unknown): void { this.store.reportError(errMessage(e)); }
  /** Tray text: the menu bar mode chosen in the header ("+$86.76 today"), cut to 46 characters. */
  label(): string { return this.store.menuText.slice(0, 46); }
  private pushLabel(): void {
    const l = this.label();
    if (l !== this.lastLabel) { this.lastLabel = l; void this.backend.setTrayLabel(l).catch(() => {}); }
  }
}
