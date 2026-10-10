import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Controller } from './controller';
import * as I from './icons';
import { Section, Segmented, longDay, monthName, shortDay } from './common';
import * as Civil from '../core/civil';
import { csvExport } from '../core/csv';
import { divRound } from '../core/money';
import { MAX_RANGE_DAYS, Period, Report, buckets, budgetFraction, budgetLevel, budgetMessage, groupedCategories, makeRange, net, rangeContaining, stepPeriod } from '../core/reports';
import type { DayRange, Glance } from '../core/reports';
import { foldKey } from '../core/categories';

type Kind = 'day' | 'week' | 'month' | 'custom';

export function ReportsView({ ctl, done }: { ctl: Controller; done: () => void }) {
  const store = ctl.store;
  const s = store.settings;
  const [kind, setKind] = useState<Kind>('month');
  const [anchor, setAnchor] = useState(store.todayKey);
  const [custom, setCustom] = useState<DayRange>(() => makeRange(Civil.addDays(store.todayKey, -13), store.todayKey));
  const [status, setStatus] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  const period: Period = kind === 'custom' ? { kind, range: custom } : { kind };
  const range = rangeContaining(period, anchor, s.weekStart);
  const r = store.report(period, anchor);
  const m = (c: number, compact = false, sign = false) => store.money(c, compact, sign);

  const prev = stepPeriod(period, range, -1, s.weekStart), next = stepPeriod(period, range, 1, s.weekStart);
  const step = (to: DayRange | null) => {
    if (to === null) return;
    if (kind === 'custom') setCustom(to);
    else setAnchor(to.start);
  };
  const pickKind = (k: Kind) => { if (k === 'custom') setCustom(range); setKind(k); };
  const title = kind === 'day' ? longDay(range.start) : kind === 'month' ? `${monthName(Civil.parts(range.start)!.m)} ${Civil.parts(range.start)!.y}` : `${longDay(range.start)} to ${longDay(range.end)}`;

  const exportCsv = async () => {
    const res = await ctl.backend.exportCsv(csvExport(r), `money-bar-${r.range.start}-to-${r.range.end}.csv`);
    setStatus(res.ok ? `Saved ${res.path ?? 'the file'}` : res.cancelled ? null : `Could not save the file: ${res.error ?? 'unknown error'}`);
  };
  const monthRange = rangeContaining({ kind: 'month' }, range.start, s.weekStart);
  const monthTitle = `${monthName(Civil.parts(monthRange.start)!.m)} ${Civil.parts(monthRange.start)!.y}`;

  return (
    <div class="app reports">
      <header class="head">
        <button class="icon" aria-label="Back" onClick={done}><I.ChevronLeft /></button>
        <h1 tabIndex={-1} ref={head}>Reports</h1>
        <span class="grow" />
        <button class="btn" onClick={() => void exportCsv()}><I.Share />Export CSV</button>
      </header>
      <main class="scroll">
        {status && <p class="muted" role="status">{status}</p>}
        <div class="row"><Segmented name="period" label="Period" value={kind} options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']]} onChange={pickKind} /></div>
        <div class="row period">
          <button class="icon" aria-label="Previous period" disabled={prev === null} onClick={() => step(prev)}><I.ChevronLeft /></button>
          <h2 class="ptitle" aria-live="polite" dir="auto">{title}</h2>
          <button class="icon" aria-label="Next period" disabled={next === null} onClick={() => step(next)}><I.Chevron /></button>
          <button class="btn" onClick={() => { setAnchor(store.todayKey); if (kind === 'custom') setCustom(makeRange(Civil.addDays(store.todayKey, -(Civil.days(custom.end)! - Civil.days(custom.start)!)), store.todayKey)); }}>Today</button>
        </div>
        {kind === 'custom' && (
          <div class="row">
            <label>From <input type="date" value={custom.start} onInput={(e) => { const v = (e.target as HTMLInputElement).value; if (Civil.isValidDay(v)) setCustom(makeRange(v, custom.end)); }} /></label>
            <label>To <input type="date" value={custom.end} onInput={(e) => { const v = (e.target as HTMLInputElement).value; if (Civil.isValidDay(v)) setCustom(makeRange(custom.start, v)); }} /></label>
            <span class="muted">Up to {MAX_RANGE_DAYS} days</span>
          </div>
        )}
        <p class="muted">{r.dayCount} {r.dayCount === 1 ? 'day' : 'days'}, {r.activeDays} with entries</p>
        <Totals r={r} m={m} />
        <Extras r={r} m={m} />
        <IncomeChart r={r} style={s.chartStyle} m={m} />
        <Categories r={r} ctl={ctl} />
        <BudgetBars ctl={ctl} month={monthRange} title={monthTitle} />
        <GlanceCard ctl={ctl} month={monthRange} title={monthTitle} />
      </main>
    </div>
  );
}

