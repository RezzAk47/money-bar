import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Controller } from './controller';
import * as I from './icons';
import { MenuSelect, Section, Segmented, dayLabel, useDark } from './common';
import { applyTheme } from './theme';
import { ReportsView } from './reports';
import { SettingsView } from './settings';
import { DEBT_PAYMENT, TIP_METHODS } from '../core/categories';
import type { Kind } from '../core/categories';
import { Entry, KINDS, KIND_LABEL, MENU_LABEL, MENU_MODES, isDebtPayment } from '../core/model';
import type { MenuBarMode } from '../core/model';
import { parseMoney, moneyMessage, plainMoney } from '../core/money';
import { alertLevel, budgetLevel, budgetFraction, budgetMessage } from '../core/reports';
import { KindCategoryMemory, recentHeight } from '../core/summary';

type View = 'main' | 'reports' | 'settings';

export function App({ ctl }: { ctl: Controller }) {
  const [, setTick] = useState(0);
  useEffect(() => ctl.subscribe(() => setTick((x) => x + 1)), [ctl]);
  const store = ctl.store;
  const settings = store.settings;
  const dark = useDark(settings.appearance);
  const [view, setView] = useState<View>('main');
  const [editing, setEditing] = useState<Entry | null>(null);
  const btnRef = useRef<Record<string, HTMLButtonElement | null>>({});
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => { applyTheme(settings, dark); }, [settings, dark]);
  useEffect(() => ctl.backend.onShown(() => { if (view === 'main') amountRef.current?.focus(); }), [ctl, view]);
  const go = (v: View, back?: string) => { setView(v); if (back) setTimeout(() => btnRef.current[back]?.focus(), 0); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (view !== 'main') go('main', view === 'reports' ? 'reports' : 'settings');
      else if (editing) setEditing(null);
      else void ctl.backend.hide();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  document.documentElement.lang = 'en';

  if (view === 'reports') return <ReportsView ctl={ctl} done={() => go('main', 'reports')} />;
  if (view === 'settings') return <SettingsView ctl={ctl} done={() => go('main', 'settings')} />;

  return (
    <div class="app">
      <header class="head">
        <span class="logo" aria-hidden="true"><I.Dollar width={26} height={26} /></span>
        <h1 tabIndex={-1}>Money Bar</h1>
        <span class="grow" />
        <MenuSelect label="Menu bar shows" value={settings.menuBar} options={MENU_MODES.map((m) => [m, MENU_LABEL[m]] as [string, string])} onChange={(v) => void store.updateSettings((s) => { s.menuBar = v as MenuBarMode; })} />
        <button class="icon" aria-label="Reports" ref={(el) => { btnRef.current.reports = el; }} onClick={() => go('reports')}><I.Bars /></button>
        <button class="icon" aria-label="Settings" ref={(el) => { btnRef.current.settings = el; }} onClick={() => go('settings')}><I.Gear /></button>
        <button class="icon" aria-label="Quit Money Bar" onClick={() => void ctl.backend.quit()}><I.Power /></button>
      </header>
      <main class="scroll">
        <Banners ctl={ctl} />
        {ctl.undo && (
          <div class="banner note undo" role="status"><span>Entry deleted.</span> <button class="btn" onClick={() => void ctl.undoDelete()}>Undo</button></div>
        )}
        <AddForm ctl={ctl} editing={editing} done={() => setEditing(null)} amountRef={amountRef} />
        <Today ctl={ctl} />
        <BudgetStrip ctl={ctl} />
        <Recent ctl={ctl} editing={editing} onEdit={setEditing} />
      </main>
    </div>
  );
}

function Banners({ ctl }: { ctl: Controller }) {
  const s = ctl.store;
  return (
    <>
      {s.loadError !== null && (
        <div class="banner error" role="alert">
          <p><strong>entries.json cannot be read.</strong> Nothing will be saved or changed until it is fixed.</p>
          <p class="detail" dir="auto">{s.loadError}</p>
          <div class="row">
            <button class="btn" onClick={() => void s.startOver()}>Keep a copy and start over</button>
            <button class="btn" onClick={() => void ctl.backend.revealData()}>Show the folder</button>
          </div>
        </div>
      )}
      {s.saveError !== null && s.loadError === null && <div class="banner error" role="alert"><p>Could not save: {s.saveError}</p></div>}
      {ctl.backend.trayNote && <div class="banner note"><p>{ctl.backend.trayNote}</p></div>}
    </>
  );
}

// ---- add / edit form

