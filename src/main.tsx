import { render } from 'preact';
import { App } from './ui/app';
import { Controller } from './ui/controller';
import type { Backend } from './backend/types';
import { memoryBackend } from './backend/memory';
import { previewFile } from './core/preview';
import { applyTheme } from './ui/theme';
import { defaultSettings } from './core/model';
import { newId } from './core/json';
import * as Civil from './core/civil';

async function pickBackend(): Promise<Backend> {
  const inTauri = typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  if (inTauri) return (await import('./backend/tauri')).tauriBackend();
  // Browser preview: made-up fixture data, never a real file. ?fixture=sample|empty|broken ; &settings={json}
  const q = new URLSearchParams(location.search);
  const fixture = q.get('fixture') ?? 'sample';
  if (fixture === 'crash') throw new Error('test crash before start');
  const f = previewFile(fixture, q.get('settings'));
  return memoryBackend({ entriesJson: f.json, now: f.now, timeZone: 'UTC' });
}

/** Last resort: if the page itself cannot start, say so in plain text instead of a blank window. */
function showFatal(e: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'fatal'; box.setAttribute('role', 'alert');
  const h = document.createElement('h1'); h.textContent = 'Money Bar could not start';
  const p = document.createElement('p'); p.textContent = e instanceof Error ? e.message : String(e);
  const q = document.createElement('p'); q.textContent = 'Your data was not changed. Quit from the tray menu and open the app again; if this keeps happening, check that entries.json is a normal UTF-8 text file.';
  box.append(h, p, q);
  root.append(box);
  document.documentElement.dataset.ready = '1';
}

async function main() {
  const backend = await pickBackend();
  if (backend.kind === 'browser') {
    // "now" moves forward from the fixture time so the page is stable but alive.
    const t0 = Date.now(), base = backend.now();
    backend.now = () => base + (Date.now() - t0);
  }
  const ctl = new Controller(backend);
  applyTheme(defaultSettings(), window.matchMedia('(prefers-color-scheme: dark)').matches);
  await ctl.init();
  if (backend.seedSample && ctl.store.loadError === null && ctl.store.entries.length === 0) {
    // a manual run against a temp folder: fake entries, a budget and a recurring rule, so the file has every kind of content
    await ctl.store.loadSample();
    await ctl.store.setBudget('Food', 24000);
    await ctl.store.addRule({ id: newId(), kind: 'expense', cents: 120000, category: 'Rent', note: 'Sample rent', repeatKind: 'monthly', interval: 1, start: Civil.addDays(ctl.store.todayKey, -40), paused: false });
  }
  // a native <select> menu may take the focus from the popup: hold it open for a moment when one is touched
  const hold = (e: Event) => { if ((e.target as Element | null)?.closest?.('select')) backend.holdOpen(); };
  document.addEventListener('pointerdown', hold, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') hold(e); }, true);
  (window as unknown as { __ctl: Controller }).__ctl = ctl;
  if (backend.selfTest) void ctl.runSelfTest();
  render(<App ctl={ctl} />, document.getElementById('root')!);
  document.documentElement.dataset.ready = '1';
}
window.addEventListener('unhandledrejection', (ev) => {
  ev.preventDefault();
  const ctl = (window as unknown as { __ctl?: Controller }).__ctl;
  if (ctl) ctl.reportError(ev.reason); else showFatal(ev.reason);
});
window.addEventListener('error', (ev) => { if (!(window as unknown as { __ctl?: Controller }).__ctl) showFatal(ev.error ?? ev.message); });
main().catch(showFatal);
