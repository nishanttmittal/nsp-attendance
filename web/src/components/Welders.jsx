import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, loadAllPunches, istMonth } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee } from '../lib/paycalc';

// WELDERS — contractor-paid, NEVER settled here (owner rule 2026-08-19).
// Welders are paid PIECE-RATE through the welder app by contractors Naveen / Jitender. Their
// attendance is kept only to (a) see what each contractor's team is earning and (b) hold discipline.
// So this screen is READ-ONLY on purpose: no Settle, no Lock, no advance, no payable total that
// looks like a liability. Owner-only (feature 'salary' → admin).
const CONTRACTORS = [
  { key: 'naveen', label: 'Naveen' },
  { key: 'jitender', label: 'Jitender' },
];
const contractorOf = (e) => {
  const hay = `${e.name || ''} ${e.nickname || ''}`.toLowerCase();
  const hit = CONTRACTORS.find((c) => hay.includes(c.key));
  return hit ? hit.label : 'Not marked';
};
const isWelder = (e) => (e.dept || '').toUpperCase() === 'WELDING';

export default function Welders() {
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [punches, setPunches] = useState({});
  const [mk, setMk] = useState(() => localStorage.getItem('nsp_welders_mk') || istMonth());
  const [openGroup, setOpenGroup] = useState('');

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
      const r = payFor(e, attMap, mk, ctx, 0, punches[e.code]);
      return {
        code: e.code, name: e.name || e.code, active: e.active !== false,
        contractor: contractorOf(e), days: r.pay.paidDays || 0,
        otHrs: r.pay.otHrsNet || 0, earned: Number(r.pay.net || 0),
      };
    // a welder with no attendance in the month isn't the contractor's cost that month
    }).filter((r) => r.days > 0 || r.earned > 0);
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
          Welders are paid <b>per piece through the welder app</b> by Naveen / Jitender. Nothing here is
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
                {g.list.map((r) => (
                  <div key={r.code} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-slate-700">
                      {r.name}{!r.active && <span className="text-slate-400"> · removed</span>}
                      <span className="text-slate-400"> · {r.days}d{r.otHrs > 0 ? ` · OT ${r.otHrs}h` : ''}</span>
                    </span>
                    <b className="shrink-0 text-slate-800">{rupee(r.earned)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-[11px] text-slate-500 px-1">
        Contractor is read from the worker's name. A welder showing under "Not marked" just needs
        "naveen" or "jitender" in his name to group correctly. Actual contractor payment and
        per-piece rates live in the welder app.
      </p>
    </div>
  );
}
