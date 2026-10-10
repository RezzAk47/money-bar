import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
/** A text file with line endings normalised: a Windows checkout may turn LF into CRLF (.gitattributes asks for LF, but the test must not depend on it). */
const text = (rel: string): string => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const ci = text('../.github/workflows/ci.yml');
describe('CI workflow hardening', () => {
  it('has read-only permissions, a concurrency group, a timeout on every job and every action pinned to a full commit SHA', () => {
    expect(ci).toMatch(/^permissions:\n  contents: read/m);
    expect(ci).toMatch(/^concurrency:\n  group: .*\n  cancel-in-progress: true/m);
    for (const l of ci.split('\n').filter(x => /^\s*(- )?uses:/.test(x))) expect(l).toMatch(/uses: \S+@[0-9a-f]{40}( |$)/);
    const jobs = ci.split(/^  [a-z-]+:\n    name:/m).length - 1;
    expect((ci.match(/timeout-minutes: 30/g) ?? []).length).toBe(jobs);
    expect(ci).not.toContain('python');
  });
  it('requires Rust 1.90 in Cargo.toml', () => { expect(text('../src-tauri/Cargo.toml')).toMatch(/rust-version = "1\.90"/); });
});
