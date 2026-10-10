// CSV export (a port of CSV in Model.swift): RFC 4180 quoting, spreadsheet formulas defused, the BOM added only at save time.
import { plainMoney } from './money';
import { KIND_LABEL } from './model';
import type { Report } from './reports';
import { net } from './reports';

import { isWsNl } from './ws';
/** Quotes when needed, and defuses spreadsheet formulas ("=...", "+...", "-...", "@..."). */
export function csvCell(s: string): string {
  let t = s;
  for (const ch of s) {
    if (!isWsNl(ch) || ch === '\t' || ch === '\r') {
      if ('=+-@\t\r'.includes(ch)) t = "'" + t;
      break;
    }
  }
  if (/[,"\n\r]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
  return t;
}
export const CSV_BOM = '﻿';
/** What is written to the file: a UTF-8 byte order mark in front, so Excel reads Persian and accented text correctly. */
export const csvFileText = (r: Report): string => CSV_BOM + csvExport(r);

export function csvExport(r: Report): string {
  const rows: string[] = [];
  const row = (cells: string[]) => rows.push(cells.join(','));
  const dc = r.dayCount;
  row(['Money Bar report']); row(['From', r.range.start]); row(['To', r.range.end]);
  row(['Days in period', String(dc)]); row(['Days with entries', String(r.activeDays)]);
  rows.push('');
  row(['Summary', 'Total', 'Average per day (all days)', 'Average per day (days with entries)']);
  row(['Spent', plainMoney(r.totals.spent), plainMoney(r.avgAllDays.spent), plainMoney(r.avgActiveDays.spent)]);
  row(['Earned (wages)', plainMoney(r.totals.earned), plainMoney(r.avgAllDays.earned), plainMoney(r.avgActiveDays.earned)]);
  row(['Tips', plainMoney(r.totals.tips), plainMoney(r.avgAllDays.tips), plainMoney(r.avgActiveDays.tips)]);
  row(['Net', plainMoney(net(r.totals)), plainMoney(r.avgNetAllDays), plainMoney(r.avgNetActiveDays)]);
  if (r.totals.debtPaid > 0) row(['Paid toward card debt (not counted in Spent or Net)', plainMoney(r.totals.debtPaid)]);
  row(['Average tip per day worked (days with a tip)', plainMoney(r.avgTipPerTipDay)]);
  rows.push('');
  row(['Spending by category', 'Amount', 'Percent of spending']);
  for (const c of r.categories) row([csvCell(c.name), plainMoney(c.cents), String(Math.round(c.percent))]);
  rows.push('');
  row(['Day', 'Spent', 'Earned', 'Tips', 'Net', 'Entries']);
  for (const d of r.daily) row([d.day, plainMoney(d.totals.spent), plainMoney(d.totals.earned), plainMoney(d.totals.tips), plainMoney(net(d.totals)), String(d.count)]);
  rows.push('');
  // The Recurring column exists only when the report has an entry made by a recurring rule, so other exports are unchanged.
  const anyRecurring = r.entries.some((e) => e.recurringID !== undefined);
  row(['Date', 'Type', 'Amount', 'Category / source / tip method', 'Note', ...(anyRecurring ? ['Recurring'] : [])]);
  for (const e of [...r.entries].reverse()) row([e.day, KIND_LABEL[e.kind], plainMoney(e.cents), csvCell(e.category), csvCell(e.note), ...(anyRecurring ? [e.recurringID !== undefined ? 'Yes' : ''] : [])]);
  return rows.join('\r\n') + '\r\n';
}
