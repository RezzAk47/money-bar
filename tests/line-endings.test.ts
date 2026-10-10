import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Tracked text files must be LF on every OS (.gitattributes `* text=auto eol=lf`): tests compare files and fixtures byte for byte.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(ts|tsx|mjs|js|json|css|html|md|yml|toml|rs|lock|sh|txt|gitattributes|gitignore)$|^\.gitattributes$|^\.gitignore$/;
function tracked(): string[] | null {
  try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return null; }
}
describe('line endings', () => {
  it('tracked text files and fixtures contain no carriage return, and .gitattributes asks for LF', () => {
    const attrs = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
    expect(attrs).toContain('* text=auto eol=lf');
    expect(attrs).toContain('*.png binary');
    const files = tracked();
    if (files === null) return; // not a git checkout (a source archive): nothing to list
    const bad = files.filter((f) => TEXT.test(f) && fs.existsSync(path.join(root, f)) && fs.readFileSync(path.join(root, f), 'utf8').includes('\r'));
    expect(bad).toEqual([]);
  });
});
