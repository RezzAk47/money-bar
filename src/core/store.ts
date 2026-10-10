// The money store: loads, edits and saves entries.json (a port of MoneyStore in Model.swift) with the same safety rules:
// an unreadable file is never overwritten, a file changed outside the app is reloaded before every edit, a file that
// vanishes is not replaced by anything, keys this app does not know are written back, a rolling backup is kept only when
// entries change plus one daily backup, and a budget alert is recorded as sent only after it was delivered.
import * as Civil from './civil';
import { BACKUP_FILE, DAILY_BACKUP_FILE, ENTRIES_FILE } from './datadir';
import { FileIO, FileStamp, Queue, errMessage, isConflict, sameStamp } from './io';
import { DecodeError, Extra, newId } from './json';
import { MAX_CENTS, formatMoney, moneyMessage } from './money';
import {
  DEBT_PAYMENT, EXPENSE_CATEGORIES, INCOME_SOURCES, MAX_CATEGORY_LENGTH, cleanCategory, isDebtName, normalize, sameName, strip,
} from './categories';
import type { Kind } from './categories';
import {
  CURRENT_VERSION, Entry, MoneyFile, Settings, decodeMoneyFile, defaultSettings, encodeMoneyFile, normalizeSettings, recentFirst,
  setBudgetIn, uniqueIds, validateEntry,
} from './model';
import {
  BudgetStatus, DayRange, Glance, Period, Report, alertLevel, budgetLevel, budgetMessage, budgetPercent, budgetStatuses, makeGlance,
  makeReport, quad, rangeContaining, shifted,
} from './reports';
import type { Quad } from './reports';
import { MAX_RULES, applyRules, cleanRule, due, latest, validateRule } from './recurring';
import type { RecurringRule } from './recurring';
import { sampleEntries } from './sample';
import { summaryText } from './summary';

/** Where budget alerts go. The real one is made in the Tauri backend; tests use a fake and never fire a real notification. */
export interface Notifier {
  requestAuthorization(): Promise<void>;
  /** Resolves true when the notification was delivered, false when it could not be (permission denied, system error). */
  send(title: string, body: string, id: string): Promise<boolean>;
}
export const nullNotifier: Notifier = { async requestAuthorization() {}, async send() { return true; } };

export interface StoreOptions {
  io: FileIO;
  nowProvider?: () => number;
  /** IANA zone for "today" (default: the system zone). */
  timeZone?: string;
  notifier?: Notifier;
}
export interface Draft { entries: Entry[]; settings: Settings }

