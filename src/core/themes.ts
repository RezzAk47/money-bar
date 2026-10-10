// Appearance as pure data (a port of Glass, ThemeColors and ThemeName in Model.swift), so contrast can be tested.
export type RGB = [number, number, number];
export interface Tone { light: RGB; dark: RGB }
export const THEME_NAMES = ['classic', 'ocean', 'sunset', 'grape', 'mono'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export const THEME_LABEL: Record<ThemeName, string> = { classic: 'Classic', ocean: 'Ocean', sunset: 'Sunset', grape: 'Grape', mono: 'Mono' };

export const Glass = {
  clamp: (n: number): number => Math.min(Math.max(n, 0), 100),
  step: 5,
  defaultAmount: (style: UIStyle): number => (style === 'glass' ? 60 : 0),
  defaultBlur: (style: UIStyle): BlurLevel => (style === 'glass' ? 'light' : 'medium'),
  minPanelAlpha: 0.5,
  panelAlpha(amount: number): number { const g = Glass.clamp(amount) / 100; return Math.max(Glass.minPanelAlpha, 1 - g * (1 - Glass.minPanelAlpha)); },
  blobAlpha: (dark: boolean): number => (dark ? 0.14 : 0.26),
  tintAlpha: 0.28,
  luminance(c: RGB): number {
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  },
  contrast(a: RGB, b: RGB): number { const x = Glass.luminance(a), y = Glass.luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); },
  mix(top: RGB, alpha: number, over: RGB): RGB { return [0, 1, 2].map((i) => top[i] * alpha + over[i] * (1 - alpha)) as RGB; },
};
export type UIStyle = 'cards' | 'list' | 'glass';
export type BlurLevel = 'off' | 'light' | 'medium' | 'strong';
export const BLUR_RADIUS: Record<BlurLevel, number> = { off: 0, light: 5, medium: 12, strong: 26 };

export interface ThemeColors { spent: Tone; earned: Tone; tips: Tone; loss: Tone; palette: Tone[] }

const lightBackgrounds: RGB[] = [[1, 1, 1], [0.925, 0.925, 0.925]];
const darkBackgrounds: RGB[] = [[0.118, 0.118, 0.118], [0.2, 0.2, 0.2]];
export const TEXT_RATIO = 4.6;
const tintAlphas = [0.06, 0.12];
const lightTinted = lightBackgrounds.flatMap((bg) => tintAlphas.map((a) => Glass.mix([0, 0, 0], a, bg)));
const darkTinted = darkBackgrounds.flatMap((bg) => tintAlphas.map((a) => Glass.mix([1, 1, 1], a, bg)));
export const LIGHT_BACKGROUNDS = lightBackgrounds, DARK_BACKGROUNDS = darkBackgrounds, LIGHT_TINTED = lightTinted, DARK_TINTED = darkTinted;

/** A text version of an accent: darkened in light mode (lightened in dark mode) with the hue kept, until it reaches 4.6:1 on the real backgrounds. */
export function readable(t: Tone, onTint = false): Tone {
  const worst = (c: RGB, bgs: RGB[]) => Math.min(21, ...bgs.map((b) => Glass.contrast(c, b)));
  const la = [...lightBackgrounds, ...(onTint ? lightTinted : [])], da = [...darkBackgrounds, ...(onTint ? darkTinted : [])];
  let l = t.light, d = t.dark, n = 0;
  while (worst(l, la) < TEXT_RATIO && n < 200) { l = l.map((v) => v * 0.97) as RGB; n++; }
  n = 0;
  while (worst(d, da) < TEXT_RATIO && n < 200) { d = d.map((v) => v + (1 - v) * 0.04) as RGB; n++; }
  return { light: l, dark: d };
}
const T = (l: RGB, d: RGB): Tone => ({ light: l, dark: d });
const neutral = T([0.45, 0.45, 0.5], [0.7, 0.7, 0.75]);

