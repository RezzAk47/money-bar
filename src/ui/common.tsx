import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as Civil from '../core/civil';
import type { Settings } from '../core/model';

export function useDark(appearance: Settings['appearance']): boolean {
  const mq = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const [sys, setSys] = useState(mq.matches);
  useEffect(() => { const f = () => setSys(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [mq]);
  return appearance === 'dark' || (appearance === 'system' && sys);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m: number): string => MONTHS_LONG[m - 1];
/** "Today", "Yesterday", "Oct 18", or "Oct 18, 2025" in another year. */
export function dayLabel(key: string, today: string): string {
  if (key === today) return 'Today';
  const t = Civil.days(today), d = Civil.days(key);
  if (t !== null && d !== null && t - d === 1) return 'Yesterday';
  const p = Civil.parts(key)!, tp = Civil.parts(today)!;
  return `${MONTHS[p.m - 1]} ${p.d}${p.y !== tp.y ? `, ${p.y}` : ''}`;
}
export const shortDay = (key: string): string => { const p = Civil.parts(key)!; return `${MONTHS[p.m - 1]} ${p.d}`; };
export const longDay = (key: string): string => { const p = Civil.parts(key)!; return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`; };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A card section with an optional heading. */
export function Section({ title, children, class: cls }: { title?: string; children: ComponentChildren; class?: string }) {
  return <section class={`card ${cls ?? ''}`} aria-label={title}>{title && <h2 class="card-title">{title}</h2>}{children}</section>;
}
/** A radio-style segmented control with real radio inputs (keyboard: arrows), labelled for screen readers. */
export function Segmented<T extends string>({ label, value, options, onChange, name }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; name: string }) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={v} class={v === value ? 'on' : ''}>
          <input type="radio" name={name} value={v} checked={v === value} onChange={() => onChange(v)} />
          <span>{text}</span>
        </label>
      ))}
    </div>
  );
}
export function Toggle({ label, on, onChange, id }: { label: string; on: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label class="toggle" for={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" checked={on} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="knob" aria-hidden="true" />
    </label>
  );
}

/**
 * A keyboard-accessible listbox in place of a native <select> (a native menu is a separate window on some systems, takes the focus
 * from the popup and so closes it). Button + role=listbox: Enter, Space or the arrow keys open it; arrows, Home, End and a typed
 * letter move; Enter or Space chooses; Escape closes ONLY the menu (the popup and the view stay); Tab closes it; a click outside closes it.
 */
export function MenuSelect({ label, value, options, onChange, id, class: cls }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; id?: string; class?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useRef(`ms-${Math.random().toString(36).slice(2, 8)}`).current;
  const index = Math.max(0, options.findIndex(([v]) => v === value));
  const current = options[index]?.[1] ?? value;
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };
  const show = () => { setActive(index); setOpen(true); };
  const choose = (i: number) => { const o = options[i]; if (o) onChange(o[0]); close(); };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!btn.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' }); }, [open, active]);
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (!open) {
      if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); show(); }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (k === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(0); }
    else if (k === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); }
    else if (k === 'Tab') close(false);
    else if (k.length === 1) { const i = options.findIndex(([, t], j) => j > active && t.toLowerCase().startsWith(k.toLowerCase())); const j = i >= 0 ? i : options.findIndex(([, t]) => t.toLowerCase().startsWith(k.toLowerCase())); if (j >= 0) setActive(j); }
  };
  return (
    <span class={`menu ${cls ?? ''}`}>
      <button type="button" id={id} ref={btn} class="menu-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${uid}-list`} aria-label={`${label}: ${current}`}
        onClick={() => (open ? close() : show())} onKeyDown={onKey}>
        <span dir="auto">{current}</span><span class="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul id={`${uid}-list`} ref={list} class="menu-list" role="listbox" aria-label={label} aria-activedescendant={`${uid}-o${active}`} tabIndex={-1} onKeyDown={onKey}>
          {options.map(([v, t], i) => (
            <li key={v} id={`${uid}-o${i}`} role="option" aria-selected={i === active} class={`${v === value ? 'cur' : ''}${i === active ? ' act' : ''}`}
              onPointerEnter={() => setActive(i)} onClick={() => choose(i)}><bdi dir="auto">{t}</bdi>{v === value && <span class="sr"> (selected)</span>}</li>
          ))}
        </ul>
      )}
    </span>
  );
}
