import { describe, expect, it } from 'vitest';
import { notificationText } from '../src/core/notifytext';

describe('notificationText', () => {
  it('strips markup characters and control characters (a category name is typed by the user)', () => {
    expect(notificationText('<b>Food</b> & <a href=x>drink</a>\n\u0007done', 100)).toBe('bFood/b a href=xdrink/a done');
  });
  it('collapses white space and caps the length by characters, not UTF-16 units', () => {
    expect(notificationText('  a   b  ', 10)).toBe('a b');
    expect(Array.from(notificationText('😀'.repeat(500), 120)).length).toBe(120);
  });
  it('keeps Persian text and joiners', () => {
    expect(notificationText('بودجه غذا', 50)).toBe('بودجه غذا');
  });
});
