/**
 * Text for an OS notification: no `<`, `>` or `&` (some Linux notification daemons render markup), control characters
 * become spaces, runs of white space collapse, and at most `max` characters are kept. Same rule as agents-bar.
 */
export function notificationText(text: string, max: number): string {
  const kept = Array.from(text).filter((c) => c !== '<' && c !== '>' && c !== '&').map((c) => (/\p{Cc}/u.test(c) ? ' ' : c)).join('');
  return Array.from(kept.split(/\s+/).filter(Boolean).join(' ')).slice(0, max).join('');
}
