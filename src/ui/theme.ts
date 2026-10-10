// Turns the settings into CSS variables on <html>. Fills (charts, icons) use the plain theme tones; text uses the readable
// tones that reach 4.5:1 on the real backgrounds (see core/themes.ts and tests/misc.test.ts).
import type { Settings } from '../core/model';
import { blurLevel, glassAmount } from '../core/model';
import { BLUR_RADIUS, Glass, chartColors, textTones, toHex } from '../core/themes';
import type { RGB, Tone } from '../core/themes';

const pick = (t: Tone, dark: boolean): RGB => (dark ? t.dark : t.light);
export interface Look { dark: boolean }

export function applyTheme(s: Settings, dark: boolean, root: HTMLElement = document.documentElement): void {
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const c = chartColors(s.theme), t = textTones(s.theme);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.style = s.style;
  root.style.colorScheme = dark ? 'dark' : 'light';
  set('--spent', toHex(pick(c.spent, dark))); set('--earned', toHex(pick(c.earned, dark))); set('--tips', toHex(pick(c.tips, dark)));
  set('--spent-t', toHex(pick(t.spent, dark))); set('--earned-t', toHex(pick(t.earned, dark))); set('--tips-t', toHex(pick(t.tips, dark))); set('--loss-t', toHex(pick(t.loss, dark)));
  c.palette.forEach((p, i) => set(`--p${i}`, toHex(pick(p, dark))));
  const amount = glassAmount(s), blur = blurLevel(s);
  // The panel colour keeps at least 50 percent opacity, so text stays readable at 100 percent glass.
  set('--panel-alpha', String(Glass.panelAlpha(amount)));
  set('--blur', `${BLUR_RADIUS[blur]}px`);
  const a = Glass.blobAlpha(dark);
  const hex = (i: number, al: number) => toHex(pick(c.palette[i], dark)) + Math.round(al * 255).toString(16).padStart(2, '0');
  const glassy = s.style === 'glass' || amount > 0;
  set('--backdrop', glassy
    ? `radial-gradient(circle at 18% 12%, ${hex(0, a)}, transparent 55%), radial-gradient(circle at 85% 40%, ${hex(1, a)}, transparent 50%), radial-gradient(circle at 30% 90%, ${hex(2, a)}, transparent 55%), linear-gradient(135deg, ${hex(0, Glass.tintAlpha / 3)}, ${hex(3, Glass.tintAlpha / 3)})`
    : 'none');
}