function Trend({ pct, good }: { pct: number | null; good: 'up' | 'down' }) {
  if (pct === null) return null;
  const up = pct > 0, flat = pct === 0;
  const ok = flat ? true : up === (good === 'up');
  return <span class={`trend ${ok ? 'good' : 'bad'}`}>{flat ? <I.Equals /> : up ? <I.ArrowUp /> : <I.ArrowDown />}<span>{flat ? 'same' : `${pct > 0 ? '+' : ''}${pct}%`} vs previous</span></span>;
}

function Totals({ r, m }: { r: Report; m: (c: number, compact?: boolean, sign?: boolean) => string }) {
  const col = (cls: string, label: string, icon: VNode, total: string, trend: VNode, all: string, active: string) => (
    <div class={`stat big ${cls}`}>
      <span class="stat-label">{icon}{label}</span>
      <strong class="num">{total}</strong>
      {trend}
      <div class="avgs"><div><b class="num">{all}</b><span> a day, all {r.dayCount} days</span></div><div><b class="num">{active}</b><span> a day, the {r.activeDays} days with entries</span></div></div>
    </div>
  );
  const n = net(r.totals);
  return (
    <>
      <div class="stats four" role="group" aria-label="Totals">
        {col('spent', 'Spent', <I.ArrowUp />, m(r.totals.spent), <Trend pct={r.trend.spent} good="down" />, m(r.avgAllDays.spent), m(r.avgActiveDays.spent))}
        {col('earned', 'Earned', <I.Wallet />, m(r.totals.earned), <Trend pct={r.trend.earned} good="up" />, m(r.avgAllDays.earned), m(r.avgActiveDays.earned))}
        {col('tips', 'Tips', <I.Thumb />, m(r.totals.tips), <Trend pct={r.trend.tips} good="up" />, m(r.avgAllDays.tips), m(r.avgActiveDays.tips))}
        {col(n < 0 ? 'loss' : 'earned', 'Net', <I.PlusMinus />, m(n, false, true), <Trend pct={r.trend.net} good="up" />, m(r.avgNetAllDays, false, true), m(r.avgNetActiveDays, false, true))}
      </div>
      {r.totals.debtPaid > 0 && <p class="muted debt">Paid toward card debt: <span class="num">{m(r.totals.debtPaid)}</span> (not counted in Spent or Net)</p>}
    </>
  );
}

function Extras({ r, m }: { r: Report; m: (c: number, compact?: boolean, sign?: boolean) => string }) {
  const tipAll = divRound(r.totals.tips, r.dayCount);
  const mini = (cls: string, label: string, icon: VNode, value: string, sub: string) => <div class={`stat mini ${cls}`}><span class="stat-label">{icon}{label}</span><strong class="num">{value}</strong><span class="muted">{sub}</span></div>;
  return (
    <div class="stats four" role="group" aria-label="Highlights">
      {mini(r.bestDay && net(r.bestDay.totals) < 0 ? 'loss' : 'earned', 'Best day', <I.Trophy />, r.bestDay ? m(net(r.bestDay.totals), false, true) : 'None', r.bestDay ? shortDay(r.bestDay.day) : 'no days with entries')}
      {mini('loss', 'Worst day', <I.Cloud />, r.worstDay ? m(net(r.worstDay.totals), false, true) : 'None', r.worstDay ? shortDay(r.worstDay.day) : 'no days with entries')}
      {mini('tips', 'Tips per day worked', <I.Thumb />, m(r.avgTipPerTipDay), `${r.tipDays} ${r.tipDays === 1 ? 'day' : 'days'} with tips`)}
      {mini('tips', 'Tips per day, all days', <I.Thumb />, m(tipAll), `${r.dayCount} days`)}
    </div>
  );
}

// ---- charts