const CATEGORY_NONE = '';
function AddForm({ ctl, editing, done, amountRef }: { ctl: Controller; editing: Entry | null; done: () => void; amountRef: { current: HTMLInputElement | null } }) {
  const store = ctl.store;
  const sym = store.settings.currencySymbol;
  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Food');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(store.todayKey);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCat, setNewCat] = useState<string | null>(null);
  const memory = useRef(new KindCategoryMemory('expense', 'Food'));
  const busy = useRef(false);
  // the date follows today until the user picks one
  const touchedDay = useRef(false);
  useEffect(() => { if (!touchedDay.current && !editing) setDay(store.todayKey); }, [store.todayKey]);
  useEffect(() => {
    if (!editing) return;
    memory.current = new KindCategoryMemory(editing.kind, editing.category);
    setKind(editing.kind); setAmount(plainMoney(editing.cents)); setCategory(editing.category); setNote(editing.note); setDay(editing.day); setError(null);
    amountRef.current?.focus();
  }, [editing?.id]);

  const cats = kind === 'expense' ? store.expenseCategories() : kind === 'income' ? store.incomeSources() : TIP_METHODS;
  const options = category !== '' && !cats.some((c) => c === category) ? [...cats, category] : cats;

  const switchKind = (k: Kind) => { setCategory(memory.current.switchTo(k, category)); setKind(k); setError(null); };
  const cancel = () => { done(); setAmount(''); setNote(''); setError(null); touchedDay.current = false; setDay(store.todayKey); };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy.current) return;
    const r = parseMoney(amount, sym);
    if (!r.ok) { setError(moneyMessage(r.error)); amountRef.current?.focus(); return; }
    busy.current = true; setAdding(true);
    try {
      const err = editing ? await store.update(editing.id, kind, r.cents, category, note, day) : await store.add(kind, r.cents, category, note, day);
      if (err) { setError(err); return; }
      setError(null); setAmount(''); setNote('');
      if (editing) { done(); touchedDay.current = false; setDay(store.todayKey); }
      amountRef.current?.focus();
    } finally { busy.current = false; setAdding(false); }
  };
  const addCategory = async () => {
    const r = await store.addCategory(newCat ?? '');
    if (r.error) { setError(r.error); return; }
    setCategory(r.name); setNewCat(null); setError(null);
  };
  const verb = editing ? 'Save changes' : `Add ${KIND_LABEL[kind].toLowerCase()}`;
  return (
    <Section class="form">
      <form onSubmit={submit} aria-label={editing ? 'Edit entry' : 'Add entry'} noValidate>
        <Segmented name="kind" label="Type" value={kind} options={KINDS.map((k) => [k, KIND_LABEL[k]] as [Kind, string])} onChange={switchKind} />
        <div class="row amount-row">
          <label class="amount">
            <span class="sr">Amount</span>
            <span class="sym" aria-hidden="true">{sym}</span>
            <input ref={amountRef} inputMode="decimal" autoComplete="off" placeholder="0.00" dir="ltr" value={amount} aria-invalid={error !== null && /amount|large|decimals|number|zero|negative/i.test(error)} aria-describedby={error ? 'form-error' : undefined}
              onInput={(e) => { setAmount((e.target as HTMLInputElement).value); setError(null); }} />
          </label>
          <span class="catpick">
            <MenuSelect label={kind === 'expense' ? 'Category' : kind === 'income' ? 'Source' : 'Tip method'} value={category} onChange={setCategory}
              options={[...(kind === 'tip' ? [['', 'Not said'] as [string, string]] : []), ...options.map((c) => [c, c] as [string, string])]} />
          </span>
          {kind === 'expense' && <button type="button" class="icon" aria-label="Add a category" onClick={() => setNewCat(newCat === null ? '' : null)}><I.PlusCircle /></button>}
        </div>
        {newCat !== null && (
          <div class="row">
            <input aria-label="New category name" dir="auto" maxLength={60} placeholder="New category" value={newCat} autoFocus onInput={(e) => setNewCat((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addCategory(); } else if (e.key === 'Escape') { e.stopPropagation(); setNewCat(null); } }} />
            <button type="button" class="btn" onClick={() => void addCategory()}>Add</button>
          </div>
        )}
        <div class="row">
          <input class="note" aria-label="Note" dir="auto" placeholder="Note (optional)" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <input class="date" type="date" aria-label="Date" value={day} onInput={(e) => { touchedDay.current = true; setDay((e.target as HTMLInputElement).value); }} />
        </div>
        {error && <p id="form-error" class="err" role="alert">{error}</p>}
        <div class="row end">
          {editing && <button type="button" class="btn" onClick={cancel}>Cancel</button>}
          <button type="submit" class="btn primary" disabled={adding}><I.Plus />{verb}</button>
        </div>
      </form>
    </Section>
  );
}

// ---- today

function Today({ ctl }: { ctl: Controller }) {
  const s = ctl.store, q = s.today, net = q.earned + q.tips - q.spent;
  const m = (c: number, sign = false) => s.money(c, true, sign);
  const cell = (cls: string, label: string, icon: VNode, value: string) => (
    <div class={`stat ${cls}`}><span class="stat-label">{icon}{label}</span><strong class="num">{value}</strong></div>
  );
  return (
    <section aria-label="Today">
      <h2 class="sect">Today</h2>
      <div class="stats">
        {cell('spent', 'Spent', <I.ArrowUp />, m(q.spent))}
        {cell('earned', 'Earned', <I.Wallet />, m(q.earned))}
        {cell('tips', 'Tips', <I.Thumb />, m(q.tips))}
        {cell(net < 0 ? 'loss' : net > 0 ? 'earned' : 'plain', 'Net', <I.PlusMinus />, m(net, true))}
      </div>
      {q.debtPaid > 0 && <p class="muted debt">Card payments today: <span class="num">{m(q.debtPaid)}</span> (not counted in Spent or Net)</p>}
    </section>
  );
}

