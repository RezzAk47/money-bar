import type { FileIO } from '../core/io';
import type { Platform } from '../core/datadir';
import type { Notifier } from '../core/store';

export interface ExportResult { ok: boolean; cancelled?: boolean; path?: string; error?: string }

/** Everything the app needs from the operating system. The Tauri build and the browser preview each provide one. */
export interface Backend {
  kind: 'tauri' | 'browser';
  platform: Platform;
  io: FileIO;
  /** Shown in Settings ("Stored only on this computer, in ..."). */
  dataDir: string;
  timeZone: string | undefined;
  /** The current time; the browser preview can pin it (fixture data). */
  now: () => number;
  /** null when notifications are switched off (MONEYBAR_NO_NOTIFICATIONS) or unavailable. */
  notifier: Notifier | null;
  setTrayLabel(label: string): Promise<void>;
  hide(): Promise<void>;
  /** A native menu (select) is opening: keep the popup open for a moment even if it loses focus to the menu. */
  holdOpen(): void;
  quit(): Promise<void>;
  revealData(): Promise<void>;
  autostart: { isEnabled(): Promise<boolean>; set(on: boolean): Promise<void> } | null;
  /** Called about every 2 seconds (from Rust in the app, a timer in the browser). Returns an unsubscribe. */
  onTick(cb: () => void): () => void;
  /** Called when the popup window is shown, so the page can move focus into it. */
  onShown(cb: () => void): () => void;
  /** Opens the native save dialog (in Rust) and writes the CSV to the chosen path (UTF-8 BOM added there). The page supplies no path. */
  exportCsv(text: string, suggestedName: string): Promise<ExportResult>;
  /** Only with MONEYBAR_SEED_SAMPLE=1 and a MONEYBAR_DATA_DIR override: fill an empty temp folder with fake data (manual runs). */
  seedSample?: boolean;
  /** MONEYBAR_SELFTEST=1 (with a data dir override): 50 saves through the real command path at start, result in the tray label. */
  selfTest?: boolean;
  /** An honest one-line note about this platform's tray. */
  trayNote: string | null;
}
