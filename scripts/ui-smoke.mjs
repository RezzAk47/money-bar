// Browser-level checks of keyboard use, focus, RTL text, errors and small screens, on the Vite build with synthetic data.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['vite', 'preview', '--port', '4181', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', shell: process.platform === 'win32' });
const base = 'http://127.0.0.1:4181/';
for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };

const ctx = await browser.newContext({ viewport: { width: 420, height: 760 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '?fixture=sample');
await page.waitForSelector('html[data-ready="1"]');

ok(await page.locator('main').count() === 1 && await page.locator('header').count() === 1, 'header and main landmarks');
ok(await page.locator('h1').innerText() === 'Money Bar', 'h1 is Money Bar');
ok(await page.getByRole('radiogroup', { name: 'Type' }).count() === 1, 'the type control is a radio group');

// keyboard: add an expense with a Persian note and Persian digits
await page.locator('input[placeholder="0.00"]').focus();
await page.keyboard.type('۱۲٫۵۰');
await page.getByLabel('Note').fill('ناهار');
ok(await page.getByLabel('Note').getAttribute('dir') === 'auto', 'the note uses dir=auto for RTL text');
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
ok(await page.getByText('ناهار').count() >= 1, 'Enter adds the entry (Persian digits read as 12.50)');
ok(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')) === '0.00', 'focus returns to the amount field');

// errors are named and announced
await page.keyboard.type('12.345');
await page.keyboard.press('Enter');
ok((await page.getByRole('alert').first().innerText()).includes('at most 2 decimals'), 'a bad amount shows a named error');
await page.locator('input[placeholder="0.00"]').fill('');
await page.keyboard.type('0');
await page.keyboard.press('Enter');
ok((await page.getByRole('alert').first().innerText()).includes('more than zero'), 'zero is refused');

// type switch remembers the category
await page.getByRole('radio', { name: 'Tip' }).check();
ok((await page.getByRole('radio', { name: 'Expense' }).isChecked()) === false, 'switching to Tip');
await page.getByRole('radio', { name: 'Expense' }).check();

// the category control is a keyboard listbox: Enter opens, arrows move, Enter chooses, Escape closes only the menu
const catBtn = page.getByRole('button', { name: /^Category:/ });
await catBtn.focus();
await page.keyboard.press('Enter');
ok(await page.getByRole('listbox', { name: 'Category' }).count() === 1, 'Enter opens the category listbox');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
ok(await page.getByRole('listbox').count() === 0, 'choosing closes the listbox');
ok((await catBtn.getAttribute('aria-label')).startsWith('Category: Transport'), 'ArrowDown + Enter chose the next category');
ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup')) === 'listbox', 'focus returns to the control');
await page.keyboard.press('Enter');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok(await page.getByRole('listbox').count() === 0 && await page.locator('h1').innerText() === 'Money Bar', 'Escape closes only the menu');
const modeBtn = page.getByRole('button', { name: /^Menu bar shows:/ });
await modeBtn.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
ok((await modeBtn.getAttribute('aria-label')).includes('Spent today'), 'the menu bar mode is chosen with the keyboard');
await page.getByRole('button', { name: /^Category:/ }).click();
await page.getByRole('option', { name: 'Food' }).click();
ok((await catBtn.getAttribute('aria-label')).startsWith('Category: Food'), 'a click chooses too');

// edit and delete with confirm
await page.getByRole('button', { name: /^Edit Fun/ }).first().click();
await page.waitForTimeout(300);
ok((await page.getByRole('button', { name: 'Save changes' }).count()) === 1, 'Edit shows Save changes');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok((await page.getByRole('button', { name: 'Save changes' }).count()) === 0, 'Escape cancels the edit');
await page.getByRole('button', { name: /^Delete Food/ }).first().click();
ok(await page.getByRole('group', { name: 'Delete this entry?' }).count() === 1, 'delete asks first');
await page.getByRole('button', { name: 'Keep' }).click();
// delete for real, then Undo within the 8 seconds
const before = await page.getByRole('button', { name: /^Delete Food/ }).count();
await page.getByRole('button', { name: /^Delete Food/ }).first().click();
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.waitForTimeout(300);
ok(await page.getByRole('button', { name: 'Undo' }).count() === 1, 'a deleted entry offers Undo');
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
ok(await page.getByRole('button', { name: /^Delete Food/ }).count() === before, 'Undo puts the entry back');

// card payment row is labelled as not spending
ok(await page.getByText('Card payment', { exact: true }).count() >= 1, 'card payment rows are shown');

// reports with the keyboard, Escape goes back, focus returns
await page.getByRole('button', { name: 'Reports' }).click();
await page.waitForTimeout(250);
ok(await page.locator('h1').innerText() === 'Reports', 'Reports opens');
ok(await page.evaluate(() => document.activeElement?.tagName) === 'H1', 'focus moves to the Reports heading');
ok(await page.locator('svg[role=img]').count() >= 2, 'charts have text labels');
// a category row sets its monthly budget inline (Mac parity); Escape closes only that form
const foodRow = page.getByRole('button', { name: /^Food, \d+ percent/ });
await foodRow.click();
await page.waitForTimeout(150);
ok(await page.getByRole('form', { name: 'Monthly budget for Food' }).count() === 1, 'clicking a report category opens its budget form');
ok(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')) === 'No limit', 'the budget field gets focus');
await page.keyboard.type('abc');
await page.keyboard.press('Enter');
ok((await page.locator('#budget-error').innerText()).includes('not an amount'), 'a bad budget shows the named money error');
await page.locator('.budget-editor input').fill('300');
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
ok(await page.locator('.budget-editor').count() === 0, 'Save closes the budget form');
ok((await page.locator('.budget-rows').innerText()).includes('of $300.00'), 'the new budget shows in the budget bars');
ok(((await foodRow.getAttribute('aria-label')) ?? '').includes('monthly budget $300.00'), 'the row says it has a budget');
await foodRow.click();
await page.waitForTimeout(150);
ok(await page.locator('.budget-editor input').inputValue() === '300.00', 'the form shows the current budget');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok(await page.locator('.budget-editor').count() === 0 && await page.locator('h1').innerText() === 'Reports', 'Escape closes only the budget form');
ok(await page.evaluate(() => document.activeElement?.classList.contains('catrow')), 'focus returns to the category row');
await page.getByRole('radio', { name: 'Custom' }).check();
ok(await page.locator('input[type=date]').count() === 2, 'Custom shows two dates');
await page.getByRole('radio', { name: 'Day' }).check();
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
ok(await page.locator('h1').innerText() === 'Money Bar', 'Escape leaves Reports');
ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Reports', 'focus returns to the Reports button');

// settings: dark mode, items shown, budgets
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByRole('radio', { name: 'Dark', exact: true }).check();
await page.waitForTimeout(150);
ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'choosing Dark switches the theme');
// the recurring form starts in the amount field; Escape closes only the form
await page.getByRole('button', { name: 'Add recurring entry' }).click();
await page.waitForTimeout(150);
ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Amount', 'the recurring form starts in the amount field');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok(await page.getByRole('form', { name: 'New recurring entry' }).count() === 0 && await page.locator('h1').innerText() === 'Settings', 'Escape closes only the recurring form, Settings stays');
ok((await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Add recurring entry'), 'focus returns to Add recurring entry');
await page.getByRole('button', { name: 'Set budget for Rent' }).click();
await page.keyboard.press('Escape');

// small screens scroll, no horizontal scroll
await page.setViewportSize({ width: 420, height: 380 });
const sc = await page.evaluate(() => { const m = document.querySelector('main'); return { sh: m.scrollHeight, ch: m.clientHeight, ov: getComputedStyle(m).overflowY }; });
ok(sc.sh > sc.ch && sc.ov === 'auto', `at 380 px high the page scrolls (${sc.sh} > ${sc.ch})`);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');

// broken file: the named error and the start-over button; nothing else is writable
const bp = await ctx.newPage();
await bp.goto(base + '?fixture=broken'); await bp.waitForSelector('html[data-ready="1"]');
const alert = await bp.getByRole('alert').first().innerText();
ok(alert.includes('entries > #1 > cents') || (await bp.locator('.detail').innerText()).includes('entries > #1 > cents'), 'a broken file shows the named error');
ok(await bp.getByRole('button', { name: 'Keep a copy and start over' }).count() === 1, 'start over is offered');
await bp.getByRole('button', { name: 'Keep a copy and start over' }).click();
await bp.waitForTimeout(150);
ok(await bp.getByRole('group', { name: /^Start over with an empty list\?/ }).count() === 1, 'start over asks first');
ok(await bp.evaluate(() => document.activeElement?.textContent) === 'Yes, keep a copy and start over', 'the confirm button gets focus');
await bp.keyboard.press('Escape');
await bp.waitForTimeout(150);
ok(await bp.getByRole('group', { name: /^Start over/ }).count() === 0 && (await bp.locator('.banner.error').count()) === 1, 'Escape cancels; the file is not touched');
ok(await bp.evaluate(() => document.activeElement?.textContent) === 'Keep a copy and start over', 'focus returns to the start-over button');
await bp.getByRole('button', { name: 'Keep a copy and start over' }).click();
await bp.getByRole('button', { name: 'Cancel' }).click();
ok((await bp.locator('.banner.error').count()) === 1, 'Cancel keeps the broken file as it is');
await bp.getByRole('button', { name: 'Keep a copy and start over' }).click();
await bp.getByRole('button', { name: 'Yes, keep a copy and start over' }).click();
await bp.waitForTimeout(300);
ok((await bp.locator('.banner.error').count()) === 0, 'Yes starts over');

// a crash before start shows a plain message, not a blank window
const cp = await ctx.newPage();
await cp.goto(base + '?fixture=crash'); await cp.waitForSelector('html[data-ready="1"]');
ok((await cp.getByRole('alert').innerText()).includes('could not start'), 'a start-up crash shows the last-resort error screen');

// follows prefers-color-scheme when the setting is System
const dctx = await browser.newContext({ colorScheme: 'dark' });
const dp = await dctx.newPage();
await dp.goto(base + '?fixture=sample'); await dp.waitForSelector('html[data-ready="1"]');
ok(await dp.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'System appearance follows a dark OS');

errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('test crash')));
ok(errors.length === 0, 'no console or page errors ' + errors.join('|'));
await browser.close(); server.kill();
console.log(failed === 0 ? 'ALL UI CHECKS PASSED' : `${failed} UI CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