function BudgetStrip({ ctl }: { ctl: Controller }) {
  const s = ctl.store;
  const rows = s.budgetStatuses().filter((b) => alertLevel(b) >= 80);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Budgets">
      <h2 class="sect">Budgets</h2>
      <ul class="card budget-strip">
        {rows.map((b) => (
          <li key={b.id}>
            <bdi dir="auto" class="bname">{b.name}</bdi>
            <span class="bar" role="img" aria-label={`${b.name}: ${budgetMessage(b, (c) => s.money(c))}`}><span class={`fill ${budgetLevel(b)}`} style={{ width: `${Math.min(100, Math.round(budgetFraction(b) * 100))}%` }} /></span>
            <span class={`bmsg ${budgetLevel(b)}`}>{budgetMessage(b, (c) => s.money(c))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- recent

function Recent({ ctl, editing, onEdit }: { ctl: Controller; editing: Entry | null; onEdit: (e: Entry) => void }) {
  const s = ctl.store;
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => { const f = () => setVh(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const list = s.recent;
  const limit = s.settings.maxItems;
  const shown = all ? list : list.slice(0, limit);
  const older = list.length - shown.length;
  const [err, setErr] = useState<string | null>(null);
  const del = async (e: Entry) => { setConfirm(null); setErr(await ctl.deleteEntry(e)); };
  return (
    <section aria-label="Recent entries">
      <h2 class="sect">Recent</h2>
      {list.length === 0 && s.loadError === null && <p class="empty card">No entries yet. Add one above, or load sample data in Settings.</p>}
      {err && <p class="err" role="alert">{err}</p>}
      <ul class="entries" style={{ maxHeight: `${recentHeight(vh)}px` }} data-capped={!all}>
        {shown.map((e) => <Row key={e.id} e={e} ctl={ctl} active={editing?.id === e.id} confirm={confirm === e.id} onEdit={() => onEdit(e)} askDelete={() => setConfirm(e.id)} cancelDelete={() => setConfirm(null)} del={() => void del(e)} />)}
      </ul>
      {(older > 0 || all) && list.length > limit && (
        <button class="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${older} older ${older === 1 ? 'entry' : 'entries'}`}</button>
      )}
    </section>
  );
}

const ICON: Record<Kind, () => VNode> = { expense: () => <I.ArrowUp />, income: () => <I.Wallet />, tip: () => <I.Thumb /> };
function Row({ e, ctl, active, confirm, onEdit, askDelete, cancelDelete, del }: { e: Entry; ctl: Controller; active: boolean; confirm: boolean; onEdit: () => void; askDelete: () => void; cancelDelete: () => void; del: () => void }) {
  const s = ctl.store;
  const debt = isDebtPayment(e);
  const title = debt ? 'Card payment' : e.kind === 'expense' ? e.category || 'Other' : e.kind === 'income' ? `Wages · ${e.category || 'Other'}` : `Tip${e.category ? ` · ${e.category}` : ''}`;
  const amount = debt ? s.money(e.cents) : s.money(e.kind === 'expense' ? -e.cents : e.cents, false, true);
  const when = dayLabel(e.day, s.todayKey);
  const kindClass = debt ? 'debt' : e.kind;
  const label = `${debt ? 'Card payment' : KIND_LABEL[e.kind]}, ${title}, ${s.money(e.cents)}, ${when}${e.note ? `, ${e.note}` : ''}${e.recurringID ? ', repeats' : ''}`;
  return (
    <li class={`row-entry ${kindClass}${active ? ' editing' : ''}`}>
      <span class="dot" aria-hidden="true">{ICON[e.kind]()}</span>
      <div class="rmain" aria-label={label} role="group">
        <div class="rtitle"><bdi dir="auto">{title}</bdi>{e.recurringID && <span class="rep" title="Made by a recurring entry"><I.Repeat width={13} height={13} /></span>}</div>
        <div class="rsub"><span>{when}</span>{e.note && <> <span aria-hidden="true">·</span> <bdi dir="auto">{e.note}</bdi></>}{debt && <span class="sr"> not counted as spending</span>}</div>
      </div>
      <strong class="amt num" dir="ltr">{amount}</strong>
      {confirm ? (
        <span class="confirm" role="group" aria-label="Delete this entry?"><button class="btn danger" onClick={del} autoFocus>Delete</button><button class="btn" onClick={cancelDelete}>Keep</button></span>
      ) : (
        <>
          <button class="icon" aria-label={`Edit ${title}`} onClick={onEdit}><I.Pencil /></button>
          <button class="icon" aria-label={`Delete ${title}`} onClick={askDelete}><I.Trash /></button>
        </>
      )}
    </li>
  );
}
export { DEBT_PAYMENT };
