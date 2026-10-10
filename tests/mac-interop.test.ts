// Reads a file written by the Mac app's own Model.swift (compiled in a scratch dir). Skipped unless MAC_FILE is set.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMoneyFile, encodeMoneyFile } from '../src/core/model';

const file = process.env.MAC_FILE;
describe.skipIf(!file)('a file written by the Mac app', () => {
  it('decodes with every field, and writes back something the Mac app reads', () => {
    const f = decodeMoneyFile(fs.readFileSync(file!, 'utf8'));
    expect(f.entries.some((e) => e.category === 'Café' && e.note === 'مرور ✓' && e.cents === 1234)).toBe(true);
    expect(f.entries.some((e) => e.kind === 'tip' && e.category === '')).toBe(true);
    expect(f.settings).toMatchObject({ theme: 'grape', glass: 40, budgets: { Food: 5000 } });
    expect(f.settings.recurring[0]).toMatchObject({ repeatKind: 'monthly', cents: 9900, start: '2026-09-30' });
    expect(f.entries.some((e) => e.recurringID === f.settings.recurring[0].id)).toBe(true);
    if (process.env.MAC_OUT) fs.writeFileSync(process.env.MAC_OUT, encodeMoneyFile(f));
  });
});
