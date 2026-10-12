import { useEffect, useRef, useState } from 'preact/hooks';
import type { Controller } from './controller';
import * as I from './icons';
import { Section, Segmented, Toggle, WEEKDAYS, longDay } from './common';
import { TIP_METHODS, isDebtName } from '../core/categories';
import type { Kind } from '../core/categories';
import { KIND_LABEL, KINDS, MAX_ITEMS_RANGE, MENU_LABEL, MENU_MODES, blurLevel, clampItems, glassAmount, resetAppearance } from '../core/model';
import type { AppearanceMode, ChartStyle, MenuBarMode } from '../core/model';
import { MAX_CENTS, parseMoney, moneyMessage, plainMoney } from '../core/money';
import { MAX_INTERVAL, MAX_RULES, REPEAT_KINDS, REPEAT_LABEL, nextDue, repeatText } from '../core/recurring';
import type { RecurringRule, RepeatKind } from '../core/recurring';
import { BLUR_RADIUS, Glass, THEME_LABEL, THEME_NAMES, chartColors, toHex } from '../core/themes';
import type { BlurLevel, UIStyle } from '../core/themes';
import { newId } from '../core/json';

const STYLE_BLURB: Record<UIStyle, string> = { cards: 'Rounded cards with soft shadows', list: 'Dense and minimal, thin dividers', glass: 'Translucent material over a soft tint' };

