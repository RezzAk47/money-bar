// The file format (a port of Entry, Settings and MoneyFile in Model.swift): strict decode with named errors, so a typo in
// entries.json is reported instead of being silently dropped on the next save. Keys this app does not know are kept
// (top level and inside settings) and written back; the version written is max(file, current).
import * as Civil from './civil';
import { Extra, DecodeError, UUID_RE, dict, isObject, newId, stableStringify, unknownKeys } from './json';
import { parseJson } from './jsonparse';
import { MAX_CENTS, cleanSymbol, moneyMessage } from './money';
import { MAX_NOTE, clip, cleanCategory, foldKey, isDebtName } from './categories';
import type { Kind } from './categories';
import { Glass } from './themes';
import type { BlurLevel, ThemeName, UIStyle } from './themes';
import { validateRule } from './recurring';
import type { RecurringRule, RepeatKind } from './recurring';

export const CURRENT_VERSION = 1;
export const KINDS: Kind[] = ['expense', 'income', 'tip'];
export const KIND_LABEL: Record<Kind, string> = { expense: 'Expense', income: 'Income', tip: 'Tip' };

export interface Entry {
  id: string;
  kind: Kind;
  /** Always positive. The type decides the direction. */
  cents: number;
  /** Expense: category. Income: source (Job, Other). Tip: "Cash", "Card" or "" (not said). */
  category: string;
  note: string;
  /** "yyyy-MM-dd" in the local time zone. */
  day: string;
  /** Seconds since 1970 (the Mac app writes a number). */
  created: number;
  sample: boolean;
  recurringID?: string;
}

export const isDebtPayment = (e: Pick<Entry, 'kind' | 'category'>): boolean => e.kind === 'expense' && isDebtName(e.category);

/** null when fine, otherwise the message to show in the form. */
export function validateEntry(cents: number, note: string, day: string, tz?: string): string | null {
  if (!(cents > 0) || !Number.isInteger(cents)) return moneyMessage('zero');
  if (cents > MAX_CENTS) return moneyMessage('tooLarge');
  if (Array.from(note).length > MAX_NOTE) return `The note is too long (${MAX_NOTE} characters at most).`;
  if (!Civil.isValidLocalDay(day, tz)) return 'That date is not valid.';
  return null;
}

