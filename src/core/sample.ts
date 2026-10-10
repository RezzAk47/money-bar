// Clearly fake entries, flagged "sample": true so they can be cleared (Sample in Model.swift).
import * as Civil from './civil';
import { newId } from './json';
import type { Entry } from './model';

export function sampleEntries(today: string): Entry[] {
  const out: Entry[] = [];
  const spend: [string, number, string][] = [['Food', 1450, 'Sample: lunch'], ['Transport', 325, 'Sample: bus'], ['Fun', 1800, 'Sample: movie'], ['Bills', 4500, 'Sample: phone'], ['School', 2200, 'Sample: supplies']];
  const t0 = Civil.days(today) ?? 0;
  const mk = (kind: Entry['kind'], cents: number, category: string, note: string, day: string, created: number): Entry => ({ id: newId(), kind, cents, category, note, day, created, sample: true });
  for (let back = 0; back < 28; back++) {
    const key = Civil.keyOfDays(t0 - back);
    const created = (t0 - back) * 86400 + 43200;
    if (back % 7 !== 3) {
      out.push(mk('income', 9000 + (back % 5) * 1250, 'Job', 'Sample shift', key, created));
      out.push(mk('tip', 4000 + (back % 4) * 1100, back % 2 === 0 ? 'Card' : 'Cash', '', key, created));
    }
    const s = spend[back % spend.length];
    out.push(mk('expense', s[1] + (back % 3) * 175, s[0], s[2], key, created));
    if (back % 4 === 0) out.push(mk('expense', 1275, 'Food', 'Sample: dinner', key, created));
  }
  out.push(mk('expense', 95000, 'Rent', 'Sample: rent', Civil.keyOfDays(t0 - 20), t0 * 86400));
  return out;
}