export function SettingsView({ ctl, done }: { ctl: Controller; done: () => void }) {
  const store = ctl.store;
  const s = store.settings;
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  const [msg, setMsg] = useState<string | null>(null);
  const upd = async (f: (x: typeof s) => void) => { const e = await store.updateSettings(f); setMsg(e); };
  const [symbol, setSymbol] = useState(s.currencySymbol);
  useEffect(() => setSymbol(s.currencySymbol), [s.currencySymbol]);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => { void ctl.backend.autostart?.isEnabled().then(setAutostart).catch(() => setAutostart(null)); }, [ctl]);
  const dark = document.documentElement.dataset.theme === 'dark';

  return (
    <div class="app settings">
      <header class="head">
        <button class="icon" aria-label="Back" onClick={done}><I.ChevronLeft /></button>
        <h1 tabIndex={-1} ref={head}>Settings</h1>
      </header>
      <main class="scroll">
        {msg && <p class="err" role="alert">{msg}</p>}
        <Section>
          <div class="field"><label for="sym">Currency symbol</label>
            <span class="row"><input id="sym" class="short" dir="ltr" maxLength={3} value={symbol} onInput={(e) => setSymbol((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') void upd((x) => { x.currencySymbol = symbol; }); }} />
              <button class="btn" onClick={() => void upd((x) => { x.currencySymbol = symbol; })}>Set</button></span></div>
          <div class="field"><label for="ws">Week starts on</label>
            <select id="ws" value={s.weekStart} onChange={(e) => void upd((x) => { x.weekStart = Number((e.target as HTMLSelectElement).value); })}>
              {[2, 3, 4, 5, 6, 7, 1].map((d) => <option key={d} value={d}>{WEEKDAYS[d - 1]}</option>)}
            </select></div>
          <div class="field"><label for="mb">Menu bar shows</label>
            <select id="mb" value={s.menuBar} onChange={(e) => void upd((x) => { x.menuBar = (e.target as HTMLSelectElement).value as MenuBarMode; })}>
              {MENU_MODES.map((m) => <option key={m} value={m}>{MENU_LABEL[m]}</option>)}
            </select></div>
          {autostart !== null && <Toggle id="auto" label="Start at login" on={autostart} onChange={(v) => { void ctl.backend.autostart!.set(v).then(() => setAutostart(v)).catch((e) => setMsg(String(e))); }} />}
        </Section>

        <Section title="Appearance">
          <div class="field"><span id="l-mode">Mode</span><Segmented name="mode" label="Mode" value={s.appearance} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} onChange={(v: AppearanceMode) => void upd((x) => { x.appearance = v; })} /></div>
          <div class="field col"><span>Colour theme</span>
            <div class="swatches" role="radiogroup" aria-label="Colour theme">
              {THEME_NAMES.map((t) => { const c = chartColors(t); const pick = (tn: typeof c.spent) => toHex(dark ? tn.dark : tn.light); return (
                <label key={t} class={`swatch${s.theme === t ? ' on' : ''}`}><input type="radio" name="theme" checked={s.theme === t} onChange={() => void upd((x) => { x.theme = t; })} />
                  <span class="dots" aria-hidden="true"><i style={{ background: pick(c.spent) }} /><i style={{ background: pick(c.earned) }} /><i style={{ background: pick(c.tips) }} /></span><span>{THEME_LABEL[t]}</span></label>); })}
            </div></div>
          <div class="field col"><div class="row sb"><span>Layout</span><Segmented name="style" label="Layout" value={s.style} options={[['cards', 'Cards'], ['list', 'List'], ['glass', 'Glass']]} onChange={(v: UIStyle) => void upd((x) => { x.style = v; })} /></div><p class="muted small">{STYLE_BLURB[s.style]}</p></div>
          <div class="field"><span>Report chart</span><Segmented name="chart" label="Report chart" value={s.chartStyle} options={[['bars', 'Bars'], ['line', 'Line']]} onChange={(v: ChartStyle) => void upd((x) => { x.chartStyle = v; })} /></div>
          <div class="field col"><div class="row sb"><label for="items">Items shown</label>
            <span class="stepper"><button class="icon" aria-label="Fewer items" onClick={() => void upd((x) => { x.maxItems = clampItems(x.maxItems - 1); })}><I.Minus /></button>
              <input id="items" class="num" type="number" min={MAX_ITEMS_RANGE[0]} max={MAX_ITEMS_RANGE[1]} value={s.maxItems} onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) void upd((x) => { x.maxItems = clampItems(Math.round(n)); }); }} />
              <button class="icon" aria-label="More items" onClick={() => void upd((x) => { x.maxItems = clampItems(x.maxItems + 1); })}><I.Plus /></button></span></div>
            <p class="muted small">Recent entries in the popover and rows in report breakdowns ({MAX_ITEMS_RANGE[0]} to {MAX_ITEMS_RANGE[1]}).</p></div>
          <div class="field col"><div class="row sb"><label for="glass">Glass amount</label><span class="num muted">{glassAmount(s)}%</span></div>
            <input id="glass" type="range" min={0} max={100} step={Glass.step} value={glassAmount(s)} aria-valuetext={`${glassAmount(s)} percent`} onInput={(e) => void upd((x) => { x.glass = Number((e.target as HTMLInputElement).value); })} /></div>
          <div class="field col"><span>Blur strength</span>
            <Segmented name="blur" label="Blur strength" value={blurLevel(s)} options={(Object.keys(BLUR_RADIUS) as BlurLevel[]).map((b) => [b, b[0].toUpperCase() + b.slice(1)] as [BlurLevel, string])} onChange={(v: BlurLevel) => void upd((x) => { x.blur = v; })} /></div>
          <p class="muted small">0% is a solid panel, 100% the most see-through that stays readable. Applies to the panels in every layout.</p>
          <button class="btn" onClick={() => void upd((x) => resetAppearance(x))}>Reset appearance to defaults</button>
        </Section>

        <Budgets ctl={ctl} setMsg={setMsg} />
        <Recurring ctl={ctl} />

        <Section title="Your categories">
          {s.customCategories.length === 0 ? <p class="muted">None yet. Use the + next to the category menu to add one.</p> : (
            <ul class="plain-list">{s.customCategories.map((c) => <li key={c} class="row sb"><bdi dir="auto">{c}</bdi><button class="icon" aria-label={`Remove category ${c}`} onClick={() => void store.removeCategory(c)}><I.Trash /></button></li>)}</ul>)}
        </Section>

        <Section title="Sample data">
          <p class="muted">Fake entries for the last 4 weeks, marked as sample, to try out the reports.</p>
          <div class="row"><button class="btn" onClick={() => void store.loadSample().then(setMsg)}>Load sample data</button>{store.hasSample && <button class="btn" onClick={() => void store.clearSample().then(setMsg)}>Clear sample data</button>}</div>
        </Section>

        <Section title="Your data">
          <p class="muted">Stored only on this computer, in <code dir="ltr">{ctl.backend.dataDir}</code>. entries.backup.json is the last good copy (it changes only when entries change) and entries.backup-daily.json is the file from before the first change of each day. No network, no accounts.</p>
          <div class="row"><button class="btn" onClick={() => void ctl.backend.revealData()}>Show the folder</button></div>
        </Section>
      </main>
    </div>
  );
}

