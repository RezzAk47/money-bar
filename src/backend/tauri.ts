// The desktop backend: talks to the Rust side (src-tauri) through a handful of commands. The Rust side only ever touches
// the allowed file names inside the data folder, plus the one CSV file the user picks in the save dialog.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { Backend } from './types';
import { ConflictError } from '../core/io';
import type { FileStamp } from '../core/io';
import type { Platform } from '../core/datadir';
import type { Notifier } from '../core/store';
import { notificationText } from '../core/notifytext';

/** Tauri rejects with a plain string: make it an Error, and a conflict a ConflictError. */
async function call<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
    throw msg.startsWith('CONFLICT') ? new ConflictError(msg) : new Error(msg);
  }
}

interface AppInfo { platform: Platform; dataDir: string; noNotifications: boolean; seedSample: boolean; selfTest: boolean; trayNote: string | null }

/** Budget alerts: delivered only when the system allows it; the store records an alert as sent after this resolves true. */
function makeNotifier(): Notifier {
  return {
    async requestAuthorization() { if (!(await isPermissionGranted())) await requestPermission(); },
    async send(title, body) {
      try {
        if (!(await isPermissionGranted())) return false;
        sendNotification({ title: notificationText(title, 120), body: notificationText(body, 300) });
        return true;
      } catch { return false; }
    },
  };
}

export async function tauriBackend(): Promise<Backend> {
  const info = await invoke<AppInfo>('app_info');
  const sep = info.platform === 'windows' ? '\\' : '/';
  const sub = (event: string) => (cb: () => void) => {
    let off: (() => void) | null = null, dead = false;
    void listen(event, cb).then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  };
  return {
    kind: 'tauri',
    platform: info.platform,
    dataDir: info.dataDir,
    timeZone: undefined,
    now: Date.now,
    notifier: info.noNotifications ? null : makeNotifier(),
    trayNote: info.trayNote,
    seedSample: info.seedSample,
    selfTest: info.selfTest,
    io: {
      read: (name) => call(invoke<string | null>('fs_read', { name })),
      stat: (name) => call(invoke<FileStamp | null>('fs_stat', { name })),
      write: (name, text, expected) => call(invoke<void>('fs_write', { name, text, check: expected !== undefined, expected: expected ?? null })),
      moveAside: (name, backupName) => call(invoke<string>('fs_move_aside', { name, backupName })),
      removeStrayTemps: (olderThanSec) => call(invoke<number>('fs_clean_temps', { olderThanSec })),
    },
    setTrayLabel: (label) => invoke<void>('set_tray_label', { label }),
    hide: () => invoke<void>('hide_popup'),
    holdOpen: () => { void invoke('hold_popup_open').catch(() => {}); },
    quit: () => invoke<void>('quit_app'),
    revealData: () => revealItemInDir(`${info.dataDir}${sep}entries.json`),
    autostart: { isEnabled: () => isEnabled(), set: (on) => (on ? enable() : disable()) },
    onTick: sub('tick'),
    onShown: sub('popup-shown'),
    // The Rust command opens the save dialog itself and writes only to the path it returns: the page never supplies a path.
    async exportCsv(text, suggestedName) {
      try {
        const path = await invoke<string | null>('export_csv', { text, suggestedName });
        return path ? { ok: true, path } : { ok: false, cancelled: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
  };
}
