// The two whitespace sets of Foundation's CharacterSet, measured against the Mac app's Model.swift over U+0000..U+1FFFF
// and U+E0000..U+E0FFF (tests/unicode-parity.test.ts): `whitespacesAndNewlines` is tab, LF..CR, space, U+0085, U+00A0,
// U+1680, U+2000..U+200B (Apple counts the zero width space), U+2028, U+2029, U+202F, U+205F and U+3000;
// `whitespaces` is the same without the newlines (LF..CR, U+0085, U+2028, U+2029).
const SPACES = '\\t\\u0020\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000';
const NEWLINES = '\\n\\u000B\\u000C\\r\\u0085\\u2028\\u2029';
export const WS_NL = `[${SPACES}${NEWLINES}]`;
export const WS = `[${SPACES}]`;
export const reWsNl = new RegExp(WS_NL, 'u');
export const reWs = new RegExp(WS, 'u');
export const isWsNl = (ch: string): boolean => reWsNl.test(ch);
const trimNl = new RegExp(`^${WS_NL}+|${WS_NL}+$`, 'gu');
const trimSp = new RegExp(`^${WS}+|${WS}+$`, 'gu');
/** Swift trimmingCharacters(in: .whitespacesAndNewlines) */
export const trimWsNl = (s: string): string => s.replace(trimNl, '');
/** Swift trimmingCharacters(in: .whitespaces) */
export const trimWs = (s: string): string => s.replace(trimSp, '');
/** Swift components(separatedBy: .whitespacesAndNewlines) */
export const splitWsNl = (s: string): string[] => s.split(new RegExp(`${WS_NL}+`, 'u'));