function Budgets({ ctl, setMsg }: { ctl: Controller; setMsg: (m: string | null) => void }) {
  const store = ctl.store, s = store.settings;
  const cats = store.expenseCategories().filter((c) => !isDebtName(c));
  const limitOf = (name: string) => Object.entries(s.budgets).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const [draft, setDraft] = useState<Map<string, string>>(new Map()); // a Map: a category may be called "constructor"
  const show = (c: string) => draft.get(c) ?? (limitOf(c) !== undefined ? plainMoney(limitOf(c)!) : '');
  const [bad, setBad] = useState<string | null>(null);
  const set = async (c: string) => {
    const e = await store.setBudgetFromText(c, show(c));
    if (e) { setBad(`${c}: ${e}`); return; }
    setBad(null); setMsg(null); setDraft((d) => { const n = new Map(d); n.delete(c); return n; });
  };
  const orphans = store.orphanBudgets();
  return (
    <Section title="Budgets">
      <p class="muted">An optional monthly limit per spending category. Card payments are never budgeted. Reports show progress; the popover shows a category once it reaches 80%.</p>
      <ul class="plain-list">
        {cats.map((c) => (
          <li key={c} class="field"><label for={`b-${c}`}><bdi dir="auto">{c}</bdi></label>
            <span class="row"><input id={`b-${c}`} class="money" dir="ltr" inputMode="decimal" placeholder="No limit" value={show(c)} onInput={(e) => setDraft(new Map(draft).set(c, (e.target as HTMLInputElement).value))} onKeyDown={(e) => { if (e.key === 'Enter') void set(c); }} />
              <button class="btn" aria-label={`Set budget for ${c}`} onClick={() => void set(c)}>Set</button></span></li>
        ))}
      </ul>
      {bad && <p class="err" role="alert">{bad}</p>}
      {orphans.length > 0 && <div class="orphans"><p class="muted">Budgets of removed categories (ignored until the category comes back):</p>
        {orphans.map((o) => <div class="row sb" key={o}><span><bdi dir="auto">{o}</bdi>, {store.money(s.budgets[o])}</span><button class="btn" onClick={() => void store.setBudget(o, undefined)}>Remove</button></div>)}</div>}
      <Toggle id="notify" label="Notify me at 80% and 100%" on={s.budgetNotify} onChange={(v) => void store.setBudgetNotify(v).then(setMsg)} />
      <p class="muted small">Off by default. One calm notification per category per month at each step; your system may ask for permission the first time you turn it on.</p>
    </Section>
  );
}

// ---- recurring

interface Draft { id: string | null; kind: Kind; amount: string; category: string; note: string; repeatKind: RepeatKind; interval: string; start: string; end: string }

