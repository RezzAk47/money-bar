// The browser preview backend: an in-memory data folder. Used by `vite dev`, the Playwright screenshots and the CI
// screenshot job. It never touches a real file.
import type { Backend } from './types';
import { ConflictError, sameStamp } from '../core/io';
import type { FileIO, FileStamp } from '../core/io';
import { ENTRIES_FILE } from '../core/datadir';
import type { Platform } from '../core/datadir';
import { CSV_BOM } from '../core/csv';

export class MemoryIO implements FileIO {
  files = new Map<string, { text: string; stamp: FileStamp }>();
  private counter = 1;
  async read(name: string) { return this.files.get(name)?.text ?? null; }
  async stat(name: string) { return this.files.get(name)?.stamp ?? null; }
  async write(name: string, text: string, expected?: FileStamp | null) {
    if (expected !== undefined && !sameStamp(expected, this.files.get(name)?.stamp ?? null)) throw new ConflictError();
    const n = this.counter++;
    this.files.set(name, { text, stamp: { size: text.length, mtimeUs: 1_000_000_000 + n, ctimeUs: 1_000_000_000 + n, ino: String(n) } });
  }
  async moveAside(name: string, _backup: string) {
    const f = this.files.get(name);
    const to = `entries.broken-${Date.now()}-${(this.counter++).toString(36)}.json`;
    if (f) { this.files.set(to, f); this.files.delete(name); }
    return to;
  }
  async removeStrayTemps() { return 0; }
}

function detect(ua: string): Platform { return /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'macos' : 'linux'; }

export interface MemoryOptions { entriesJson?: string; now?: number; timeZone?: string }

export function memoryBackend(opts: MemoryOptions = {}): Backend & { io: MemoryIO } {
  const io = new MemoryIO();
  if (opts.entriesJson !== undefined) void io.write(ENTRIES_FILE, opts.entriesJson);
  const listeners = new Set<() => void>();
  setInterval(() => listeners.forEach((l) => l()), 2000);
  return {
    kind: 'browser',
    platform: detect(navigator.userAgent),
    io,
    dataDir: '(browser preview: nothing is saved)',
    timeZone: opts.timeZone,
    now: opts.now !== undefined ? () => opts.now! : Date.now,
    notifier: null,
    async setTrayLabel() {},
    async hide() {},
    holdOpen() {},
    async quit() {},
    async revealData() {},
    autostart: null,
    onTick(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onShown() { return () => {}; },
    async exportCsv(text, name) {
      const url = URL.createObjectURL(new Blob([CSV_BOM + text], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true, path: name };
    },
    trayNote: null,
  };
}