export const ALERT_RETRY_MS = 60_000;
/** A failed delivery is retried twice more (three tries in all) per launch, a minute apart. */
export const MAX_ALERT_TRIES = 3;
/** More than this many alerts due at once are sent as one summary. */
export const SUMMARY_OVER = 3;
const triesKey = (key: string, level: number): string => `${key}|tries${level}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class MoneyStore {
  entries: Entry[] = [];
  settings: Settings = defaultSettings();
  /** Set when entries.json exists but cannot be read. While set, nothing is ever written to the file. */
  loadError: string | null = null;
  saveError: string | null = null;
  now: number;
  notifier: Notifier;
  fileVersion = CURRENT_VERSION;
  /** How many times a save found the file changed underneath it (compare-and-swap conflicts), for the opt-in self test. */
  conflicts = 0;

  private io: FileIO;
  private nowProvider: () => number;
  private tz: string | undefined;
  private lastStamp: FileStamp | null | undefined = undefined;
  private extraTop: Extra | undefined;
  private extraSettings: Extra | undefined;
  private persistedText: string | null = null;
  /** True once entries.json was decoded or written by this store: from then on a missing file is never a first run. */
  private loaded = false;
  private rev = 0;
  private dirty = false;
  private queue = new Queue();
  private listeners = new Set<() => void>();
  private memo = new Map<string, { rev: number; key: string; value: unknown }>();
  private catMemo: { custom: string; value: string[] } | null = null;
  private alertsInFlight = new Set<string>();
  private alertTries = new Map<string, { count: number; at: number }>();
  private publishedDay: string;

  constructor(opts: StoreOptions) {
    this.io = opts.io;
    this.nowProvider = opts.nowProvider ?? Date.now;
    this.tz = opts.timeZone;
    this.notifier = opts.notifier ?? nullNotifier;
    this.now = this.nowProvider();
    this.publishedDay = this.dayOf(this.now);
  }

  /** Reads the file. Call once after construction. */
  init(): Promise<void> {
    return this.queue.run(async () => {
      try {
        try { await this.io.removeStrayTemps(60); } catch { /* best effort */ }
        await this.load();
        await this.runRecurringInner(); // on launch: add what came due while the app was closed
      } catch (e) { this.fail(e); }
      this.flush();
    });
  }
  /** Any failure becomes a message on screen, never an unhandled rejection. */
  private fail(e: unknown): void { this.saveError = errText(e); this.touch(); }
  /** Shows an error from outside the store (a guarded tick, a UI action). */
  reportError(e: unknown): void { this.fail(e); this.flush(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private touch() { this.rev++; this.dirty = true; }
  private flush() { if (this.dirty) { this.dirty = false; for (const l of [...this.listeners]) l(); } }
  private dayOf(ms: number): string { return Civil.dayKeyAt(ms, this.tz); }

  // ---- derived values, cached until the entries or settings change

  private cached<T>(name: string, key: string, make: () => T): T {
    const m = this.memo.get(name);
    if (m && m.rev === this.rev && m.key === key) return m.value as T;
    const value = make();
    this.memo.set(name, { rev: this.rev, key, value });
    return value;
  }
  get todayKey(): string { return this.dayOf(this.now); }
  get today(): Quad { const k = this.todayKey; return this.cached('today', k, () => quad(this.entries.filter((e) => e.day === k))); }
  get menuText(): string {
    const k = this.todayKey;
    return this.cached('menu', `${k}|${this.settings.menuBar}|${this.settings.currencySymbol}`, () => this.loadError !== null ? 'entries.json?' : summaryText(this.settings.menuBar, this.entries, k, this.settings.currencySymbol));
  }
  get recent(): Entry[] { return this.cached('recent', '', () => [...this.entries].sort(recentFirst)); }
  get hasSample(): boolean { return this.cached('sample', '', () => this.entries.some((e) => e.sample)); }
  money(c: number, compact = false, sign = false): string { return formatMoney(c, this.settings.currencySymbol, compact, sign); }
  expenseCategories(): string[] {
    const key = JSON.stringify(this.settings.customCategories);
    if (this.catMemo && this.catMemo.custom === key) return this.catMemo.value;
    const value = merged([...EXPENSE_CATEGORIES], this.settings.customCategories);
    this.catMemo = { custom: key, value };
    return value;
  }
  incomeSources(): string[] { return merged(INCOME_SOURCES, []); }
  report(period: Period, anchor: string = this.todayKey): Report {
    const range = rangeContaining(period, anchor, this.settings.weekStart);
    const prev = shifted(period, range, -1, this.settings.weekStart);
    return this.cached('report', `${range.start}|${range.end}|${prev.start}|${prev.end}`, () => makeReport(this.entries, range, prev));
  }
  /** Budgets of categories that are in the category list. A budget whose custom category was removed is an orphan. */
  activeBudgets(): Record<string, number> {
    const cats = this.expenseCategories();
    return Object.fromEntries(Object.entries(this.settings.budgets).filter(([k]) => cats.some((c) => sameName(c, k))));
  }
  orphanBudgets(): string[] {
    const cats = this.expenseCategories();
    return Object.keys(this.settings.budgets).filter((k) => !cats.some((c) => sameName(c, k))).sort(cmp);
  }
  /** Budget progress for the month containing `anchor` (default: today). */
  budgetStatuses(anchor?: string): BudgetStatus[] {
    const range = rangeContaining({ kind: 'month' }, anchor ?? this.dayOf(this.nowProvider()), this.settings.weekStart);
    const active = this.activeBudgets();
    const key = `${range.start}|${range.end}|` + Object.entries(active).sort((a, b) => cmp(a[0], b[0])).map(([k, v]) => `${k}=${v}`).join(';');
    return this.cached('budgets', key, () => budgetStatuses(this.entries, active, range));
  }
  /** This month so far against the same days of last month. */
  glance(anchor?: string): Glance {
    const today = this.dayOf(this.nowProvider());
    const range = rangeContaining({ kind: 'month' }, anchor ?? today, this.settings.weekStart);
    return this.cached('glance', `${range.start}|${today}`, () => makeGlance(this.entries, range, today));
  }
  get monthRange(): DayRange { return rangeContaining({ kind: 'month' }, this.todayKey, this.settings.weekStart); }

  // ---- clock and file watching

  tick(): Promise<void> {
    return this.queue.run(async () => {
      try {
        const current = this.nowProvider();
        const day = this.dayOf(current);
        if (day !== this.publishedDay) { this.publishedDay = day; this.now = current; this.touch(); } // only a new day (or zone) changes anything on screen
        await this.reloadIfChanged();
        await this.runRecurringInner();
        this.checkBudgetAlerts();
      } catch (e) { this.fail(e); }
      this.flush();
    });
  }
  /** Picks up edits made outside the app. A file that vanishes is NOT replaced by anything: memory stays, the next save writes it back. */
  private async reloadIfChanged(): Promise<void> {
    const stamp = await this.io.stat(ENTRIES_FILE);
    if (this.lastStamp !== undefined && sameStamp(stamp, this.lastStamp)) return;
    if (stamp === null) { this.lastStamp = stamp; return; }
    await this.load();
  }

  // ---- persistence

  private async load(): Promise<void> {
    let stamp: FileStamp | null, text: string | null;
    try {
      stamp = await this.io.stat(ENTRIES_FILE); // taken BEFORE reading, so a write during the read is seen next tick
      text = stamp === null ? null : await this.io.read(ENTRIES_FILE);
    } catch (e) {
      // not readable at all (UTF-16 or other non-UTF-8 text, not a regular file, too large, a refused link): reported by name, never overwritten
      this.entries = []; this.loadError = errText(e); this.lastStamp = undefined; this.touch();
      return;
    }
    if (text === null && this.loaded && this.loadError === null) {
      // The file was read before and is gone now (a sync tool replacing it by delete + create, read in the gap by a conflict
      // retry): as in reloadIfChanged, memory stays and the next save writes it back. Never an empty restart over real data.
      this.lastStamp = null;
      return;
    }
    if (text === null) {
      // First run only: start empty and create the file.
      this.entries = []; this.settings = defaultSettings(); this.loadError = null; this.extraTop = this.extraSettings = undefined; this.persistedText = null;
      this.lastStamp = null; // the file must still not exist when it is created
      this.touch();
      await this.save();
      return;
    }
    try {
      const file = decodeMoneyFile(text, this.tz);
      this.entries = uniqueIds(file.entries);
      this.settings = file.settings;
      this.loadError = null;
      this.persistedText = entriesText(file.entries);
      this.fileVersion = file.version;
      this.extraTop = file.extraTop; this.extraSettings = file.extraSettings;
      this.loaded = true;
    } catch (e) {
      this.entries = []; // the settings in memory stay
      this.loadError = e instanceof DecodeError ? e.message : `entries.json could not be read (${(e as Error).message})`;
    }
    this.lastStamp = stamp;
    this.touch();
  }

  private serialize(): string {
    return encodeMoneyFile({ version: Math.max(this.fileVersion, CURRENT_VERSION), settings: this.settings, entries: this.entries, extraTop: this.extraTop, extraSettings: this.extraSettings });
  }

  /** True when written, false when it could not be, 'conflict' when somebody else wrote the file since this app last read it. */
  async save(): Promise<boolean | 'conflict'> {
    if (this.loadError !== null) return false;
    const text = entriesText(this.entries);
    const out = this.serialize();
    try {
      // Rolling backup: keep the last file that decoded fine before replacing it, but only when the entries are about to
      // change (a settings tap leaves the backup alone). A failed backup never stops the save, and a file that does not
      // decode never replaces a good backup. A file exactly as this app last loaded or wrote it is known good.
      if (this.persistedText !== text) await this.backupOld();
      // compare-and-swap: the write goes through only if the file still has the stamp this app last saw (undefined: never read)
      await this.io.write(ENTRIES_FILE, out, this.lastStamp);
    } catch (e) {
      if (isConflict(e)) { this.conflicts++; return 'conflict'; }
      // The reply can fail after the file was replaced (the 5 second limit on a slow disk, a lost reply). If the file now holds
      // exactly this save, it happened: reporting a failure would undo it on screen while it is on disk, and a second Add would
      // then add it twice.
      if (!(await this.landed(out))) {
        try { await this.io.removeStrayTemps(0); } catch { /* ignore */ }
        this.saveError = errText(e);
        this.dirty = true;
        return false;
      }
    }
    // Written. A failed stat afterwards does not undo that: an unknown stamp makes the next edit read the file again first.
    try { this.lastStamp = await this.io.stat(ENTRIES_FILE); } catch { this.lastStamp = undefined; }
    this.persistedText = text;
    this.saveError = null;
    this.loaded = true;
    this.dirty = true;
    return true;
  }
  private async landed(out: string): Promise<boolean> {
    try { return (await this.io.read(ENTRIES_FILE)) === out; } catch { return false; }
  }
  private async backupOld(): Promise<void> {
    try {
      const old = await this.io.read(ENTRIES_FILE);
      if (old === null) return;
      const known = this.lastStamp !== undefined && this.lastStamp !== null && sameStamp(this.lastStamp, await this.io.stat(ENTRIES_FILE));
      if (!known) { try { decodeMoneyFile(old, this.tz); } catch { return; } }
      await this.io.write(BACKUP_FILE, old);
      // The daily backup takes the same good file, but only the first time entries change on a local day.
      const st = await this.io.stat(DAILY_BACKUP_FILE);
      // Only when the backup is older than today: one dated in the future (the clock jumped back) is left alone, so it is neither
      // rewritten on every save nor replaced by a newer file while the older good snapshot is still the one to keep.
      if (st === null || this.dayOf(Math.floor(st.mtimeUs / 1000)) < this.dayOf(this.nowProvider())) await this.io.write(DAILY_BACKUP_FILE, old);
    } catch { /* a failed backup never stops the save */ }
  }

  /** Keeps the unreadable file under a unique backup name, then starts again with an empty list. */
  startOver(): Promise<void> {
    return this.queue.run(async () => { try {
      await this.load();
      if (this.loadError === null) { this.flush(); return; } // fixed in the meantime: leave it alone
      const backup = `entries.broken-${Date.now()}-${Math.random().toString(36).slice(2, 8).replace(/[^0-9a-z]/g, 'x')}.json`;
      try { await this.io.moveAside(ENTRIES_FILE, backup); } catch (e) {
        this.saveError = `Could not keep a backup, so nothing was changed: ${errText(e)}`;
        this.touch(); this.flush();
        return;
      }
      this.loadError = null; this.entries = []; this.settings = defaultSettings();
      this.extraTop = this.extraSettings = undefined; this.persistedText = null; this.lastStamp = null;
      this.touch();
      await this.save();
      this.flush();
    } catch (e) { this.fail(e); this.flush(); } });
  }

  // ---- editing. Every change reloads first, so a hand edit is never overwritten by a click.

  /** Runs `change` on a fresh copy of the file. Resolves to an error message, or null on success. */
  private mutate(change: (d: Draft) => string | null): Promise<string | null> {
    return this.queue.run(async () => {
      let r: string | null;
      try { r = await this.mutateInner(change); } catch (e) { this.fail(e); r = `Could not save: ${errText(e)}`; }
      this.flush();
      return r;
    });
  }
  /**
   * Reload, apply the change to the fresh copy, save with a compare-and-swap. If another writer got in between the read and the
   * write (a conflict), the file is read again and the change is applied once more to what is there now, so nothing either side
   * did is lost; a second conflict in a row is reported.
   */
  private async mutateInner(change: (d: Draft) => string | null): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 0) await this.reloadIfChanged(); else await this.load(); // a conflict: read what is on disk now
      if (this.loadError !== null) return 'entries.json cannot be read, so nothing was saved. See the message above.';
      const before = { entries: this.entries, settings: this.settings };
      const draft: Draft = { entries: [...this.entries], settings: structuredClone(this.settings) };
      const problem = change(draft);
      if (problem !== null) return problem;
      this.entries = draft.entries; this.settings = draft.settings;
      this.touch();
      const saved = await this.save();
      if (saved === true) return null;
      // Not saved: undo the change in memory too, so the screen matches the file and pressing Add again does not add twice.
      this.entries = before.entries; this.settings = before.settings;
      this.touch();
      if (saved === 'conflict' && attempt === 0) continue;
      if (saved === 'conflict') return 'Could not save: the file keeps changing underneath this app. Try again.';
      return `Could not save: ${this.saveError ?? 'unknown error'}`;
    }
    return 'Could not save.';
  }

  add(kind: Kind, cents: number, category: string, note: string, day: string, sample = false): Promise<string | null> {
    const cleanNote = strip(note);
    const bad = validateEntry(cents, cleanNote, day, this.tz);
    if (bad) return Promise.resolve(bad);
    const cat = cleanCategory(kind, category);
    return this.mutate((d) => { d.entries.push({ id: newId(), kind, cents, category: cat, note: cleanNote, day, created: Math.floor(this.nowProvider() / 1000), sample }); return null; });
  }
  update(id: string, kind: Kind, cents: number, category: string, note: string, day: string): Promise<string | null> {
    const cleanNote = strip(note);
    const bad = validateEntry(cents, cleanNote, day, this.tz);
    if (bad) return Promise.resolve(bad);
    const cat = cleanCategory(kind, category);
    return this.mutate((d) => {
      const i = d.entries.findIndex((e) => e.id === id);
      if (i < 0) return 'That entry is gone (it was changed outside the app).';
      d.entries[i] = { ...d.entries[i], kind, cents, category: cat, note: cleanNote, day, sample: false };
      return null;
    });
  }
  /** Puts a deleted entry back (the Undo of a delete); nothing happens if its id exists again. */
  restore(entry: Entry): Promise<string | null> {
    return this.mutate((d) => { if (!d.entries.some((e) => e.id === entry.id)) d.entries.push(entry); return null; });
  }
  delete(id: string): Promise<string | null> { return this.mutate((d) => { d.entries = d.entries.filter((e) => e.id !== id); return null; }); }

  /** Resolves to the (existing or new) category name, and an error message when there is one. */
  async addCategory(raw: string): Promise<{ name: string; error: string | null }> {
    if (strip(raw) === '') return { name: '', error: 'Type a category name.' };
    if (isDebtName(raw)) return { name: DEBT_PAYMENT, error: null }; // reserved: never a custom category
    const name = normalize(raw);
    if (Array.from(name).length > MAX_CATEGORY_LENGTH) return { name: '', error: `Keep category names under ${MAX_CATEGORY_LENGTH} characters.` };
    const existing = this.expenseCategories().find((c) => sameName(c, name));
    if (existing !== undefined) return { name: existing, error: null };
    const error = await this.mutate((d) => { d.settings.customCategories.push(name); return null; });
    return { name, error };
  }
  async removeCategory(name: string): Promise<void> {
    await this.mutate((d) => {
      d.settings.customCategories = d.settings.customCategories.filter((c) => !sameName(c, name));
      // The budget goes with the category, unless a built-in category still has that name.
      if (!EXPENSE_CATEGORIES.some((c) => sameName(c, name))) setBudgetIn(d.settings, name, undefined);
      return null;
    });
  }
  async updateSettings(change: (s: Settings) => void): Promise<string | null> {
    return this.mutate((d) => { change(d.settings); normalizeSettings(d.settings); return null; });
  }

  // ---- budgets

  /** Sets (or with undefined removes) the monthly limit of an expense category. Debt payment is never budgeted. */
  setBudget(category: string, cents: number | undefined): Promise<string | null> {
    if (isDebtName(category)) return Promise.resolve('Card payments are not spending, so they have no budget.');
    if (cents !== undefined) {
      if (!(cents > 0)) return Promise.resolve(moneyMessage('zero'));
      if (cents > MAX_CENTS) return Promise.resolve(moneyMessage('tooLarge'));
    }
    return this.mutate((d) => { setBudgetIn(d.settings, category, cents); return null; });
  }
  async setBudgetNotify(on: boolean): Promise<string | null> {
    // switching it on again gives the alerts a fresh set of tries
    const err = await this.mutate((d) => { d.settings.budgetNotify = on; if (on) for (const k of Object.keys(d.settings.budgetAlerts)) if (/\|tries\d+$/.test(k)) delete d.settings.budgetAlerts[k]; return null; });
    if (err === null && on) { this.alertTries.clear(); void this.notifier.requestAuthorization().catch(() => {}); }
    return err;
  }

  /**
   * Sends one calm notification per category per month at 80 percent and again at 100 percent (when switched on). An alert is
   * saved as sent only after the notifier reports it was delivered; a denied or failed one stays unsent so it can still fire
   * if the user allows notifications later, with one retry per launch (never one every two seconds).
   */
  checkBudgetAlerts(): void {
    if (!this.settings.budgetNotify || this.loadError !== null) return;
    const month = this.dayOf(this.nowProvider()).slice(0, 7);
    this.pruneAlertRecord(month);
    if (Object.keys(this.settings.budgets).length === 0) return;
    const sym = this.settings.currencySymbol;
    const fmt = (c: number) => formatMoney(c, sym);
    const pending: { tag: string; key: string; level: number; title: string; body: string }[] = [];
    for (const st of this.budgetStatuses()) {
      const level = alertLevel(st), key = `${month}|${st.id}`;
      if (!(level > (this.settings.budgetAlerts[key] ?? 0))) continue;
      const tag = `${key}|${level}`;
      if (this.alertsInFlight.has(tag)) continue;
      const t = this.alertTries.get(tag);
      // the failed tries are saved in the alert record (key "yyyy-MM|category|tries80"), so they survive a restart: three in all
      if ((this.settings.budgetAlerts[triesKey(key, level)] ?? 0) >= MAX_ALERT_TRIES) continue;
      if (t && this.nowProvider() - t.at < ALERT_RETRY_MS) continue;
      let body: string;
      switch (budgetLevel(st)) {
        case 'over': body = `${st.name} is ${budgetMessage(st, fmt)} its monthly budget of ${fmt(st.limit)}.`; break;
        case 'atLimit': body = `${st.name} has used its monthly budget of ${fmt(st.limit)}.`; break;
        default: body = `${st.name} is at ${budgetPercent(st)}% of its monthly budget (${fmt(st.spent)} of ${fmt(st.limit)}).`;
      }
      pending.push({ tag, key, level, title: level === 100 ? 'Budget reached' : 'Budget heads-up', body });
    }
    if (pending.length === 0) return;
    // More than a few at once (a first tick after a long time, many categories over) become ONE summary notification.
    const groups = pending.length > SUMMARY_OVER
      ? [{ tag: `${month}|summary|${pending.map((p) => p.tag).join(',')}`, title: 'Budgets need attention', body: `${pending.length} budgets are at 80% or over this month: ${pending.map((p) => p.tag.split('|')[1]).slice(0, 6).join(', ')}${pending.length > 6 ? ', ...' : ''}.`, items: pending }]
      : pending.map((p) => ({ tag: p.tag, title: p.title, body: p.body, items: [p] }));
    for (const g of groups) {
      this.alertsInFlight.add(g.tag);
      void this.notifier.send(g.title, g.body, g.tag).catch(() => false).then(async (ok) => {
        this.alertsInFlight.delete(g.tag);
        if (ok) {
          for (const it of g.items) this.alertTries.delete(it.tag);
          // recorded as sent only after delivery succeeded; one save for the whole group
          await this.mutate((d) => { for (const it of g.items) { d.settings.budgetAlerts[it.key] = Math.max(it.level, d.settings.budgetAlerts[it.key] ?? 0); delete d.settings.budgetAlerts[triesKey(it.key, it.level)]; } return null; });
        } else {
          for (const it of g.items) this.alertTries.set(it.tag, { count: (this.alertTries.get(it.tag)?.count ?? 0) + 1, at: this.nowProvider() });
          await this.mutate((d) => { for (const it of g.items) { const k = triesKey(it.key, it.level); d.settings.budgetAlerts[k] = (d.settings.budgetAlerts[k] ?? 0) + 1; } return null; });
        }
      });
    }
  }
  /** Forgets other months, but only when the month moved forward: a clock that jumps back must not erase what was sent. */
  private pruneAlertRecord(currentMonth: string): void {
    const months = Object.keys(this.settings.budgetAlerts).map((k) => k.slice(0, 7));
    if (months.length === 0) return;
    const newest = months.reduce((a, b) => (a > b ? a : b));
    if (!(currentMonth >= newest) || !months.some((m) => m !== currentMonth)) return;
    void this.mutate((d) => { d.settings.budgetAlerts = Object.fromEntries(Object.entries(d.settings.budgetAlerts).filter(([k]) => k.startsWith(currentMonth + '|'))); return null; });
  }

  // ---- recurring entries

  /** Adds every occurrence that has come due (see applyRules). Resolves to how many entries were added. */
  runRecurring(): Promise<number> { return this.queue.run(async () => { const n = await this.runRecurringInner(); this.flush(); return n; }); }
  private async runRecurringInner(): Promise<number> {
    if (this.loadError !== null || !this.settings.recurring.some((r) => !r.paused)) return 0;
    const today = this.dayOf(this.nowProvider());
    if (!due(this.settings.recurring, today)) return 0;
    await this.reloadIfChanged(); // another copy may have just added them
    if (this.loadError !== null || !due(this.settings.recurring, today)) return 0;
    let added = 0;
    await this.mutateInner((d) => { added = applyRules(d.settings.recurring, d.entries, today, Math.floor(this.nowProvider() / 1000), undefined, this.tz); return null; });
    return added;
  }
  addRule(rule: RecurringRule): Promise<string | null> {
    const r = cleanRule(rule);
    r.last = undefined; delete r.last; r.paused = false;
    const today = this.dayOf(this.nowProvider());
    const bad = validateRule(r, today, this.tz);
    if (bad) return Promise.resolve(bad);
    const cap = `You can have at most ${MAX_RULES} recurring entries. Delete one you no longer need.`;
    if (this.settings.recurring.length >= MAX_RULES) return Promise.resolve(cap);
    return this.mutate((d) => {
      if (d.settings.recurring.length >= MAX_RULES) return cap;
      const rules = [...d.settings.recurring, r];
      applyRules(rules, d.entries, today, Math.floor(this.nowProvider() / 1000), undefined, this.tz);
      d.settings.recurring = rules;
      return null;
    });
  }
  /** Changes the rule for future entries only: entries already created are never touched, and what was handled stays handled. */
  updateRule(rule: RecurringRule): Promise<string | null> {
    const r = cleanRule(rule);
    // An unchanged start date is never re-checked: a monthly rent rule from two years ago can still be edited.
    const startChanged = this.settings.recurring.find((x) => x.id === r.id)?.start !== r.start;
    const bad = validateRule(r, startChanged ? this.dayOf(this.nowProvider()) : undefined, this.tz);
    if (bad) return Promise.resolve(bad);
    return this.mutate((d) => {
      const i = d.settings.recurring.findIndex((x) => x.id === r.id);
      if (i < 0) return 'That recurring entry is gone (it was changed outside the app).';
      const old = d.settings.recurring[i];
      const next: RecurringRule = { ...r, paused: old.paused };
      if (old.last !== undefined) next.last = old.last; else delete next.last;
      d.settings.recurring[i] = next;
      return null;
    });
  }
  /** Resuming skips what came due while the rule was paused (it does not flood the list); it continues from the next date. */
  setRulePaused(id: string, paused: boolean): Promise<string | null> {
    const today = this.dayOf(this.nowProvider());
    return this.mutate((d) => {
      const r = d.settings.recurring.find((x) => x.id === id);
      if (!r) return 'That recurring entry is gone (it was changed outside the app).';
      const t = Civil.days(today);
      if (!paused && r.paused && t !== null) {
        const skip = latest(r, Civil.keyOfDays(t - 1));
        if (skip !== null && skip > (r.last ?? '')) r.last = skip;
      }
      r.paused = paused;
      return null;
    });
  }
  /** Deletes the rule only; the entries it already created stay. */
  deleteRule(id: string): Promise<string | null> { return this.mutate((d) => { d.settings.recurring = d.settings.recurring.filter((r) => r.id !== id); return null; }); }
  entryCount(ruleId: string): number { return this.entries.reduce((n, e) => n + (e.recurringID === ruleId ? 1 : 0), 0); }
  /** Deletes the rule and every entry it created, in one save. Entries typed in by hand are never touched. */
  deleteRuleAndEntries(id: string): Promise<string | null> {
    return this.mutate((d) => { d.settings.recurring = d.settings.recurring.filter((r) => r.id !== id); d.entries = d.entries.filter((e) => e.recurringID !== id); return null; });
  }

  loadSample(): Promise<string | null> {
    return this.mutate((d) => { d.entries = d.entries.filter((e) => !e.sample); d.entries.push(...sampleEntries(this.dayOf(this.now))); return null; });
  }
  clearSample(): Promise<string | null> { return this.mutate((d) => { d.entries = d.entries.filter((e) => !e.sample); return null; }); }
}

const errText = errMessage;

function merged(base: string[], extra: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...base, ...extra]) {
    const n = isDebtName(raw) ? DEBT_PAYMENT : normalize(raw);
    if (!out.some((o) => sameName(o, n))) out.push(n);
  }
  return out;
}
function entriesText(entries: Entry[]): string {
  return JSON.stringify(entries.map((e) => [e.id, e.kind, e.cents, e.category, e.note, e.day, Math.round(e.created), e.sample, e.recurringID ?? null]));
}
export type { MoneyFile };
