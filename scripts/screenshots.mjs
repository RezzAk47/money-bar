// UI screenshots with synthetic data (made-up entries), light and dark, against the Vite build. Output: shots/*.png
// Usage: npm run build && npm run shots     (CI uploads shots/ as an artifact)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const out = process.env.SHOTS_DIR ?? 'shots';
fs.mkdirSync(out, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4182', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', shell: process.platform === 'win32' });
const base = 'http://127.0.0.1:4182/';
for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
let browser;
try { browser = await chromium.launch(); } catch (e) { console.error('bundled chromium missing, trying system Chrome:', e.message); browser = await chromium.launch({ channel: 'chrome' }); }
const S = (o) => '&settings=' + encodeURIComponent(JSON.stringify(o));
const shots = [
  { name: 'popover', url: '?fixture=sample', h: 1000 },
  { name: 'report', url: '?fixture=sample', h: 2450, act: async (p) => { await p.getByRole('button', { name: 'Reports' }).click(); } },
  { name: 'report-line', url: '?fixture=sample' + S({ chartStyle: 'line' }), h: 900, act: async (p) => { await p.getByRole('button', { name: 'Reports' }).click(); } },
  { name: 'settings', url: '?fixture=sample', h: 2200, act: async (p) => { await p.getByRole('button', { name: 'Settings' }).click(); } },
  { name: 'edit', url: '?fixture=sample', h: 760, act: async (p) => { await p.getByRole('button', { name: /^Edit Fun/ }).first().click(); } },
  { name: 'empty', url: '?fixture=empty', h: 600 },
  { name: 'error', url: '?fixture=broken', h: 600 },
  { name: 'ocean-list', url: '?fixture=sample' + S({ theme: 'ocean', style: 'list' }), h: 1000 },
  { name: 'glass', url: '?fixture=sample' + S({ theme: 'grape', style: 'glass', glass: 60, blur: 'medium' }), h: 1000 },
  { name: 'mono-report', url: '?fixture=sample' + S({ theme: 'mono' }), h: 1300, act: async (p) => { await p.getByRole('button', { name: 'Reports' }).click(); } },
];
for (const scheme of ['light', 'dark']) {
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: s.h }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(base + s.url);
    await page.waitForSelector('html[data-ready="1"]');
    await page.waitForTimeout(150);
    if (s.act) { await s.act(page); await page.waitForTimeout(250); }
    await page.screenshot({ path: `${out}/${s.name}-${scheme}.png` });
    await ctx.close();
  }
}
await browser.close();
server.kill();
console.log('screenshots written to', out);
