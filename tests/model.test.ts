import { describe, expect, it } from 'vitest';
import { decodeMoneyFile, encodeMoneyFile, defaultSettings, cleanBudgets, setBudgetIn, uniqueIds, validateEntry, glassAmount, blurLevel, normalizeSettings } from '../src/core/model';
import { DecodeError } from '../src/core/json';
import { E } from './helpers';

const entry = { id: '0A0A0A0A-0000-4000-8000-000000000001', kind: 'expense', cents: 1250, category: 'Food', note: 'lunch', date: '2026-10-05', created: 1760000000, sample: false };
const file = (o: object) => JSON.stringify({ version: 1, settings: {}, entries: [entry], ...o });
const err = (text: string) => { try { decodeMoneyFile(text); } catch (e) { expect(e).toBeInstanceOf(DecodeError); return (e as Error).message; } throw new Error('decoded'); };

describe('strict decode with named errors', () => {
  it('reads the Mac layout', () => {
    const f = decodeMoneyFile(file({}));
    expect(f.entries[0]).toMatchObject({ kind: 'expense', cents: 1250, day: '2026-10-05' }); expect(f.entries[0].recurringID).toBeUndefined(); expect(f.settings.weekStart).toBe(2);
  });
  it('names the entry and the field', () => {
    expect(err(file({ entries: [entry, { ...entry, cents: 12.5 }] }))).toMatch(/^entries > #2 > cents: Expected to decode Int/);
    expect(err(file({ entries: [{ ...entry, cents: 0 }] }))).toContain('entries > #1 > cents: cents 0 must be from 1 to 100000000');
    expect(err(file({ entries: [{ ...entry, cents: 100_000_001 }] }))).toContain('must be from 1 to 100000000');
    expect(err(file({ entries: [{ ...entry, date: '2026-02-30' }] }))).toContain('is not a date like 2026-10-15');
    expect(err(file({ entries: [{ ...entry, kind: 'gift' }] }))).toContain('entries > #1 > kind');
    expect(err(file({ entries: [{ ...entry, kind: undefined }] }))).toContain('No value associated with key kind');
    expect(err(file({ entries: [{ ...entry, note: 5 }] }))).toContain('entries > #1 > note');
    expect(err(file({ entries: [{ ...entry, id: 'nope' }] }))).toContain('id');
    expect(err(file({ entries: 'x' }))).toContain('entries');
    expect(err('{ not json')).toContain('not valid JSON');
    expect(err('[]')).toContain('Expected to decode a dictionary');
  });
  it('settings: money settings strict, looks lenient', () => {
    expect(err(file({ settings: { weekStart: 9 } }))).toContain('settings > weekStart');
    expect(err(file({ settings: { menuBar: 'weird' } }))).toContain('settings > menuBar');
    expect(err(file({ settings: { budgets: { Food: 0 } } }))).toContain('budget "Food": 0 cents');
    expect(err(file({ settings: { budgets: { Food: 'x' } } }))).toContain('settings > budgets');
    expect(err(file({ settings: { budgetNotify: 'yes' } }))).toContain('settings > budgetNotify');
    const s = decodeMoneyFile(file({ settings: { theme: 'neon', style: 5, glass: 250.4, blur: 'huge', maxItems: 1, appearance: 3, chartStyle: 'pie', budgetAlerts: 'x' } })).settings;
    expect(s).toMatchObject({ theme: 'classic', style: 'cards', glass: 100, maxItems: 3, appearance: 'system', chartStyle: 'bars', budgetAlerts: {} }); expect(s.blur).toBeUndefined();
  });
  it('recurring rules are strict and ids unique', () => {
    const rule = { id: '0B0B0B0B-0000-4000-8000-000000000001', kind: 'expense', cents: 120000, category: 'Rent', note: '', repeat: 'monthly', interval: 1, start: '2026-01-01', paused: false };
    expect(decodeMoneyFile(file({ settings: { recurring: [rule] } })).settings.recurring[0]).toMatchObject({ repeatKind: 'monthly', cents: 120000 });
    expect(err(file({ settings: { recurring: [{ ...rule, cents: 0 }] } }))).toContain('settings > recurring > #1 > cents: recurring rule: The amount must be more than zero');
    expect(err(file({ settings: { recurring: [rule, rule] } }))).toContain('share the id');
    expect(err(file({ settings: { recurring: [{ ...rule, repeat: 'yearly' }] } }))).toContain('repeat');
    expect(err(file({ settings: { recurring: [{ ...rule, last: 'x' }] } }))).toContain('last is not a date');
  });
  it('a missing key gets the default; BOM is tolerated; ids are upper-cased', () => {
    const f = decodeMoneyFile('﻿{"entries":[{"kind":"tip","cents":100,"date":"2026-01-02","id":"0a0a0a0a-0000-4000-8000-000000000001"}]}');
    expect(f.version).toBe(1); expect(f.entries[0].id).toBe('0A0A0A0A-0000-4000-8000-000000000001'); expect(f.entries[0].category).toBe(''); expect(f.entries[0].created).toBeGreaterThan(0);
  });
});

describe('write back', () => {
  it('unknown keys survive at the top and inside settings; version = max(file, current)', () => {
    const f = decodeMoneyFile(file({ version: 7, future: { a: [1, 2] }, settings: { newThing: 'x', theme: 'ocean' } }));
    expect(f.version).toBe(7);
    const out = JSON.parse(encodeMoneyFile({ ...f }));
    expect(out.future).toEqual({ a: [1, 2] }); expect(out.settings.newThing).toBe('x'); expect(out.settings.theme).toBe('ocean'); expect(out.version).toBe(7);
    expect(JSON.parse(encodeMoneyFile({ ...f, version: 0 })).version).toBe(1);
    expect(JSON.parse(encodeMoneyFile({ ...f, extraTop: { entries: 'evil', version: 99 } })).entries).toHaveLength(1);
  });
  it('round trips and writes the Mac key names', () => {
    const f = decodeMoneyFile(file({ entries: [{ ...entry, recurring: '0C0C0C0C-0000-4000-8000-000000000001' }] }));
    const out = JSON.parse(encodeMoneyFile(f));
    expect(out.entries[0]).toEqual({ ...entry, recurring: '0C0C0C0C-0000-4000-8000-000000000001' });
    expect(Object.keys(out.settings).sort()).toEqual(['appearance', 'budgetAlerts', 'budgetNotify', 'budgets', 'chartStyle', 'currencySymbol', 'customCategories', 'maxItems', 'menuBar', 'recurring', 'style', 'theme', 'weekStart']);
    expect(decodeMoneyFile(encodeMoneyFile(f)).entries).toEqual(f.entries);
  });
});

describe('helpers', () => {
  it('budgets: debt dropped, spellings merged, replaced and alert record reset', () => {
    expect(cleanBudgets({ 'Debt payment': 5, Cafe: 100, Café: 200, Food: 0 })).toEqual({ Cafe: 100 });
    const s = defaultSettings(); s.budgets = { Food: 100 }; s.budgetAlerts = { '2026-10|food': 80, '2026-10|fun': 80 };
    setBudgetIn(s, 'FOOD', 200); expect(s.budgets).toEqual({ FOOD: 200 }); expect(s.budgetAlerts).toEqual({ '2026-10|fun': 80 });
    setBudgetIn(s, 'FOOD', undefined); expect(s.budgets).toEqual({});
  });
  it('duplicate ids get a stable derived id', () => {
    const a = E('expense', 1, '2026-01-01', 'F'), b = { ...E('expense', 2, '2026-01-02', 'F'), id: a.id };
    const x = uniqueIds([a, b]), y = uniqueIds([a, b]);
    expect(x[1].id).not.toBe(a.id); expect(x[1].id).toBe(y[1].id);
  });
  it('validate and look defaults', () => {
    expect(validateEntry(0, '', '2026-01-01')).toContain('more than zero'); expect(validateEntry(1, 'x'.repeat(301), '2026-01-01')).toContain('too long'); expect(validateEntry(1, '', '2026-02-30')).toBe('That date is not valid.'); expect(validateEntry(1.5, '', '2026-01-01')).not.toBeNull();
    const s = defaultSettings(); expect(glassAmount(s)).toBe(0); expect(blurLevel(s)).toBe('medium'); s.style = 'glass'; expect(glassAmount(s)).toBe(60); expect(blurLevel(s)).toBe('light');
    s.weekStart = 99; s.currencySymbol = ''; normalizeSettings(s); expect(s.weekStart).toBe(7); expect(s.currencySymbol).toBe('$');
  });
});