export function themeColors(name: ThemeName): ThemeColors {
  switch (name) {
    case 'classic': {
      const spent = T([0.85, 0.38, 0.08], [1, 0.62, 0.3]), earned = T([0.08, 0.54, 0.27], [0.35, 0.85, 0.52]), tips = T([0.05, 0.46, 0.72], [0.4, 0.75, 1]);
      return { spent, earned, tips, loss: T([0.78, 0.12, 0.16], [1, 0.45, 0.45]), palette: [spent, tips, T([0.5, 0.25, 0.75], [0.75, 0.55, 1]), earned, T([0.8, 0.2, 0.45], [1, 0.5, 0.7]), T([0.6, 0.5, 0.05], [0.95, 0.85, 0.35]), T([0.1, 0.55, 0.55], [0.4, 0.85, 0.85]), neutral] };
    }
    case 'ocean': {
      const spent = T([0.93, 0.42, 0.35], [1, 0.6, 0.52]), earned = T([0, 0.5, 0.62], [0.25, 0.82, 0.88]), tips = T([0.15, 0.32, 0.8], [0.5, 0.65, 1]);
      return { spent, earned, tips, loss: T([0.8, 0.15, 0.25], [1, 0.48, 0.52]), palette: [earned, tips, T([0.1, 0.62, 0.5], [0.35, 0.88, 0.72]), spent, T([0.85, 0.6, 0.15], [1, 0.82, 0.45]), T([0.6, 0.3, 0.75], [0.82, 0.6, 0.95]), T([0.2, 0.6, 0.9], [0.5, 0.8, 1]), neutral] };
    }
    case 'sunset': {
      const spent = T([0.78, 0.15, 0.35], [1, 0.45, 0.62]), earned = T([0.85, 0.5, 0], [1, 0.75, 0.25]), tips = T([0.6, 0.22, 0.62], [0.88, 0.58, 0.92]);
      return { spent, earned, tips, loss: T([0.7, 0.08, 0.12], [1, 0.4, 0.4]), palette: [earned, spent, tips, T([0.9, 0.35, 0.15], [1, 0.58, 0.38]), T([0.65, 0.4, 0.05], [0.92, 0.72, 0.4]), T([0.5, 0.2, 0.45], [0.8, 0.5, 0.78]), T([0.85, 0.28, 0.25], [1, 0.52, 0.48]), neutral] };
    }
    case 'grape': {
      const spent = T([0.82, 0.25, 0.55], [1, 0.55, 0.78]), earned = T([0.38, 0.22, 0.78], [0.7, 0.58, 1]), tips = T([0.1, 0.55, 0.62], [0.4, 0.85, 0.9]);
      return { spent, earned, tips, loss: T([0.75, 0.1, 0.22], [1, 0.45, 0.55]), palette: [earned, spent, tips, T([0.55, 0.35, 0.85], [0.82, 0.7, 1]), T([0.7, 0.3, 0.7], [0.92, 0.62, 0.92]), T([0.25, 0.4, 0.8], [0.58, 0.7, 1]), T([0.6, 0.5, 0.1], [0.95, 0.85, 0.4]), neutral] };
    }
    case 'mono': {
      const spent = T([0.3, 0.3, 0.33], [0.64, 0.64, 0.67]), earned = T([0.08, 0.08, 0.1], [0.96, 0.96, 0.98]), tips = T([0.55, 0.55, 0.58], [0.8, 0.8, 0.83]);
      return { spent, earned, tips, loss: T([0.45, 0.45, 0.48], [0.8, 0.8, 0.84]), palette: Array.from({ length: 8 }, (_, i) => { const v = 0.12 + i * 0.075; return T([v, v, v + 0.02], [1 - v * 0.9, 1 - v * 0.9, 1 - v * 0.9 + 0.02]); }) };
    }
  }
}
export interface TextTones { spent: Tone; earned: Tone; tips: Tone; loss: Tone }
/** The text versions of the four accents; fills (charts, icons) keep the plain tones. */
export function textTones(name: ThemeName): TextTones {
  const c = themeColors(name);
  return { spent: readable(c.spent), earned: readable(c.earned), tips: readable(c.tips), loss: readable(c.loss, true) };
}
export const toHex = (c: RGB): string => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// ---- chart fills (non-text contrast, WCAG 1.4.11: at least 3:1 against what they are drawn on)
export const NON_TEXT_RATIO = 3;
/** What charts are drawn on: the card (white, near-black grey) or, in the List layout, the panel. */
export const CHART_BG_LIGHT: RGB[] = [[1, 1, 1], [0.961, 0.961, 0.969]];
export const CHART_BG_DARK: RGB[] = [[0.173, 0.173, 0.18], [0.118, 0.118, 0.118]];
function fillTone(t: Tone): Tone {
  const worst = (c: RGB, bgs: RGB[]) => Math.min(21, ...bgs.map((b) => Glass.contrast(c, b)));
  let l = t.light, d = t.dark, n = 0;
  while (worst(l, CHART_BG_LIGHT) < NON_TEXT_RATIO + 0.02 && n < 200) { l = l.map((v) => v * 0.98) as RGB; n++; }
  n = 0;
  while (worst(d, CHART_BG_DARK) < NON_TEXT_RATIO + 0.02 && n < 200) { d = d.map((v) => v + (1 - v) * 0.03) as RGB; n++; }
  return { light: l, dark: d };
}
/** The theme's fills for bars, lines, donut segments and icons: the plain tones, darkened or lightened only as far as 3:1 needs. */
export function chartColors(name: ThemeName): ThemeColors {
  const c = themeColors(name);
  if (name === 'mono') {
    // eight evenly spaced greys that all stay at 3:1 or more (the old ramp ran into the background at one end)
    const ramp = Array.from({ length: 8 }, (_, i) => T([0.06 + i * 0.063, 0.06 + i * 0.063, 0.08 + i * 0.063], [0.98 - i * 0.065, 0.98 - i * 0.065, 1 - i * 0.065]));
    return { ...c, spent: fillTone(c.spent), earned: fillTone(c.earned), tips: fillTone(c.tips), loss: fillTone(c.loss), palette: ramp.map(fillTone) };
  }
  return { spent: fillTone(c.spent), earned: fillTone(c.earned), tips: fillTone(c.tips), loss: fillTone(c.loss), palette: c.palette.map(fillTone) };
}
