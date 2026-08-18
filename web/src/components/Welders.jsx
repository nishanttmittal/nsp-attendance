import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, loadAllPunches, istMonth } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee } from '../lib/paycalc';
import WorkerSummary from './WorkerSummary.jsx';

// WELDERS — contractor-paid, NEVER settled here (owner rule 2026-08-19).
// Welders are paid PIECE-RATE through the welder app by contractors Naveen / Jitender. Their
// attendance is kept only to (a) see what each contractor's team is earning and (b) hold discipline.
// So this screen is READ-ONLY on purpose: no Settle, no Lock, no advance, no payable total that
// looks like a liability. Owner-only (feature 'salary' → admin).
const CONTRACTORS = [
  { key: 'naveen', label: 'Naveen' },
  { key: 'jitender', label: 'Jitender' },
  { key: 'raju', label: 'Raju' },
];
// Which contractor a welder worked under IN THAT MONTH. Welders move between contractors (owner
// 2026-08-19: virender, rajesh kumar and rakesh singh were under RAJU till July and under NAVEEN
// from August), so a single flat field would silently re-write history — open July and their days
// would be credited to the wrong contractor. Resolution order:
//   1. contractorHistory[] — [{ from:'YYYY-MM', contractor }], the entry with the latest `from` <= mk
//   2. contractor — a flat field, for welders who never changed hands
//   3. the worker's name, which usually carries the contractor
// Same effective-dated idea the welder app already uses for per-piece rates.
const contractorOn = (e, mk) => {
  const hist = Array.isArray(e.contractorHistory) ? e.contractorHistory : [];
  const eff = hist.filter((h) => h && h.contractor && (!h.from || String(h.from) <= mk))
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  if (eff.length) return String(eff[eff.length - 1].contractor).trim();
  const flat = String(e.contractor || '').trim();
  if (flat) return flat;
  const hay = `${e.name || ''} ${e.nickname || ''}`.toLowerCase();
  const hit = CONTRACTORS.find((c) => hay.includes(c.key));
  return hit ? hit.label : 'Not marked';
};
const isWelder = (e) => (e.dept || '').toUpperCase() === 'WELDING';
// What the welder EARNED for the month = days + OT + any extras, BEFORE any advance is cut.
// (`pay.net` is after the advance recovery and `pay.payable` also folds in last month's balance —
// neither answers "how much is he getting as monthly pay", which is what this screen is for.)
const monthPay = (p) => Number(p.base || 0) + Number(p.otPay || 0) + Number(p.perfectBonus || 0)
  + Number(p.restoreSaturdayPay || 0) + Number(p.gracePay || 0) + Number(p.bonus || 0);

