// Test helpers: a Node-backed FileIO that behaves like the Rust one (atomic write, symlink kept), and a clock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, sameStamp } from '../src/core/io';
import type { FileIO, FileStamp } from '../src/core/io';
import { newId } from '../src/core/json';
import type { Entry } from '../src/core/model';
import type { Kind } from '../src/core/categories';

export function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'moneybar-test-')); }

export function statOf(file: string): FileStamp | null {
  try {
    const s = fs.statSync(file, { bigint: true });
    return { size: Number(s.size), mtimeUs: Number(s.mtimeNs / 1000n), ctimeUs: Number(s.ctimeNs / 1000n), ino: s.ino.toString() };
  } catch { return null; }
}

export function nodeIO(dir: string): FileIO & { dir: string; failWrites: boolean } {
  const p = (n: string) => path.join(dir, n);
  const real = (n: string) => { try { return fs.realpathSync(p(n)); } catch { return p(n); } };
  const io = {
    dir, failWrites: false,
    async read(n: string) { try { return fs.readFileSync(real(n), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
    async stat(n: string) { return statOf(p(n)); },
    async write(n: string, text: string, expected?: FileStamp | null) {
      if (io.failWrites) throw new Error('disk full (test)');
      fs.mkdirSync(dir, { recursive: true });
      // compare-and-swap, checked and written without an await in between (what the Rust side does under its file lock)
      if (expected !== undefined && !sameStamp(expected, statOf(p(n)))) throw new ConflictError();
      const target = real(n);
      const tmp = path.join(path.dirname(target), `.${n}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.renameSync(tmp, target);
    },
    async moveAside(n: string, _backup: string) { const to = `entries.broken-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`; fs.renameSync(real(n), p(to)); return to; },
    async removeStrayTemps(olderThanSec: number) {
      let n = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!/^\.entries.*\.tmp-/.test(f)) continue;
        if (olderThanSec > 0 && Date.now() - fs.statSync(p(f)).mtimeMs < olderThanSec * 1000) continue;
        fs.rmSync(p(f)); n++;
      }
      return n;
    },
  };
  return io;
}

/** Make the mtime differ even on coarse file systems. */
export function bumpMtime(file: string, secs = 5): void { const t = new Date(Date.now() + secs * 1000); fs.utimesSync(file, t, t); }

export class Clock { constructor(public ms: number) {} now = () => this.ms; }
/** noon UTC of a day key, in ms (the zone used by tests is UTC so "today" is the key). */
export const noon = (day: string): number => Date.parse(`${day}T12:00:00Z`);

let n = 0;
export function E(kind: Kind, cents: number, day: string, category = '', note = '', extra: Partial<Entry> = {}): Entry {
  return { id: newId(), kind, cents, category, note, day, created: 1_760_000_000 + n++, sample: false, ...extra };
}