/** Newest day first, then newest created, then id (a stable order). */
export function recentFirst(a: Entry, b: Entry): number {
  if (a.day !== b.day) return a.day > b.day ? -1 : 1;
  if (a.created !== b.created) return a.created > b.created ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---- settings

export const MENU_MODES = ['todayNet', 'todaySpent', 'todayEarned', 'todayTips'] as const;
export type MenuBarMode = (typeof MENU_MODES)[number];
export const MENU_LABEL: Record<MenuBarMode, string> = { todayNet: "Today's net", todaySpent: 'Spent today', todayEarned: 'Earned today', todayTips: 'Tips today' };
export type AppearanceMode = 'system' | 'light' | 'dark';
export type ChartStyle = 'bars' | 'line';
const APPEARANCES = ['system', 'light', 'dark'], STYLES = ['cards', 'list', 'glass'], BLURS = ['off', 'light', 'medium', 'strong'];
const THEMES = ['classic', 'ocean', 'sunset', 'grape', 'mono'], CHARTS = ['bars', 'line'];

export const MAX_ITEMS_RANGE: [number, number] = [3, 30];
export const DEFAULT_MAX_ITEMS = 12;
export const clampItems = (n: number): number => Math.min(Math.max(n, MAX_ITEMS_RANGE[0]), MAX_ITEMS_RANGE[1]);

export interface Settings {
  currencySymbol: string;
  /** Calendar weekday numbers: 1 = Sunday ... 7 = Saturday. Default 2 = Monday. */
  weekStart: number;
  menuBar: MenuBarMode;
  customCategories: string[];
  maxItems: number;
  appearance: AppearanceMode;
  theme: ThemeName;
  style: UIStyle;
  chartStyle: ChartStyle;
  /** Glass amount 0...100; undefined means "the layout's own default". */
  glass?: number;
  blur?: BlurLevel;
  /** Monthly limit per expense category, in cents. Debt payment is never budgeted. */
  budgets: Record<string, number>;
  budgetNotify: boolean;
  /** "yyyy-MM|category" -> 80 or 100. Only the current month is kept. */
  budgetAlerts: Record<string, number>;
  recurring: RecurringRule[];
}
export const SETTINGS_KEYS = ['currencySymbol', 'weekStart', 'menuBar', 'customCategories', 'maxItems', 'appearance', 'theme', 'style', 'chartStyle', 'glass', 'blur', 'budgets', 'budgetNotify', 'budgetAlerts', 'recurring'] as const;

export function defaultSettings(): Settings {
  return { currencySymbol: '$', weekStart: 2, menuBar: 'todayNet', customCategories: [], maxItems: DEFAULT_MAX_ITEMS, appearance: 'system', theme: 'classic', style: 'cards', chartStyle: 'bars', budgets: dict(), budgetNotify: false, budgetAlerts: dict(), recurring: [] };
}
export const glassAmount = (s: Settings): number => (s.glass !== undefined ? Glass.clamp(s.glass) : Glass.defaultAmount(s.style));
export const blurLevel = (s: Settings): BlurLevel => s.blur ?? Glass.defaultBlur(s.style);
export function resetAppearance(s: Settings): void {
  const d = defaultSettings();
  s.maxItems = d.maxItems; s.appearance = d.appearance; s.theme = d.theme; s.style = d.style; s.chartStyle = d.chartStyle;
  delete s.glass; delete s.blur;
}

export const budgetKey = (name: string): string => clip(name);
const byKey = (a: [string, number], b: [string, number]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
/** Reserved and look-alike names are dropped, spellings of one category are merged (the smallest spelling in sort order wins). */
export function cleanBudgets(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = dict(), folds = new Set<string>();
  for (const [name, cents] of Object.entries(raw).sort(byKey)) {
    if (isDebtName(name) || !(cents > 0) || cents > MAX_CENTS) continue;
    const key = budgetKey(name), fold = foldKey(key);
    if (!folds.has(fold)) { folds.add(fold); out[key] = cents; }
  }
  return out;
}
/** Sets or (with undefined) removes the budget of a category, replacing any other spelling of the same name. */
export function setBudgetIn(s: Settings, name: string, cents: number | undefined): void {
  const fold = foldKey(budgetKey(name));
  const old = Object.entries(s.budgets).find(([k]) => foldKey(k) === fold)?.[1];
  const b = dict(Object.entries(s.budgets).filter(([k]) => foldKey(k) !== fold)); // never b[name] = on a plain object: "__proto__" is not a key there
  if (cents !== undefined) b[budgetKey(name)] = cents;
  s.budgets = b;
  // A new amount means new 80/100 percent thresholds: what was announced for the old amount no longer applies.
  if (old !== cents) s.budgetAlerts = Object.fromEntries(Object.entries(s.budgetAlerts).filter(([k]) => { const rest = Array.from(k).slice(8).join(''); return rest !== fold && !rest.startsWith(fold + '|'); }));
}
/** Snaps out-of-range values back into range. */
export function normalizeSettings(s: Settings): void {
  s.currencySymbol = cleanSymbol(s.currencySymbol);
  s.weekStart = Math.min(Math.max(s.weekStart, 1), 7);
  s.maxItems = clampItems(s.maxItems);
  if (s.glass !== undefined) s.glass = Glass.clamp(s.glass);
  s.budgets = cleanBudgets(s.budgets);
}

// ---- decode

export class Path {
  constructor(private parts: string[]) {}
  at(p: string | number): Path { return new Path([...this.parts, typeof p === 'number' ? `#${p + 1}` : p]); }
  fail(msg: string): never { throw new DecodeError(this.parts.length ? `${this.parts.join(' > ')}: ${msg}` : msg); }
}
const typeName = (v: unknown) => (typeof v === 'string' ? 'a string' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a bool' : v === null ? 'null' : Array.isArray(v) ? 'an array' : 'a dictionary');

function req<T>(o: Record<string, unknown>, key: string, p: Path, expect: string, ok: (v: unknown) => v is T): T {
  if (!(key in o)) p.at(key).fail(`No value associated with key ${key}.`);
  const v = o[key];
  if (!ok(v)) return p.at(key).fail(`Expected to decode ${expect} but found ${typeName(v)} instead.`);
  return v;
}
function opt<T>(o: Record<string, unknown>, key: string, p: Path, expect: string, ok: (v: unknown) => v is T, fallback: T): T {
  if (!(key in o) || o[key] === undefined) return fallback;
  const v = o[key];
  if (!ok(v)) return p.at(key).fail(`Expected to decode ${expect} but found ${v === null ? 'null' : typeName(v)} instead.`);
  return v;
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isUUID = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isIntRecord = (v: unknown): v is Record<string, number> => isObject(v) && Object.values(v).every(isInt);
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

function localNoonSeconds(day: string): number {
  const p = Civil.parts(day);
  return p ? Math.floor(new Date(p.y, p.m - 1, p.d, 12).getTime() / 1000) : 0;
}

export function decodeEntry(raw: unknown, p: Path, tz?: string): Entry {
  if (!isObject(raw)) return p.fail(`Expected to decode a dictionary but found ${typeName(raw)} instead.`);
  const kind = req(raw, 'kind', p, 'a kind', oneOf(KINDS));
  const cents = req(raw, 'cents', p, 'Int', isInt);
  if (cents <= 0 || cents > MAX_CENTS) p.at('cents').fail(`cents ${cents} must be from 1 to ${MAX_CENTS} (whole cents, as an integer)`);
  const day = req(raw, 'date', p, 'String', isStr);
  if (!Civil.isValidLocalDay(day, tz)) p.at('date').fail(`"${day}" is not a date like 2026-10-15`);
  const e: Entry = {
    id: opt(raw, 'id', p, 'a UUID', isUUID, '').toUpperCase() || newId(),
    kind, cents,
    category: opt(raw, 'category', p, 'String', isStr, ''),
    note: opt(raw, 'note', p, 'String', isStr, ''),
    day,
    created: opt(raw, 'created', p, 'Double', isNum, localNoonSeconds(day)),
    sample: opt(raw, 'sample', p, 'Bool', isBool, false),
  };
  if (raw.recurring !== undefined && raw.recurring !== null) e.recurringID = req(raw, 'recurring', p, 'a UUID', isUUID).toUpperCase();
  return e;
}

export function decodeRule(raw: unknown, p: Path, tz?: string): RecurringRule {
  if (!isObject(raw)) return p.fail(`Expected to decode a dictionary but found ${typeName(raw)} instead.`);
  const kind = req(raw, 'kind', p, 'a kind', oneOf(KINDS));
  const cents = req(raw, 'cents', p, 'Int', isInt);
  const repeatKind = req(raw, 'repeat', p, 'a repeat kind', oneOf<RepeatKind>(['monthly', 'weekly', 'days']));
  const start = req(raw, 'start', p, 'String', isStr);
  const r: RecurringRule = {
    id: opt(raw, 'id', p, 'a UUID', isUUID, '').toUpperCase() || newId(),
    kind, cents, repeatKind, start,
    category: opt(raw, 'category', p, 'String', isStr, ''),
    note: opt(raw, 'note', p, 'String', isStr, ''),
    interval: opt(raw, 'interval', p, 'Int', isInt, 1),
    paused: opt(raw, 'paused', p, 'Bool', isBool, false),
    end: undefined, last: undefined,
  };
  if (raw.end !== undefined && raw.end !== null) r.end = req(raw, 'end', p, 'String', isStr); else delete r.end;
  if (raw.last !== undefined && raw.last !== null) r.last = req(raw, 'last', p, 'String', isStr); else delete r.last;
  const bad = validateRule(r, undefined, tz) ?? (r.last !== undefined && Civil.parts(r.last) === null ? 'last is not a date' : null);
  if (bad) p.at('cents').fail('recurring rule: ' + bad);
  r.category = cleanCategory(r.kind, r.category);
  return r;
}

export function decodeSettings(raw: unknown, p: Path, tz?: string): Settings {
  if (!isObject(raw)) return p.fail(`Expected to decode a dictionary but found ${typeName(raw)} instead.`);
  const s = defaultSettings();
  s.currencySymbol = cleanSymbol(opt(raw, 'currencySymbol', p, 'String', isStr, '$'));
  s.weekStart = opt(raw, 'weekStart', p, 'Int', isInt, 2);
  if (s.weekStart < 1 || s.weekStart > 7) p.at('weekStart').fail('weekStart must be 1 (Sunday) to 7 (Saturday)');
  s.menuBar = opt(raw, 'menuBar', p, 'a menu bar mode', oneOf(MENU_MODES), 'todayNet');
  s.customCategories = opt(raw, 'customCategories', p, 'an array', isStrArray, []);
  // Look options are cosmetic and may come from a newer or older version: an odd value falls back to the default.
  s.maxItems = clampItems(isInt(raw.maxItems) ? raw.maxItems : DEFAULT_MAX_ITEMS);
  s.appearance = oneOf(APPEARANCES)(raw.appearance) ? (raw.appearance as AppearanceMode) : 'system';
  s.theme = oneOf(THEMES)(raw.theme) ? (raw.theme as ThemeName) : 'classic';
  s.style = oneOf(STYLES)(raw.style) ? (raw.style as UIStyle) : 'cards';
  s.chartStyle = oneOf(CHARTS)(raw.chartStyle) ? (raw.chartStyle as ChartStyle) : 'bars';
  if (isNum(raw.glass)) s.glass = Glass.clamp(Math.round(raw.glass)); else delete s.glass;
  if (oneOf(BLURS)(raw.blur)) s.blur = raw.blur as BlurLevel; else delete s.blur;
  // Money settings stay strict: a wrong type or an impossible amount is reported, and the file is never overwritten.
  const rawBudgets = opt(raw, 'budgets', p, 'a dictionary', isIntRecord, dict<number>());
  for (const [name, cents] of Object.entries(rawBudgets)) {
    if (cents <= 0 || cents > MAX_CENTS) p.at('budgets').fail(`budget "${name}": ${cents} cents must be from 1 to ${MAX_CENTS}`);
  }
  s.budgets = cleanBudgets(rawBudgets);
  s.budgetNotify = opt(raw, 'budgetNotify', p, 'Bool', isBool, false);
  s.budgetAlerts = isIntRecord(raw.budgetAlerts) ? dict(Object.entries(raw.budgetAlerts)) : dict();
  const rules = opt<unknown[]>(raw, 'recurring', p, 'an array', (v): v is unknown[] => Array.isArray(v), []);
  s.recurring = rules.map((r, i) => decodeRule(r, p.at('recurring').at(i), tz));
  const seen = new Set<string>();
  for (const r of s.recurring) {
    if (seen.has(r.id)) p.at('recurring').fail(`two recurring rules share the id ${r.id}; give each rule its own id`);
    seen.add(r.id);
  }
  return s;
}

export interface MoneyFile { version: number; settings: Settings; entries: Entry[]; extraTop?: Extra; extraSettings?: Extra }
export const FILE_KNOWN_KEYS = ['version', 'settings', 'entries'];

/** `tz`: the zone whose calendar the days must exist in (default: the system zone, as the Mac app). */
export function decodeMoneyFile(text: string, tz?: string): MoneyFile {
  let json: unknown;
  try { json = parseJson(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch (e) { throw new DecodeError(`entries.json is not valid JSON (${(e as Error).message})`); }
  const p = new Path([]);
  if (!isObject(json)) return p.fail(`Expected to decode a dictionary but found ${typeName(json)} instead.`);
  const version = opt(json, 'version', p, 'Int', isInt, 1);
  const settings = json.settings === undefined ? defaultSettings() : decodeSettings(json.settings, p.at('settings'), tz);
  const list = opt<unknown[]>(json, 'entries', p, 'an array', (v): v is unknown[] => Array.isArray(v), []);
  const entries = list.map((e, i) => decodeEntry(e, p.at('entries').at(i), tz));
  return { version, settings, entries, extraTop: unknownKeys(json, FILE_KNOWN_KEYS), extraSettings: isObject(json.settings) ? unknownKeys(json.settings, SETTINGS_KEYS) : undefined };
}

/** A second entry with an id already used gets a new, derived id (the same one on every load). */
export function uniqueIds(list: Entry[]): Entry[] {
  const seen = new Set<string>();
  return list.map((e, i) => {
    if (!seen.has(e.id)) { seen.add(e.id); return e; }
    let salt = 1, id = derivedId(e.id, salt);
    while (seen.has(id)) { salt = (salt + 1 + (i & 0xff)) & 0xff; id = derivedId(e.id, salt); }
    seen.add(id);
    return { ...e, id };
  });
}
function derivedId(id: string, salt: number): string {
  const h0 = id.replace(/-/g, '');
  const raw = Array.from({ length: 16 }, (_, i) => parseInt(h0.slice(i * 2, i * 2 + 2), 16));
  let h = (0xcbf29ce484222325n + BigInt(salt)) & 0xffffffffffffffffn;
  const out = raw.map((b) => { h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn; return (Number((h >> 24n) & 0xffn) ^ b); });
  const s = out.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---- encode

function encodeEntry(e: Entry): Record<string, unknown> {
  const o: Record<string, unknown> = { id: e.id, kind: e.kind, cents: e.cents, category: e.category, note: e.note, date: e.day, created: Math.round(e.created), sample: e.sample };
  if (e.recurringID !== undefined) o.recurring = e.recurringID;
  return o;
}
function encodeRule(r: RecurringRule): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.id, kind: r.kind, cents: r.cents, category: r.category, note: r.note, repeat: r.repeatKind, interval: r.interval, start: r.start, paused: r.paused };
  if (r.end !== undefined) o.end = r.end;
  if (r.last !== undefined) o.last = r.last;
  return o;
}
export function encodeSettings(s: Settings): Record<string, unknown> {
  const o: Record<string, unknown> = {
    currencySymbol: s.currencySymbol, weekStart: s.weekStart, menuBar: s.menuBar, customCategories: s.customCategories, maxItems: s.maxItems,
    appearance: s.appearance, theme: s.theme, style: s.style, chartStyle: s.chartStyle, budgets: s.budgets, budgetNotify: s.budgetNotify,
    budgetAlerts: s.budgetAlerts, recurring: s.recurring.map(encodeRule),
  };
  if (s.glass !== undefined) o.glass = s.glass;
  if (s.blur !== undefined) o.blur = s.blur;
  return o;
}
/** Text for entries.json. A key this app knows always wins over a preserved unknown one. */
export function encodeMoneyFile(f: { version: number; settings: Settings; entries: Entry[]; extraTop?: Extra; extraSettings?: Extra }): string {
  const settings = { ...(f.extraSettings ?? {}), ...encodeSettings(f.settings) };
  const top: Record<string, unknown> = { ...(f.extraTop ?? {}), version: Math.max(f.version, CURRENT_VERSION), settings, entries: f.entries.map(encodeEntry) };
  return stableStringify(top) + '\n';
}

