// Made-up data for the browser preview, the Playwright screenshots and the manual seed: never anyone's real money.
import { defaultSettings, encodeMoneyFile } from './model';
import type { Entry, Settings } from './model';
import { sampleEntries } from './sample';
import { entryId } from './recurring';
import type { RecurringRule } from './recurring';

export const PREVIEW_TODAY = '2026-10-20';
export const PREVIEW_NOW = Date.parse('2026-10-20T19:30:00Z');

export function previewFile(fixture: string, settingsJson: string | null): { json: string; now: number } {
  if (fixture === 'broken') return { json: '{"entries":[{"kind":"expense","cents":12.5,"date":"2026-10-05"}]}', now: PREVIEW_NOW };
  const settings: Settings = defaultSettings();
  if (settingsJson) { try { Object.assign(settings, JSON.parse(settingsJson)); } catch { /* ignore */ } }
  if (fixture === 'empty') return { json: encodeMoneyFile({ version: 1, settings, entries: [] }), now: PREVIEW_NOW };
  settings.budgets = { Food: 24000, Transport: 6500, School: 40000, Bills: 15000, Fun: 11000 };
  const rule = (id: string, kind: Entry['kind'], cents: number, category: string, note: string, repeatKind: RecurringRule['repeatKind'], start: string, interval = 1, paused = false, last?: string): RecurringRule =>
    ({ id, kind, cents, category, note, repeatKind, interval, start, paused, ...(last ? { last } : {}) });
  settings.recurring = [
    rule('00000000-0000-4000-8000-00000000A001', 'expense', 120000, 'Rent', 'Sample rent', 'monthly', '2026-10-01', 1, false, '2026-10-01'),
    rule('00000000-0000-4000-8000-00000000A002', 'expense', 25000, 'Debt payment', 'Card payment', 'monthly', '2026-10-05', 1, false, '2026-10-05'),
    rule('00000000-0000-4000-8000-00000000A003', 'expense', 1599, 'Fun', 'Sample: streaming', 'days', '2026-10-20', 14, false, '2026-10-20'),
    rule('00000000-0000-4000-8000-00000000A004', 'income', 20000, 'Job', 'Sample pay', 'weekly', '2026-10-02', 1, true),
  ];
  const entries: Entry[] = sampleEntries(PREVIEW_TODAY);
  entries.push({ id: entryId(settings.recurring[2], '2026-10-20'), kind: 'expense', cents: 1599, category: 'Fun', note: 'Sample: streaming', day: '2026-10-20', created: PREVIEW_NOW / 1000, sample: true, recurringID: settings.recurring[2].id });
  entries.push({ id: '00000000-0000-4000-8000-00000000B001', kind: 'expense', cents: 25000, category: 'Debt payment', note: 'Card payment', day: '2026-10-20', created: PREVIEW_NOW / 1000 - 5, sample: true });
  entries.push({ id: '00000000-0000-4000-8000-00000000B002', kind: 'expense', cents: 899, category: 'غذا', note: 'ناهار با دوستان', day: '2026-10-19', created: PREVIEW_NOW / 1000 - 9, sample: true });
  return { json: encodeMoneyFile({ version: 1, settings, entries }), now: PREVIEW_NOW };
}
