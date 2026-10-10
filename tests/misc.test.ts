import { describe, expect, it } from 'vitest';
import { Glass, THEME_NAMES, DARK_BACKGROUNDS, DARK_TINTED, LIGHT_BACKGROUNDS, LIGHT_TINTED, TEXT_RATIO, textTones, themeColors, toHex } from '../src/core/themes';
import { defaultDataDir, ALLOWED_FILE } from '../src/core/datadir';
import { KindCategoryMemory, recentHeight, summaryText } from '../src/core/summary';
import { E } from './helpers';
import { MoneyStore } from '../src/core/store';
import { encodeMoneyFile, defaultSettings } from '../src/core/model';
import { sampleEntries } from '../src/core/sample';
import { newId } from '../src/core/json';
import fs from 'node:fs';
import path from 'node:path';
import { nodeIO, tmpDir, noon } from './helpers';

describe('text tone contrast (4.5:1, all themes, both modes)', () => {
  for (const name of THEME_NAMES) {
    it(name, () => {
      const t = textTones(name);
      for (const [k, tone] of Object.entries(t)) {
        const lb = [...LIGHT_BACKGROUNDS, ...(k === 'loss' ? LIGHT_TINTED : [])], db = [...DARK_BACKGROUNDS, ...(k === 'loss' ? DARK_TINTED : [])];
        for (const b of lb) expect(Glass.contrast(tone.light, b), `${name} ${k} light`).toBeGreaterThanOrEqual(4.5);
        for (const b of db) expect(Glass.contrast(tone.dark, b), `${name} ${k} dark`).toBeGreaterThanOrEqual(4.5);
        expect(TEXT_RATIO).toBeGreaterThanOrEqual(4.5);
      }
      expect(themeColors(name).palette).toHaveLength(8);
    });
  }
  it('the three accents stay distinct and glass maths holds', () => {
    for (const n of THEME_NAMES) { const c = themeColors(n); expect(new Set([toHex(c.spent.light), toHex(c.earned.light), toHex(c.tips.light)]).size).toBe(3); }
    expect(Glass.panelAlpha(0)).toBe(1); expect(Glass.panelAlpha(100)).toBe(0.5); expect(Glass.panelAlpha(500)).toBe(0.5); expect(Glass.clamp(-4)).toBe(0);
    expect(Glass.contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
  });
});

describe('data dir per OS', () => {
  it('matches the three conventions and the override', () => {
    expect(defaultDataDir('macos', {}, '/Users/ann')).toBe('/Users/ann/Library/Application Support/MoneyBar');
    expect(defaultDataDir('windows', { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming\\' }, 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann\\AppData\\Roaming\\MoneyBar');
    expect(defaultDataDir('windows', {}, 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann\\AppData\\Roaming\\MoneyBar');
    expect(defaultDataDir('linux', {}, '/home/ann')).toBe('/home/ann/.local/share/MoneyBar');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/x' }, '/home/ann')).toBe('/x/MoneyBar');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: 'rel' }, '/home/ann')).toBe('/home/ann/.local/share/MoneyBar');
    expect(defaultDataDir('linux', { MONEYBAR_DATA_DIR: '/tmp/t' }, '/h')).toBe('/tmp/t');
  });
  it('allowed file names', () => {
    for (const ok of ['entries.json', 'entries.backup.json', 'entries.backup-daily.json', 'entries.broken-17-ab.json']) expect(ALLOWED_FILE.test(ok)).toBe(true);
    for (const bad of ['../entries.json', 'entries.json.bak', 'tasks.json', 'entries.broken-.json', 'entries.json\n', 'Entries.json']) expect(ALLOWED_FILE.test(bad)).toBe(false);
  });
});

describe('form helpers', () => {
  it('KindCategoryMemory: Rent -> Income -> Expense comes back to Rent; a Debt payment is never turned into Food', () => {
    const m = new KindCategoryMemory('expense', 'Rent');
    expect(m.switchTo('income', 'Rent')).toBe('Job'); expect(m.switchTo('tip', 'Other')).toBe(''); expect(m.switchTo('expense', '')).toBe('Rent');
    const d = new KindCategoryMemory('expense', 'Debt payment'); d.switchTo('income', 'Debt payment'); expect(d.switchTo('expense', 'Job')).toBe('Debt payment');
    expect(new KindCategoryMemory('income', 'Job').switchTo('expense', 'Job')).toBe('Food');
  });
  it('popover list height is clamped 160..560', () => { expect(recentHeight(300)).toBe(160); expect(recentHeight(800)).toBe(360); expect(recentHeight(5000)).toBe(560); });
  it('tray text modes', () => {
    const es = [E('expense', 4324, '2026-10-06', 'Food'), E('income', 9000, '2026-10-06', 'Job'), E('tip', 4000, '2026-10-06', 'Card'), E('expense', 99999, '2026-10-06', 'Debt payment')];
    expect(summaryText('todayNet', es, '2026-10-06', '$')).toBe('+$86.76 today'); expect(summaryText('todaySpent', es, '2026-10-06', '$')).toBe('$43.24 spent');
    expect(summaryText('todayEarned', es, '2026-10-06', '$')).toBe('$90 earned'); expect(summaryText('todayTips', es, '2026-10-06', '$')).toBe('$40 tips'); expect(summaryText('todayNet', [], '2026-10-06', '€')).toBe('€0 today');
  });
});

describe('performance with 20,000 entries', () => {
  it('tick and glance are well under 50 ms; the first load is reported', async () => {
    const dir = tmpDir();
    const entries = Array.from({ length: 20000 }, (_, i) => ({ ...E(i % 5 === 0 ? 'income' : i % 17 === 0 ? 'tip' : 'expense', 100 + (i % 977), `2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, ['Food', 'Fun', 'Rent', 'Bills', 'Debt payment', 'Café'][i % 6], 'synthetic ' + i), id: newId() }));
    const s0 = defaultSettings(); s0.budgets = { Food: 50000, Fun: 20000 }; s0.budgetNotify = true;
    fs.writeFileSync(path.join(dir, 'entries.json'), encodeMoneyFile({ version: 1, settings: s0, entries }));
    const s = new MoneyStore({ io: nodeIO(dir), nowProvider: () => noon('2026-10-06'), timeZone: 'UTC' });
    let t = performance.now(); await s.init(); const load = performance.now() - t;
    t = performance.now(); await s.tick(); const tick = performance.now() - t;
    t = performance.now(); const g = s.glance(); const glance = performance.now() - t;
    t = performance.now(); s.glance(); const glance2 = performance.now() - t;
    t = performance.now(); s.report({ kind: 'month' }); const rep = performance.now() - t;
    t = performance.now(); s.budgetStatuses(); s.recent; s.today; s.menuText; const rest = performance.now() - t;
    await s.add('expense', 100, 'Food', '', '2026-10-06'); // a change invalidates the memo
    t = performance.now(); await s.tick(); const tickAfter = performance.now() - t;
    t = performance.now(); s.glance(); const glanceAfter = performance.now() - t;
    console.log(`PERF 20000 entries: load ${load.toFixed(1)} ms, tick ${tick.toFixed(2)} ms, glance ${glance.toFixed(2)} ms (cached ${glance2.toFixed(3)}), month report ${rep.toFixed(1)} ms, budgets+recent+today+menu ${rest.toFixed(1)} ms, tick after a change ${tickAfter.toFixed(2)} ms, glance after a change ${glanceAfter.toFixed(2)} ms`);
    expect(s.entries).toHaveLength(20001); expect(g.days).toBe(6);
    expect(tick).toBeLessThan(50); expect(glance).toBeLessThan(50); expect(tickAfter).toBeLessThan(50); expect(glanceAfter).toBeLessThan(50); expect(rep).toBeLessThan(50);
    expect(sampleEntries('2026-10-06').length).toBeGreaterThan(50);
  });
});

import { CHART_BG_DARK, CHART_BG_LIGHT, NON_TEXT_RATIO, chartColors } from '../src/core/themes';
describe('chart fills reach 3:1 (non-text contrast) in every theme and mode', () => {
  for (const name of THEME_NAMES) {
    it(name, () => {
      const c = chartColors(name);
      const fills = { spent: c.spent, earned: c.earned, tips: c.tips, ...Object.fromEntries(c.palette.map((p, i) => [`palette${i}`, p])) };
      for (const [k, tone] of Object.entries(fills)) {
        for (const b of CHART_BG_LIGHT) expect(Glass.contrast(tone.light, b), `${name} ${k} light`).toBeGreaterThanOrEqual(NON_TEXT_RATIO);
        for (const b of CHART_BG_DARK) expect(Glass.contrast(tone.dark, b), `${name} ${k} dark`).toBeGreaterThanOrEqual(NON_TEXT_RATIO);
      }
      for (const mode of ['light', 'dark'] as const) {
        expect(new Set(c.palette.map((p) => toHex(p[mode]))).size, `${name} ${mode} palette stays distinct`).toBe(8);
        expect(new Set([toHex(c.spent[mode]), toHex(c.earned[mode]), toHex(c.tips[mode])]).size, `${name} ${mode} accents distinct`).toBe(3);
      }
    });
  }
});
