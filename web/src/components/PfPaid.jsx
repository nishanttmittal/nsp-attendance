import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, istMonth } from '../lib/data';
import { monthOptions, rupee } from '../lib/paycalc';

// PF PAID — what was deposited in each worker's PF account for a month (owner 2026-10-11: "so that
// when they are paid I can tell them how much 24% of PF is paid for them"). READ-ONLY. The figures come
// from the consultant's salary register and are loaded per month by jobs/setPfMonth.js into
// att_salary.pf[YYYY-MM] = { days, wage, ee, er }. Nothing here feeds pay. Owner-only (feature 'salary').
const sum = (list, f) => list.reduce((s, x) => s + Number(f(x) || 0), 0);

export default function PfPaid() {
  const [emps, setEmps] = useState(null);
  const [mk, setMk] = useState(() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000); d.setUTCMonth(d.getUTCMonth() - 1, 1);   // PF is for last month's salary
    return localStorage.getItem('nsp_pf_mk') || d.toISOString().slice(0, 7) || istMonth();
  });
  useEffect(() => {
    let alive = true;
    loadEmployees(true).then((l) => alive && setEmps(l)).catch(() => alive && setEmps([]));
    return () => { alive = false; };
  }, []);
  useEffect(() => { localStorage.setItem('nsp_pf_mk', mk); }, [mk]);

  const rows = useMemo(() => (emps || [])
    .filter((e) => e.pf && e.pf[mk])
    .map((e) => {
      const p = e.pf[mk];
      const all = Object.values(e.pf || {});
      return { code: e.code, name: e.name || e.code, days: p.days, wage: p.wage, ee: Number(p.ee || 0), er: Number(p.er || 0),
        tillNow: sum(all, (x) => Number(x.ee || 0) + Number(x.er || 0)), months: all.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name)), [emps, mk]);

  if (emps === null) return <p className="text-slate-500">Loading…</p>;
  const ee = sum(rows, (r) => r.ee), er = sum(rows, (r) => r.er);

  return (
    <div className="space-y-3">
      <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-3">
        <div className="font-bold text-emerald-900">🏦 PF paid — worker-wise</div>
        <p className="text-[11px] text-emerald-800 mt-0.5">
          What goes into each worker's PF account for the month: <b>his 12%</b> (cut from salary) + <b>company 12%</b>.
          Figures are from the consultant's salary sheet. View only — nothing here changes pay.
        </p>
      </div>

      <select value={mk} onChange={(e) => setMk(e.target.value)}
        className="w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base bg-white font-semibold">
        {monthOptions(8).map((m) => <option key={m.mk} value={m.mk}>{m.label}</option>)}
      </select>

      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm px-1">No PF figures loaded for this month yet. They are added after the consultant's salary sheet arrives.</p>
      ) : (
        <>
          <div className="flex gap-2 text-center">
            <div className="flex-1 rounded-xl bg-white border-2 border-slate-200 py-2">
              <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Workers 12%</div>
              <div className="font-bold text-slate-800 text-lg">{rupee(ee)}</div>
            </div>
            <div className="flex-1 rounded-xl bg-white border-2 border-slate-200 py-2">
              <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Company 12%</div>
              <div className="font-bold text-slate-800 text-lg">{rupee(er)}</div>
            </div>
            <div className="flex-1 rounded-xl bg-emerald-600 text-white py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide opacity-90">Total 24%</div>
              <div className="font-bold text-lg">{rupee(ee + er)}</div>
            </div>
          </div>

          {rows.map((r) => (
            <div key={r.code} className="bg-white border-2 border-slate-200 rounded-2xl p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-slate-900 text-base">{r.name}</div>
                  <div className="text-xs text-slate-500">PF on {r.days} day{Number(r.days) === 1 ? '' : 's'} · PF wage {rupee(r.wage)}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-extrabold text-xl text-emerald-700">{rupee(r.ee + r.er)}</div>
                  <div className="text-[11px] text-slate-500">into his PF account</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2 text-sm">
                <div className="bg-slate-50 rounded-lg px-2 py-1.5">His 12% <b className="float-right">{rupee(r.ee)}</b></div>
                <div className="bg-slate-50 rounded-lg px-2 py-1.5">Company 12% <b className="float-right">{rupee(r.er)}</b></div>
              </div>
              {r.months > 1 && <div className="text-xs text-slate-500 mt-1.5">Total deposited so far ({r.months} months): <b className="text-slate-700">{rupee(r.tillNow)}</b></div>}
            </div>
          ))}
          <p className="text-[11px] text-slate-400 px-1">{rows.length} workers. The PF challan is higher than this total: it also carries EPFO's admin and insurance charges, which the company pays and which do not go into any worker's account.</p>
        </>
      )}
    </div>
  );
}