export default function Welders() {
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [punches, setPunches] = useState({});
  const [mk, setMk] = useState(() => localStorage.getItem('nsp_welders_mk') || istMonth());
  const [openGroup, setOpenGroup] = useState('');
  const [openWorker, setOpenWorker] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([loadEmployees(true), loadAllAttendance(), loadAllPunches()])
      .then(([list, am, pu]) => { if (!alive) return; setEmps(list); setAttMap(am); setPunches(pu); })
      .catch(() => alive && setEmps([]));
    return () => { alive = false; };
  }, []);
  useEffect(() => { localStorage.setItem('nsp_welders_mk', mk); }, [mk]);

  const ctx = useMemo(() => monthCtx(mk), [mk]);
  const groups = useMemo(() => {
    if (!emps) return [];
    const rows = emps.filter(isWelder).map((e) => {
      // keep the WHOLE payFor row — WorkerSummary renders the same detail as the regular Salary tab
      const r = payFor(e, attMap, mk, ctx, 0, punches[e.code]);
      return {
        r, code: e.code, name: e.name || e.code, active: e.active !== false,
        contractor: contractorOn(e, mk), days: r.pay.paidDays || 0,
        otHrs: r.pay.otHrsNet || 0, earned: monthPay(r.pay),
      };
    // a welder with no attendance in the month isn't the contractor's cost that month
    }).filter((x) => x.days > 0 || x.earned > 0);
    const by = {};
    rows.forEach((r) => { (by[r.contractor] = by[r.contractor] || []).push(r); });
    return Object.entries(by)
      .map(([name, list]) => ({
        name,
        list: list.sort((a, b) => b.earned - a.earned),
        total: list.reduce((s, r) => s + r.earned, 0),
        days: list.reduce((s, r) => s + r.days, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [emps, attMap, punches, mk, ctx]);

  const grand = groups.reduce((s, g) => s + g.total, 0);
  const headcount = groups.reduce((s, g) => s + g.list.length, 0);

  if (emps === null) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-3">
        <div className="font-bold text-amber-900">🔧 Welders — paid by contractor</div>
        <p className="text-[11px] text-amber-800 mt-0.5">
          Welders are paid <b>per piece through the welder app</b> by their contractor. Nothing here is
          settled or paid from this app — these figures show what each contractor's team is worth for the
          month, from attendance. Owner-only.
        </p>
      </div>

      <select value={mk} onChange={(e) => setMk(e.target.value)}
        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base bg-white font-semibold">
        {monthOptions(8).map((m) => <option key={m.mk} value={m.mk}>{m.label}</option>)}
      </select>

      <div className="flex gap-2 text-center">
        <div className="flex-1 rounded-xl bg-white border-2 border-slate-200 py-2">
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Welders worked</div>
          <div className="font-bold text-slate-800 text-lg">{headcount}</div>
        </div>
        <div className="flex-1 rounded-xl bg-white border-2 border-slate-200 py-2">
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Month value</div>
          <div className="font-bold text-slate-800 text-lg">{rupee(grand)}</div>
        </div>
      </div>

      {!groups.length && <p className="text-sm text-slate-400 py-4 text-center">No welder attendance in this month.</p>}

      {groups.map((g) => {
        const isOpen = openGroup === g.name;
        return (
          <div key={g.name} className="bg-white rounded-2xl border-2 border-slate-200 p-3">
            <button onClick={() => setOpenGroup(isOpen ? '' : g.name)} className="w-full flex items-center justify-between gap-2 text-left">
              <span>
                <b className="text-slate-900">{g.name}</b>
                <span className="text-xs text-slate-500"> · {g.list.length} welder{g.list.length > 1 ? 's' : ''} · {Math.round(g.days)} days</span>
              </span>
              <span className="shrink-0 text-right">
                <b className="text-slate-900">{rupee(g.total)}</b>
                <span className="text-[11px] text-slate-400"> {isOpen ? '▾' : '▸'}</span>
              </span>
            </button>
            {isOpen && (
              <div className="mt-2 divide-y divide-slate-100 text-[13px]">
                {g.list.map((w) => (
                  <WelderRow key={w.code} w={w} mk={mk}
                    open={openWorker === w.code}
                    onToggle={() => setOpenWorker(openWorker === w.code ? '' : w.code)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-[11px] text-slate-500 px-1">
        Grouping uses the worker's <b>contractor</b> field, falling back to his name. If a new welder
        lands under "Not marked", tell Claude who he works under and it gets stamped on his record —
        no need to rename him. Actual contractor payment and per-piece rates live in the welder app.
      </p>
    </div>
  );
}

// One welder: headline pay + the SAME detail block the regular Salary tab shows (WorkerSummary) —
// present/absent/half/missed-punch dates, late, Saturdays, fine, advances, carried balance.
// Everything the regular row gives EXCEPT any way to settle, lock or pay.
function WelderRow({ w, mk, open, onToggle }) {
  const { pay } = w.r;
  return (
    <div className="py-1.5">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-2 text-left">
        <span className="min-w-0 truncate text-slate-700">
          {w.name}{!w.active && <span className="text-slate-400"> · removed</span>}
          <span className="text-slate-400"> · {w.days}d{w.otHrs > 0 ? ` · OT ${w.otHrs}h` : ''}</span>
          <span className="text-blue-700 underline decoration-dotted underline-offset-2 ml-1">details {open ? '▾' : '▸'}</span>
        </span>
        <b className="shrink-0 text-slate-800">{rupee(w.earned)}</b>
      </button>
      {open && (
        <div className="mt-1">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] bg-white border border-slate-200 rounded-lg p-2">
            <span className="text-slate-500">Monthly rate</span>
            <span className="text-right font-semibold">{rupee(w.r.emp.amount || w.r.emp.wage || 0)}{w.r.emp.type === 'daily' ? '/day' : '/month'}</span>
            <span className="text-slate-500">Days pay ({pay.paidDays}d)</span>
            <span className="text-right font-semibold">{rupee(pay.base)}</span>
            {(pay.otPay || 0) > 0 && (<><span className="text-slate-500">Overtime ({pay.otHrsNet}h)</span>
              <span className="text-right font-semibold">{rupee(pay.otPay)}</span></>)}
            {(pay.perfectBonus || 0) > 0 && (<><span className="text-slate-500">Perfect-attendance day</span>
              <span className="text-right font-semibold">{rupee(pay.perfectBonus)}</span></>)}
            {(pay.restoreSaturdayPay || 0) > 0 && (<><span className="text-slate-500">Saturdays given back</span>
              <span className="text-right font-semibold">{rupee(pay.restoreSaturdayPay)}</span></>)}
            {(pay.gracePay || 0) > 0 && (<><span className="text-slate-500">Grace</span>
              <span className="text-right font-semibold">{rupee(pay.gracePay)}</span></>)}
            {(pay.bonus || 0) > 0 && (<><span className="text-slate-500">Bonus</span>
              <span className="text-right font-semibold">{rupee(pay.bonus)}</span></>)}
            <span className="text-slate-500 font-bold border-t border-slate-100 pt-0.5">Month pay</span>
            <span className="text-right font-bold border-t border-slate-100 pt-0.5">{rupee(w.earned)}</span>
          </div>
          <WorkerSummary r={w.r} mk={mk} />
          <p className="text-[10px] text-slate-400 px-1 pt-0.5">Not settled here — paid per piece by the contractor.</p>
        </div>
      )}
    </div>
  );
}
