// Plain year-month-day arithmetic with no time zone (a port of Civil in Model.swift). Entry days are "yyyy-MM-dd" text,
// so periods, recurring dates and day counts never move on DST days, and a day with no midnight (America/Sao_Paulo
// 2018-11-04) is just another day. Only "what is today" needs a zone; see dayKeyAt.

export interface Parts { y: number; m: number; d: number }

export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export function daysInMonth(y: number, m: number): number {
  switch (m) { case 2: return isLeap(y) ? 29 : 28; case 4: case 6: case 9: case 11: return 30; default: return 31; }
}

/** Strictly "yyyy-MM-dd" and a real date (year 1 to 9999). */
export function parts(key: string): Parts | null {
  if (typeof key !== 'string' || key.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)), d = Number(key.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}
export const isValidDay = (key: string): boolean => parts(key) !== null;

export function daysOfParts(p: Parts): number {
  const y = p.m <= 2 ? p.y - 1 : p.y;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (p.m > 2 ? p.m - 3 : p.m + 9) + 2) / 5) + p.d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** Days since 1970-01-01, or null when the text is not a real date. */
export function days(key: string): number | null { const p = parts(key); return p ? daysOfParts(p) : null; }

const pad = (n: number, w: number) => String(n).padStart(w, '0');
export const keyOf = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

export function keyOfDays(z0: number): string {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return keyOf(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
}

/** The day `n` days from `key`, held inside the years 1 to 9999 (never a five digit year). */
export const addDays = (key: string, n: number): string => keyOfDays(Math.min(MAX_DAY, Math.max(MIN_DAY, (days(key) ?? 0) + n)));
/** 1 = Sunday ... 7 = Saturday (the Calendar weekday numbers the Mac app and weekStart use). */
export const weekday = (key: string): number => (((days(key) ?? 0) + 4) % 7 + 7) % 7 + 1;
export const MAX_DAY = daysOfParts({ y: 9999, m: 12, d: 31 });
export const MIN_DAY = daysOfParts({ y: 1, m: 1, d: 1 });

/** The first day of the month `steps` months from the month of `key`; null outside years 1 to 9999. */
export function addMonthsFirst(key: string, steps: number): string | null {
  const p = parts(key); if (!p) return null;
  const idx = p.y * 12 + p.m - 1 + steps;
  const y = Math.floor(idx / 12), m = idx - y * 12 + 1;
  return y < 1 || y > 9999 ? null : keyOf(y, m, 1);
}

// ---- "today" in a time zone (the only place a zone matters)

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function systemTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
/** The local calendar day of an instant in an IANA zone (default: the system zone). */
export function dayKeyAt(ms: number, timeZone: string = systemTimeZone()): string {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });
    if (fmtCache.size > 32) fmtCache.clear();
    fmtCache.set(timeZone, f);
  }
  const ps = f.formatToParts(new Date(ms));
  const get = (t: string) => Number(ps.find((p) => p.type === t)?.value ?? 0);
  const era = ps.find((p) => p.type === 'era')?.value ?? 'AD';
  const y = era.startsWith('B') ? 1 : get('year');
  return keyOf(Math.min(9999, Math.max(1, y)), get('month'), get('day'));
}

const localOk = new Map<string, boolean>();
/**
 * True when the day exists as a local calendar day in the zone: a real date and not one the zone skipped (Pacific/Apia
 * 2011-12-30, Pacific/Kiritimati 1994-12-31). The Mac app checks the same way, by parsing the day at local noon and formatting it back.
 */
export function isValidLocalDay(key: string, timeZone: string = systemTimeZone()): boolean {
  const p = parts(key);
  if (!p) return false;
  const ck = `${timeZone}|${key}`;
  const hit = localOk.get(ck);
  if (hit !== undefined) return hit;
  const noon = Date.UTC(p.y, p.m - 1, p.d, 12);
  let ok = false;
  if (p.y < 1000 || p.y > 9000) ok = true; // far from every zone change; Intl's old-date zone data is not worth trusting
  else for (const h of [0, -12, -6, 6, 12, -14, 14, -10, 10, -3, 3, -8, 8, -1, 1]) { if (dayKeyAt(noon + h * 3600_000, timeZone) === key) { ok = true; break; } }
  if (localOk.size > 20000) localOk.clear();
  localOk.set(ck, ok);
  return ok;
}