/** A round axis maximum (1, 2, 2.5, 5 times a power of ten) at or above `cents`, and 3 evenly spaced tick values. */
export function niceAxis(cents: number): { max: number; ticks: number[] } {
  if (cents <= 0) return { max: 100, ticks: [0, 50, 100] };
  const pow = Math.pow(10, Math.floor(Math.log10(cents)));
  const max = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((v) => v >= cents) ?? 10 * pow;
  return { max, ticks: [0, max / 2, max] };
}

function IncomeChart({ r, style, m }: { r: Report; style: 'bars' | 'line'; m: (c: number, compact?: boolean) => string }) {
  const bs = useMemo(() => buckets(r.daily), [r]);
  const W = 420, H = 190, L = 6, R = 46, T = 8, B = 22;
  const top = Math.max(1, ...bs.map((b) => Math.max(b.spent, b.made)));
  const { max, ticks } = niceAxis(top);
  const x0 = L, x1 = W - R, pw = x1 - x0, ph = H - T - B;
  const y = (v: number) => T + ph - (v / max) * ph;
  const slot = pw / bs.length;
  const every = Math.max(1, Math.ceil(bs.length / 5));
  const lines = (get: (b: (typeof bs)[number]) => number) => bs.map((b, i) => `${(x0 + slot * (i + 0.5)).toFixed(1)},${y(get(b)).toFixed(1)}`).join(' ');
  const label = bs.some((b) => b.days > 1) ? 'day groups' : 'days';
  return (
    <Section title="Income vs spending, per day">
      <div class="legend"><span><i class="sw earned" />Made (wages + tips)</span><span><i class="sw spent" />Spent</span></div>
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Income against spending over ${bs.length} ${label}: made ${m(r.totals.earned + r.totals.tips)}, spent ${m(r.totals.spent)}`} preserveAspectRatio="none">
        {ticks.map((t) => <g key={t}><line class="grid" x1={x0} x2={x1} y1={y(t)} y2={y(t)} /><text class="axis" x={x1 + 4} y={y(t) + 4}>{m(t, true)}</text></g>)}
        {style === 'bars' ? bs.map((b, i) => {
          const bw = Math.max(1.5, Math.min(8, slot * 0.34));
          const cx = x0 + slot * (i + 0.5);
          return <g key={b.start}><title>{`${shortDay(b.start)}${b.days > 1 ? ` (+${b.days - 1} days)` : ''}: made ${m(b.made)}, spent ${m(b.spent)}`}</title>
            <rect class="b-earned" x={cx - bw - 0.3} width={bw} y={y(b.made)} height={Math.max(0, T + ph - y(b.made))} rx="1" /><rect class="b-spent" x={cx + 0.3} width={bw} y={y(b.spent)} height={Math.max(0, T + ph - y(b.spent))} rx="1" /></g>;
        }) : <><polyline class="l-earned" points={lines((b) => b.made)} fill="none" /><polyline class="l-spent" points={lines((b) => b.spent)} fill="none" />
          {bs.length <= 40 && bs.map((b, i) => <g key={b.start}><title>{`${shortDay(b.start)}: made ${m(b.made)}, spent ${m(b.spent)}`}</title><circle class="d-earned" cx={x0 + slot * (i + 0.5)} cy={y(b.made)} r="2.2" /><circle class="d-spent" cx={x0 + slot * (i + 0.5)} cy={y(b.spent)} r="2.2" /></g>)}</>}
        {bs.map((b, i) => (i % every === 0 ? <text key={b.start} class="axis" x={x0 + slot * (i + 0.5)} y={H - 6} text-anchor="middle">{shortDay(b.start)}</text> : null))}
      </svg>
    </Section>
  );
}

function arc(cx: number, cy: number, ro: number, ri: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(ro, a0)} A${ro},${ro} 0 ${big} 1 ${p(ro, a1)} L${p(ri, a1)} A${ri},${ri} 0 ${big} 0 ${p(ri, a0)} Z`;
}

function Categories({ r, ctl }: { r: Report; ctl: Controller }) {
  const s = ctl.store;
  const rows = groupedCategories(r.categories, s.settings.maxItems);
  const total = r.totals.spent;
  const budgeted = new Set(Object.keys(s.activeBudgets()).map(foldKey));
  let a = 0;
  const segs = rows.map((c, i) => { const span = total > 0 ? (c.cents / total) * Math.PI * 2 : 0; const seg = { c, i, a0: a, a1: a + span }; a += span; return seg; });
  return (
    <Section title="Spending by category">
      {rows.length === 0 ? <p class="muted">No spending in this period.</p> : (
        <div class="donut-row">
          <svg class="donut" viewBox="0 0 120 120" role="img" aria-label={`Spending by category: ${rows.map((c) => `${c.name} ${Math.round(c.percent)} percent`).join(', ')}`}>
            {segs.length === 1 ? <circle cx="60" cy="60" r="43" fill="none" class={`ring p${segs[0].i % 8}`} stroke-width="26" />
              : segs.map(({ c, i, a0, a1 }) => <path key={c.name} class={`slice p${i % 8}`} d={arc(60, 60, 56, 30, a0, a1 - 0.012 > a0 ? a1 - 0.012 : a1)}><title>{`${c.name}: ${s.money(c.cents)} (${Math.round(c.percent)}%)`}</title></path>)}
          </svg>
          <ul class="legend-list">
            {rows.map((c, i) => (
              <li key={c.name}><i class={`sw p${i % 8}`} /><bdi dir="auto" class="cname">{c.name}</bdi>{budgeted.has(foldKey(c.name)) && <span title="Has a budget"><I.Target width={13} height={13} /><span class="sr"> has a budget</span></span>}<span class="grow" /><span class="muted num">{Math.round(c.percent)}%</span><b class="num">{s.money(c.cents)}</b></li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function BudgetBars({ ctl, month, title }: { ctl: Controller; month: DayRange; title: string }) {
  const s = ctl.store;
  const rows = s.budgetStatuses(month.start);
  if (rows.length === 0) return <Section title={`Budgets, ${title}`}><p class="muted">No budgets yet. Set a monthly limit in Settings.</p></Section>;
  return (
    <Section title={`Budgets, ${title}`}>
      <ul class="budget-rows">
        {rows.map((b) => (
          <li key={b.id}>
            <div class="brow"><bdi dir="auto" class="bname">{b.name}</bdi><span class="muted num">{s.money(b.spent)} of {s.money(b.limit)}</span><b class={`bmsg ${budgetLevel(b)}`}>{budgetMessage(b, (c) => s.money(c))}</b></div>
            <div class="bar" role="img" aria-label={`${b.name}: ${s.money(b.spent)} of ${s.money(b.limit)}, ${budgetMessage(b, (c) => s.money(c))}`}><span class={`fill ${budgetLevel(b)}`} style={{ width: `${Math.min(100, Math.round(budgetFraction(b) * 100))}%` }} /></div>
          </li>
        ))}
      </ul>
      <p class="muted small">Set a budget in Settings. Card payments are never counted.</p>
    </Section>
  );
}

function GlanceCard({ ctl, month, title }: { ctl: Controller; month: DayRange; title: string }) {
  const s = ctl.store;
  const g: Glance = s.glance(month.start);
  if (g.days === 0) return <Section title={`Month at a glance, ${title}`}><p class="muted">This month has not started yet.</p></Section>;
  const total = g.spent;
  const change = (p: number | null, previous: number) => p === null ? <span class="muted">{previous === 0 ? 'none last month' : '-'}</span>
    : p === 0 ? <span class="muted"><I.Equals /> same as last month</span>
    : <span class={p > 0 ? 'up' : 'down'}>{p > 0 ? <I.ArrowUp /> : <I.ArrowDown />} {p > 0 ? 'up' : 'down'} {Math.abs(p)}% vs last month</span>;
  return (
    <Section title={`Month at a glance, ${title}`}>
      <p class="glance-head"><strong class="num spent-t">{s.money(g.avgPerDay)}</strong><span class="muted"> spent per day, over {g.days} {g.days === 1 ? 'day' : 'days'} so far ({s.money(total)} in all)</span></p>
      <ul class="glance-rows">
        {g.rows.map((row) => <li key={row.name}><bdi dir="auto" class="cname">{row.name}</bdi><b class="num">{s.money(row.current)}</b><span class="chg">{change(row.percent, row.previous)}</span></li>)}
      </ul>
      <p class="muted small">Compared with the same days of the month before. Card payments are not counted.</p>
    </Section>
  );
}
