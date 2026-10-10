// Where entries.json lives. Pure: the platform and the environment are passed in.
export type Platform = 'macos' | 'windows' | 'linux';
export interface EnvLike { [k: string]: string | undefined }
const trimTrailing = (p: string, sep: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
const isAbsolute = (p: string, platform: Platform) => (platform === 'windows' ? /^([A-Za-z]:[\\/]|\\\\)/.test(p) : p.startsWith('/'));

/**
 * 1. MONEYBAR_DATA_DIR (every test and manual run sets it)
 * 2. macOS ~/Library/Application Support/MoneyBar, Windows %APPDATA%\MoneyBar, Linux ${XDG_DATA_HOME:-~/.local/share}/MoneyBar
 */
export function defaultDataDir(platform: Platform, env: EnvLike, home: string): string {
  const o = env.MONEYBAR_DATA_DIR;
  if (o !== undefined && o.trim() !== '') return o;
  const sep = platform === 'windows' ? '\\' : '/';
  const h = trimTrailing(home, sep);
  switch (platform) {
    case 'macos': return `${h}/Library/Application Support/MoneyBar`;
    case 'windows': {
      const a = env.APPDATA && env.APPDATA.trim() !== '' ? env.APPDATA : `${h}\\AppData\\Roaming`;
      return `${trimTrailing(a, '\\')}\\MoneyBar`;
    }
    case 'linux': {
      const x = env.XDG_DATA_HOME;
      return `${x && isAbsolute(x, platform) ? trimTrailing(x, '/') : `${h}/.local/share`}/MoneyBar`;
    }
  }
}
export const ENTRIES_FILE = 'entries.json';
export const BACKUP_FILE = 'entries.backup.json';
export const DAILY_BACKUP_FILE = 'entries.backup-daily.json';
/** The only names the app may touch inside the data dir. Mirrored in src-tauri/src/files.rs. */
export const ALLOWED_FILE = /^entries(\.backup|\.backup-daily|\.broken-[0-9a-z-]{1,40})?\.json$/;
