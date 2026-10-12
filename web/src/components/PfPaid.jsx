import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadEmployee, saveMonth, istMonth } from '../lib/data';
import { monthOptions, rupee } from '../lib/paycalc';

// PF PAID — what was deposited in each worker's PF account for a month (owner 2026-10-11: "so that
// when they are paid I can tell them how much 24% of PF is paid for them"). READ-ONLY. The figures come
// from the consultant's salary register and are loaded per month by jobs/setPfMonth.js into
// att_salary.pf[YYYY-MM] = { days, wage, ee, er } and are view-only. The ONE thing that feeds pay is the
// "PF cut from salary" box: an amount the owner types himself per worker (months[mk].pfCut), which comes
// off that worker's payable at settlement. Owner-only (feature 'salary').
const sum = (list, f) => list.reduce((s, x) => s + Number(f(x) || 0), 0);

export default function PfPaid() {
  const [emps, setEmps] = useState(null);
  const [draft, setDraft] = useState({});   // `${mk}:${code}` -> text being typed (month in the key: a figure typed for Sep must never save into Oct)
  const [busy, setBusy] = useState('');
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
      const md = (e.months || {})[mk] || {};
      return { code: e.code, name: e.name || e.code, locked: !!(md.locked || md.payment), pfCut: Number(md.pfCut || 0), days: p.days, wage: p.wage, ee: Number(p.ee || 0), er: Number(p.er || 0),
        tillNow: sum(all, (x) => Number(x.ee || 0) + Number(x.er || 0)), months: all.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name)), [emps, mk]);

  const dk = (r) => `${mk}:${r.code}`;
  async function saveCut(r) {
    const key = dk(r), month = mk;                      // freeze month + worker for this save
    const v = Math.max(0, Math.round(Number(draft[key]) || 0));
    setBusy(r.code);
    try {
      // Re-read the record first: the month may have been settled (here or on another phone) since this
      // screen loaded. A settled month is never written to — reopen it in Salary to change the cut.
      const now = await loadEmployee(r.code);
      const mdNow = (now.months || {})[month] || {};
      if (mdNow.locked || mdNow.payment) {
        setEmps((prev) => prev.map((e) => (e.code === r.code ? now : e)));
        setDraft((d) => { const n = { ...d }; delete n[key]; return n; });
        alert(`${r.name}: ${month} is already settled. Reopen it in Salary first, then enter the PF cut.`);
        return;
      }
      await saveMonth(r.code, month, { pfCut: v });
      const fresh = await loadEmployee(r.code).catch(() => null);
      if (fresh) setEmps((prev) => prev.map((e) => (e.code === r.code ? fresh : e)));
      setDraft((d) => { const n = { ...d }; delete n[key]; return n; });
    } catch { alert('Could not save — check the internet and try again.'); }
    finally { setBusy(''); }
  }

  if (emps === null) return <p className="text-slate-500">Loading…</p>;
  const ee = sum(rows, (r) => r.ee), er = sum(rows, (r) => r.er);

  return (
    <div className="space-y-3">
      <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-3">
        <div className="font-bold text-emerald-900">🏦 PF paid — worker-wise</div>
        <p className="text-[11px] text-emerald-800 mt-0.5">
          What goes into each worker's PF account for the month: <b>his 12%</b> (cut from salary) + <b>company 12%</b>.
          Figures are from the consultant's salary sheet and are view only. The one thing that changes pay is the <b>PF cut</b> box on each card: what you type there comes off that worker's salary.
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
              <div className="mt-2 border-t border-slate-200 pt-2">
                <div className="text-sm font-semibold text-slate-800">PF cut from his salary ₹</div>
                {r.locked ? (
                  <div className="text-sm text-slate-600 mt-1">{rupee(r.pfCut)} <span className="text-[11px] text-slate-400">· month already settled — reopen it in Salary to change</span></div>
                ) : (
                  <div className="flex gap-2 mt-1">
                    <input type="number" inputMode="numeric" min="0" placeholder="0"
                      value={draft[dk(r)] ?? (r.pfCut ? String(r.pfCut) : '')}
                      onChange={(e) => setDraft((d) => ({ ...d, [dk(r)]: e.target.value }))}
                      className="flex-1 min-w-0 border-2 border-slate-300 rounded-xl px-3 py-2.5 text-lg font-semibold" />
                    <button disabled={busy === r.code || draft[dk(r)] === undefined} onClick={() => saveCut(r)}
                      className="bg-emerald-600 text-white rounded-xl px-5 font-bold disabled:opacity-40 active:scale-95">Save</button>
                  </div>
                )}
                {!r.locked && r.pfCut > 0 && draft[dk(r)] === undefined && <div className="text-[11px] text-emerald-700 mt-1">✓ {rupee(r.pfCut)} will come off his payable at settlement.</div>}
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
