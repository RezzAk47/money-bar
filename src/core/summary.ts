// The menu bar / tray text (Summary in Model.swift), the Today cards numbers, the popover list height and KindCategoryMemory.
import { formatMoney } from './money';
import type { Entry, MenuBarMode } from './model';
import { net, quad } from './reports';
import type { Quad } from './reports';
import type { Kind } from './categories';

export const todayQuad = (entries: Entry[], day: string): Quad => quad(entries.filter((e) => e.day === day));

export function summaryText(mode: MenuBarMode, entries: Entry[], day: string, symbol: string): string {
  const q = todayQuad(entries, day);
  const m = (c: number, sign = false) => formatMoney(c, symbol, true, sign);
  switch (mode) {
    case 'todayNet': return net(q) === 0 ? `${m(0)} today` : `${m(net(q), true)} today`;
    case 'todaySpent': return `${m(q.spent)} spent`;
    case 'todayEarned': return `${m(q.earned)} earned`;
    case 'todayTips': return `${m(q.tips)} tips`;
  }
}

/** Remembers the category chosen for each kind while the Type control is switched, so Rent -> Income -> Expense comes back to Rent. */
export class KindCategoryMemory {
  private byKind = new Map<Kind, string>();
  private kind: Kind;
  constructor(kind: Kind, category: string) { this.kind = kind; this.byKind.set(kind, category); }
  static defaultCategory(kind: Kind): string { return kind === 'expense' ? 'Food' : kind === 'income' ? 'Job' : ''; }
  /** Stores `current` for the kind being left and returns the category to show for `next`. */
  switchTo(next: Kind, current: string): string {
    this.byKind.set(this.kind, current);
    this.kind = next;
    return this.byKind.get(next) ?? KindCategoryMemory.defaultCategory(next);
  }
}

/** What the header, form, Today cards, Budgets strip, the "Recent" title and padding take; the list gets the rest of the screen. */
export const POPOVER_CHROME = 440;
/** The Recent list as tall as the screen allows, never below 160 or above 560 pixels. */
export const recentHeight = (visibleHeight: number): number => Math.min(560, Math.max(160, visibleHeight - POPOVER_CHROME));