function Recurring({ ctl }: { ctl: Controller }) {
  const store = ctl.store, s = store.settings;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = useRef<HTMLInputElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const formOpen = draft !== null;
  const formKey = draft?.id ?? '';
  // a new or edited rule starts in the amount field, like the Mac app
  useEffect(() => { if (formOpen) amount.current?.focus(); }, [formOpen, formKey]);
  /** Closes the form (Cancel, Escape, after saving) and gives focus back to the Add button. */
  const closeForm = () => { setDraft(null); setError(null); setTimeout(() => addBtn.current?.focus(), 0); };
  const blank = (): Draft => ({ id: null, kind: 'expense', amount: '', category: 'Rent', note: '', repeatKind: 'monthly', interval: '14', start: store.todayKey, end: '' });
  const edit = (r: RecurringRule): Draft => ({ id: r.id, kind: r.kind, amount: plainMoney(r.cents), category: r.category, note: r.note, repeatKind: r.repeatKind, interval: String(r.interval), start: r.start, end: r.end ?? '' });
  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const cats = (k: Kind) => (k === 'expense' ? store.expenseCategories() : k === 'income' ? store.incomeSources() : TIP_METHODS);
  const save = async () => {
    if (!draft || busy) return;
    const a = parseMoney(draft.amount, s.currencySymbol);
    if (!a.ok) { setError(moneyMessage(a.error)); return; }
    const old = s.recurring.find((r) => r.id === draft.id);
    const rule: RecurringRule = { id: draft.id ?? newId(), kind: draft.kind, cents: a.cents, category: draft.category, note: draft.note, repeatKind: draft.repeatKind, interval: draft.repeatKind === 'days' ? Number(draft.interval) : 1, start: draft.start, paused: old?.paused ?? false };
    if (draft.end !== '') rule.end = draft.end;
    setBusy(true);
    const e = draft.id ? await store.updateRule(rule) : await store.addRule(rule);
    setBusy(false);
    if (e) { setError(e); return; }
    closeForm();
  };
  const full = s.recurring.length >= MAX_RULES;
  return (
    <Section title="Recurring">
      <p class="muted">Rent, pay, subscriptions: they add themselves on their date, once each, even if the app was closed. Deleting a rule keeps the entries it made.</p>
      <ul class="rules">
        {s.recurring.map((r) => {
          const next = nextDue(r);
          const n = store.entryCount(r.id);
          return (
            <li key={r.id} class={r.paused ? 'paused' : ''}>
              <span class="rep"><I.Repeat width={18} height={18} /></span>
              <div class="rmain"><div class="rtitle"><bdi dir="auto">{r.kind === 'income' ? 'Wages' : r.kind === 'tip' ? 'Tip' : r.category}</bdi> · <span class="num">{store.money(r.cents)}</span></div>
                <div class="rsub">{r.paused ? 'Paused · ' : ''}{repeatText(r)}{!r.paused && next ? ` · next ${longDay(next)}` : ''}{!next ? ' · finished' : ''}</div></div>
              {asking === r.id ? (
                <span class="confirm" role="group" aria-label="Delete this recurring entry?">
                  <button class="btn" onClick={() => { setAsking(null); void store.deleteRule(r.id); }}>Delete rule</button>
                  {n > 0 && <button class="btn danger" onClick={() => { setAsking(null); void store.deleteRuleAndEntries(r.id); }}>Delete rule and {n} {n === 1 ? 'entry' : 'entries'}</button>}
                  <button class="btn" onClick={() => setAsking(null)}>Keep</button></span>
              ) : (<>
                <button class="icon" aria-label={r.paused ? 'Resume' : 'Pause'} onClick={() => void store.setRulePaused(r.id, !r.paused)}>{r.paused ? <I.PlayI /> : <I.Pause />}</button>
                <button class="icon" aria-label="Edit recurring entry" onClick={() => { setDraft(edit(r)); setError(null); }}><I.Pencil /></button>
                <button class="icon" aria-label="Delete recurring entry" onClick={() => setAsking(r.id)}><I.Trash /></button></>)}
            </li>
          );
        })}
      </ul>
      {draft ? (
        <form class="editor" aria-label={draft.id ? 'Edit recurring entry' : 'New recurring entry'} onSubmit={(e) => { e.preventDefault(); void save(); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm(); } }}>
          <Segmented name="rkind" label="Type" value={draft.kind} options={KINDS.map((k) => [k, KIND_LABEL[k]] as [Kind, string])} onChange={(k) => set({ kind: k, category: k === 'expense' ? 'Rent' : k === 'income' ? 'Job' : '' })} />
          <div class="row">
            <input ref={amount} class="money" aria-label="Amount" dir="ltr" inputMode="decimal" placeholder="0.00" value={draft.amount} onInput={(e) => set({ amount: (e.target as HTMLInputElement).value })} />
            <select aria-label="Category" value={draft.category} onChange={(e) => set({ category: (e.target as HTMLSelectElement).value })}>
              {draft.kind === 'tip' && <option value="">Not said</option>}
              {(cats(draft.kind).includes(draft.category) || draft.category === '' ? cats(draft.kind) : [...cats(draft.kind), draft.category]).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <input aria-label="Note" dir="auto" placeholder="Note (optional)" value={draft.note} onInput={(e) => set({ note: (e.target as HTMLInputElement).value })} />
          <div class="row">
            <select aria-label="Repeat" value={draft.repeatKind} onChange={(e) => set({ repeatKind: (e.target as HTMLSelectElement).value as RepeatKind })}>{REPEAT_KINDS.map((k) => <option key={k} value={k}>{REPEAT_LABEL[k]}</option>)}</select>
            {draft.repeatKind === 'days' && <label class="row">Every <input class="short" type="number" min={1} max={MAX_INTERVAL} value={draft.interval} onInput={(e) => set({ interval: (e.target as HTMLInputElement).value })} /> days</label>}
          </div>
          <div class="row"><label>Starts <input type="date" value={draft.start} onInput={(e) => set({ start: (e.target as HTMLInputElement).value })} /></label>
            <label>Ends (optional) <input type="date" value={draft.end} onInput={(e) => set({ end: (e.target as HTMLInputElement).value })} /></label></div>
          {error && <p class="err" role="alert">{error}</p>}
          <div class="row end"><button type="button" class="btn" onClick={closeForm}>Cancel</button><button type="submit" class="btn primary" disabled={busy}>{draft.id ? 'Save rule' : 'Add rule'}</button></div>
        </form>
      ) : (
        <>
          <button class="btn" ref={addBtn} disabled={full} onClick={() => { setDraft(blank()); setError(null); }}><I.Plus />Add recurring entry</button>
          {full && <p class="muted small">You can have at most {MAX_RULES} recurring entries.</p>}
        </>
      )}
    </Section>
  );
}
export { MAX_CENTS };
