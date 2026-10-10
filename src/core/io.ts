/** Whole microseconds since the epoch (integers, exact through JSON) and the inode as a decimal string. */
export interface FileStamp { size: number; mtimeUs: number; ctimeUs: number; ino: string; hash?: string }

/** Thrown by `write` when the file changed since the stamp it was told to expect (somebody else wrote it). */
export class ConflictError extends Error {
  constructor(message = 'CONFLICT: the file changed while it was being written') { super(message); this.name = 'ConflictError'; }
}
export const isConflict = (e: unknown): boolean => e instanceof ConflictError || (typeof e === 'string' && e.startsWith('CONFLICT')) || (e instanceof Error && e.message.startsWith('CONFLICT'));
/** Tauri rejects a command with a plain string, not an Error: show it either way. */
export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The door to the data folder. The Tauri build backs it with Rust commands that only touch allowed names inside it. */
export interface FileIO {
  /** null = the file does not exist */
  read(name: string): Promise<string | null>;
  stat(name: string): Promise<FileStamp | null>;
  /**
   * Atomic (temp file + fsync + rename). `expected` is a compare-and-swap: undefined = write without checking, null = the file
   * must not exist, a stamp = the file must still have exactly that stamp; otherwise a ConflictError is thrown and nothing is written.
   */
  write(name: string, text: string, expected?: FileStamp | null): Promise<void>;
  /** Keeps the file under a new unique `entries.broken-*` name (the one used is returned). */
  moveAside(name: string, backupName: string): Promise<string>;
  /** Deletes leftovers of interrupted atomic writes older than the given seconds (0 = all). Returns how many. */
  removeStrayTemps(olderThanSec: number): Promise<number>;
}
export const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && a.mtimeUs === b.mtimeUs && a.ctimeUs === b.ctimeUs && a.ino === b.ino && (a.hash ?? '') === (b.hash ?? ''));

/** Runs async jobs one after the other, so two clicks never interleave their load-modify-save steps. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
