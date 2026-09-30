import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllPunches, loadLoadingMirror, addAdvanceDirect, queueAdvance, pendingAdvances, prunePendingAdvances, enteredBy, addHisabClear, removeHisabClear } from '../lib/data';
import { rupee } from '../lib/paycalc';
import { isLoader, openHisab, punchesSyncedTill, lastPunchDate, addDays, todayIST, dinGhante, r2, stdHoursOf } from '../lib/loadingHisab';

// 🚚 LOADING HISAB — owner-only (feature 'salary'). Owner 13-09-2026: "I pay them once in a while, and
// I cannot remember from which day until which date I have cleared their old account."
// One card per loader: CLEARED TILL date → hours worked since (from the machine) → earned → cash
// given since → balance. "✅ Clear" stores the date on the worker (hisabClears[]) and records any cash
// paid now as a normal dated advance, so the Salary tab sees the same money. It never locks a month,
// never writes a payment and never changes payable.
const fmt = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : '—');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (ymd) => DOW[new Date(ymd + 'T00:00:00').getDay()];

// readOnly (manager, owner 29-09-2026 "no modification just viewing"): figures come from the worker's
// att_meta/loading_hisab copy (att_salary/att_punches are owner-only), no Clear / Undo buttons.
export default function LoadingHisab({ user, readOnly = false }) {
  const [emps, setEmps] = useState(null);
  const [punches, setPunches] = useState({});
  const [err, setErr] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [clearing, setClearing] = useState(null);   // code being cleared
  const [asOf, setAsOf] = useState('');
  const [quick, setQuick] = useState('');   // 'adv' | 'casual' — owner quick-entry sheets (29-09-2026)
  const [pending, setPending] = useState(() => pendingAdvances());   // queued on this phone, not yet applied

  async function reload() {
    try {
      if (readOnly) {
        const m = await loadLoadingMirror();
        if (!m) { setErr('Loading hisab is not ready yet — try again in 5 minutes.'); setEmps([]); return; }
        setEmps(m.emps || []); setPunches(m.punches || {}); setAsOf(m.updatedAt || ''); setErr('');
        setPending(prunePendingAdvances(new Set((m.emps || []).flatMap((e) => (e.advances || []).map((a) => a.id)))));
        return;
      }
      const [list, pu] = await Promise.all([loadEmployees(true), loadAllPunches()]);
      setEmps(list); setPunches(pu); setErr('');
      setPending(prunePendingAdvances(new Set(list.flatMap((e) => (e.advances || []).map((x) => x.id)))));
    } catch (e) { setErr('Could not load — check the internet and try again.'); setEmps((p) => p || []); }
  }
  useEffect(() => { reload(); }, []);

  const synced = useMemo(() => punchesSyncedTill(punches), [punches]);
  const upTo = synced && synced < todayIST() ? synced : todayIST();
  const rows = useMemo(() => (emps || []).filter(isLoader).map((e) => ({ emp: e, h: openHisab(e, punches[e.code], upTo) }))
    // a loader who has left (removed, or no punch for 3 weeks) stays only while something is still open
    .filter((r) => r.h.hours > 0 || Math.round(r.h.balance) !== 0 || r.emp.appOnly
      || (r.emp.active !== false && lastPunchDate(punches[r.emp.code]) >= addDays(upTo, -21)))
    .sort((a, b) => (b.h.hours - a.h.hours) || (a.emp.name || '').localeCompare(b.emp.name || '')), [emps, punches, upTo]);

  if (emps === null) return <p className="text-slate-500">Loading…</p>;
  const totalDue = rows.reduce((s, r) => s + Math.max(0, r.h.balance), 0);
  const lastTills = rows.map((r) => r.h.last?.till).filter(Boolean).sort();

  function shareSlip() {
    const L = [`*Loading hisab* — machine punches till ${fmt(synced)}`, ''];
    rows.forEach(({ emp, h }) => {
      if (!h.hours && !h.paid && !h.carryIn) return;
      L.push(`*${emp.name}* (${fmt(h.from)} → ${fmt(h.to)})`);
      h.days.forEach((d) => L.push(`${fmt(d.ymd)} ${dow(d.ymd)}  ${d.in || '—'}-${d.out || '—'}  ${d.missing ? 'punch missing' : d.hours + 'h'}`));
      L.push(`Total ${h.hours}h = ${dinGhante(h.hours, h.std)} = ${rupee(h.earned)}`);
      if (h.carryIn) L.push(`Pichla ${h.carryIn > 0 ? 'baaki' : 'extra liya'} ${rupee(Math.abs(h.carryIn))}`);
      if (h.paid) L.push(`Diya: ${h.cash.map((c) => `${rupee(c.amount)} (${fmt(c.date)})`).join(', ')}`);
      L.push(h.balance >= 0 ? `*Dena hai ${rupee(Math.round(h.balance))}*` : `*Extra liya ${rupee(Math.round(-h.balance))}*`, '');
    });
    const text = L.join('\n');
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`);
  }

  return (
    <div className="space-y-3">
      <div className="bg-sky-50 border-2 border-sky-200 rounded-2xl p-3">
        <div className="font-bold text-sky-900">🚚 Loading hisab — cleared till kab tak?</div>
        <p className="text-[11px] text-sky-800 mt-0.5">
          Each loader shows the date his account was last cleared, hours worked since (from the machine, rounded
          per day like Anshul's slip, 10 h = 1 day), cash given since, and what is due now. {readOnly ? 'View only — the owner clears the hisab. You can give an advance.' : 'Owner-only.'}
        </p>
        {readOnly && asOf && <p className="text-[11px] text-sky-700 mt-0.5">Updated {new Date(asOf).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>}
      </div>
      {err && <p className="text-sm text-rose-600 font-medium">{err}</p>}

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Last cleared" value={lastTills.length ? fmt(lastTills[lastTills.length - 1]) : '—'} />
        <Stat label="Punches till" value={fmt(synced)} warn={synced && synced < todayIST()} />
        <Stat label="Due now" value={rupee(Math.round(totalDue))} strong />
      </div>
      {synced && synced < todayIST() && (
        <p className="text-[11px] text-amber-700 px-1">⚠ Machine data is in only till {fmt(synced)}. Days after that are not counted yet — clear only till {fmt(synced)}.</p>
      )}

      {!readOnly && <button onClick={shareSlip} className="w-full bg-green-600 text-white rounded-2xl py-3 font-bold active:scale-95 transition-all">📤 Share slip on WhatsApp</button>}   {/* owner 29-09-2026: no share slip for the manager */}
      {/* owner 30-09-2026 "advance pay in loading tab for anshul": manager gets the advance button too (queued) */}
      <div className={`grid gap-2 ${readOnly ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <button onClick={() => setQuick('adv')} className="bg-rose-600 text-white rounded-2xl py-3 font-bold active:scale-95 transition-all">💸 Advance to loader</button>
        {!readOnly && <button onClick={() => setQuick('casual')} className="bg-amber-600 text-white rounded-2xl py-3 font-bold active:scale-95 transition-all">👷 Pay casual for a day</button>}
      </div>
      {(() => {
        const names = Object.fromEntries((emps || []).map((e) => [e.code, e.name]));
        const mine = pending.filter((q) => names[q.code]);
        return mine.length > 0 && (
          <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-3 text-sm">
            <div className="font-semibold text-amber-900">⏳ Advance saved — waiting to be applied (then it moves onto the card)</div>
            {mine.map((q) => <div key={q.id} className="text-amber-800">{fmt(q.date)} · {names[q.code]} · {rupee(q.amount)}{q.remark ? ` · ${q.remark}` : ''}</div>)}
          </div>
        );
      })()}

      {!rows.length && <p className="text-sm text-slate-400 text-center py-4">No loading staff found.</p>}
      {rows.map(({ emp, h }) => (
        <LoaderCard key={emp.code} emp={emp} h={h} readOnly={readOnly} me={user?.email} open={openCode === emp.code}
          onToggle={() => setOpenCode(openCode === emp.code ? '' : emp.code)}
          onClear={() => setClearing(emp.code)}
          onUndo={async (entry) => {
            if (!window.confirm(`Undo the clearance till ${fmt(entry.till)} for ${emp.name}?\n\nThe cash entry made with it (${rupee(entry.cashNow || 0)}) is NOT removed — delete it from his Salary page if it was wrong.`)) return;
            try { await removeHisabClear(emp.code, entry); await reload(); } catch { alert('Could not undo — try again.'); }
          }} />
      ))}

      {quick === 'adv' && (
        <AdvanceSheet loaders={rows.map((r) => r.emp).filter((e) => !e.appOnly && e.active !== false)} user={user} viaQueue={readOnly}
          onClose={() => setQuick('')} onDone={async () => { setQuick(''); if (readOnly) setPending(pendingAdvances()); else await reload(); }} />
      )}
      {!readOnly && quick === 'casual' && (() => {
        const r = rows.find((x) => x.emp.appOnly);
        return r ? <CasualDaySheet emp={r.emp} user={user} onClose={() => setQuick('')} onDone={async () => { setQuick(''); await reload(); }} />
          : <p className="text-sm text-rose-600">No casual (loading abc) record found.</p>;
      })()}
      {!readOnly && clearing && (() => {
        const r = rows.find((x) => x.emp.code === clearing);
        return r ? <ClearSheet emp={r.emp} punchDoc={punches[r.emp.code]} maxTill={upTo} user={user}
          onClose={() => setClearing(null)} onDone={async () => { setClearing(null); await reload(); }} /> : null;
      })()}
    </div>
  );
}

function Stat({ label, value, warn, strong }) {
  return (
    <div className={`rounded-xl border-2 py-2 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">{label}</div>
      <div className={`${strong ? 'font-extrabold text-rose-600' : 'font-bold text-slate-800'} text-lg`}>{value}</div>
    </div>
  );
}

function LoaderCard({ emp, h, readOnly, me, open, onToggle, onClear, onUndo }) {
  const casual = !!emp.appOnly;
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3">
      <button onClick={onToggle} className="w-full text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-bold text-slate-900 truncate">{emp.name}{emp.active === false && <span className="text-slate-400 font-normal"> · removed</span>}</div>
            <div className="text-xs text-slate-500">
              ✅ Cleared till <b className="text-slate-700">{h.last ? fmt(h.last.till) : 'never'}</b>
              {casual ? ' · casual (not on machine)' : ` · since then ${h.daysWorked} day${h.daysWorked === 1 ? '' : 's'} · ${h.hours}h = ${dinGhante(h.hours, h.std)}`}
            </div>
            {h.missing > 0 && <div className="text-[11px] text-amber-700">⚠ {h.missing} day{h.missing > 1 ? 's' : ''} with a missing punch (counted 0)</div>}
          </div>
          <div className="text-right shrink-0">
            <div className={`font-extrabold text-xl ${h.balance >= 0 ? 'text-rose-600' : 'text-amber-700'}`}>
              {h.balance >= 0 ? rupee(Math.round(h.balance)) : `extra ${rupee(Math.round(-h.balance))}`}
            </div>
            <div className="text-[11px] text-slate-400">{open ? '▾ hide' : '▸ details'}</div>
          </div>
        </div>
      </button>

      {open && (
        <div className="mt-2 space-y-2 text-[12px]">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 bg-slate-50 rounded-lg p-2">
            {h.carryIn !== 0 && (<><span className="text-slate-500">From last hisab</span>
              <span className="text-right font-semibold">{h.carryIn > 0 ? `+${rupee(h.carryIn)} owed` : `${rupee(h.carryIn)} extra taken`}</span></>)}
            <span className="text-slate-500">Earned {fmt(h.from)} → {fmt(h.to)}</span>
            <span className="text-right font-semibold">{rupee(h.earned)}</span>
            <span className="text-slate-500">Cash given since</span>
            <span className="text-right font-semibold">− {rupee(h.paid)}</span>
            <span className="text-slate-700 font-bold border-t border-slate-200 pt-0.5">{h.balance >= 0 ? 'Due now' : 'Extra taken'}</span>
            <span className="text-right font-bold border-t border-slate-200 pt-0.5">{rupee(Math.abs(Math.round(h.balance)))}</span>
          </div>

          {h.days.length > 0 && (
            <table className="w-full">
              <thead><tr className="text-slate-400 text-left text-[10px]"><th className="font-normal">Date</th><th className="font-normal">In → Out</th><th className="font-normal text-right">Hours</th></tr></thead>
              <tbody>
                {h.days.map((d) => (
                  <tr key={d.ymd} className={`border-t border-slate-100 ${d.missing ? 'bg-amber-50' : ''}`}>
                    <td className="py-0.5 text-slate-600 whitespace-nowrap">{fmt(d.ymd)} {dow(d.ymd)}</td>
                    <td className="text-slate-500">{d.in || '—'} → {d.out || '—'}{d.missing && <span className="text-amber-700"> ⚠ no {d.missing.toUpperCase()}</span>}</td>
                    <td className="text-right font-semibold text-slate-700">{d.missing ? '0' : `${d.hours}h`}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 font-bold"><td colSpan={2}>Total</td><td className="text-right">{h.hours}h</td></tr>
              </tbody>
            </table>
          )}

          {h.cash.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">Cash given since last clear</div>
              {h.cash.map((c) => (
                <div key={c.key} className="flex justify-between border-t border-slate-100 py-0.5">
                  <span className="text-slate-600">{fmt(c.date)} · {c.mode}{c.remark ? <span className="text-slate-400"> · {c.remark}</span> : ''}{c.by ? <span className="text-slate-400"> · by {enteredBy(c.by, me)}</span> : ''}</span>
                  <b>{rupee(c.amount)}</b>
                </div>
              ))}
            </div>
          )}

          {!readOnly && <button onClick={onClear} className="w-full bg-emerald-600 text-white rounded-xl py-3 text-base font-bold active:scale-95 transition-all">✅ Clear hisab</button>}

          {h.clears.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">Past clearances</div>
              {h.clears.slice().reverse().map((c, i) => (
                <div key={c.id} className="flex items-center justify-between gap-2 border-t border-slate-100 py-1">
                  <span className="text-slate-600">
                    till <b>{fmt(c.till)}</b>{c.casualName ? <span className="text-slate-700"> · {c.casualName}</span> : null}{c.seed ? <span className="text-slate-400"> · opening</span>
                      : <span className="text-slate-400"> · {c.hours}h{c.adjHours ? <span className="text-amber-700"> (machine {c.machineHours ?? '—'}h, {c.adjHours > 0 ? '+' : ''}{c.adjHours}h: {c.adjReason})</span> : ''} · earned {rupee(c.earned)} · paid {rupee(c.paid)}{c.carry ? ` · left ${rupee(c.carry)}` : ''}</span>}
                  </span>
                  {!readOnly && i === 0 && !c.seed && <button onClick={() => onUndo(c)} className="text-[11px] text-slate-500 underline shrink-0">Undo</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ClearSheet({ emp, punchDoc, maxTill, user, onClose, onDone }) {
  const [till, setTill] = useState(maxTill);
  const [casualDays, setCasualDays] = useState('');
  // Owner 21-09-2026 "add override": hours can be adjusted ± with a reason. The machine hours stay as
  // they are; the adjustment and its reason are stored inside the clear entry (adjHours / adjReason).
  const [adj, setAdj] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const h = useMemo(() => openHisab(emp, punchDoc, till), [emp, punchDoc, till]);
  const casual = !!emp.appOnly;
  const extraHours = casual ? r2((Number(casualDays) || 0) * h.std) : 0;
  const adjHours = r2(Number(adj) || 0);
  const totalHours = r2(h.hours + extraHours + adjHours);
  const earned = r2((totalHours * h.wage) / h.std);
  const due = r2(h.carryIn + earned - h.paid);
  const [cash, setCash] = useState(() => String(Math.max(0, Math.round(due))));
  const [mode, setMode] = useState('cash');
  const [busy, setBusy] = useState(false);
  // ids minted once per sheet → a timed-out save that actually landed is not recorded twice on retry
  const [ids] = useState(() => {
    const s = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    return { clear: 'clr-' + s, adv: 'adv-' + todayIST() + '-' + s };
  });
  useEffect(() => { setCash(String(Math.max(0, Math.round(due)))); }, [due]);
  const cashNow = Math.max(0, Number(cash) || 0);
  const left = r2(due - cashNow);

  async function go() {
    if (till < h.from) { alert(`Pick a date on or after ${fmt(h.from)}.`); return; }
    if (casual && !(Number(casualDays) >= 0 && casualDays !== '')) { alert('Enter how many days the casual loaders worked (0 if none).'); return; }
    if (adjHours !== 0 && !adjReason.trim()) { alert('Write the reason for adjusting the hours (e.g. "left early 16/9, no out punch").'); return; }
    if (totalHours < 0) { alert('Adjusted hours cannot go below zero.'); return; }
    setBusy(true);
    try {
      const advIds = h.cash.filter((c) => c.kind === 'adv').map((c) => c.key);
      const payKeys = h.cash.filter((c) => c.kind === 'pay').map((c) => c.key);
      if (cashNow > 0) {
        await addAdvanceDirect(emp.code, { id: ids.adv, date: todayIST(), mode, amount: cashNow,
          remark: `Loading hisab till ${fmt(till)}`, paidBy: user.email }, user.email);
        advIds.push(ids.adv);
      }
      await addHisabClear(emp.code, {
        id: ids.clear, from: h.from, till, hours: totalHours, machineHours: h.hours, earned,
        ...(casual ? { casualDays: Number(casualDays) || 0 } : {}),
        ...(adjHours !== 0 ? { adjHours, adjReason: adjReason.trim() } : {}),
        carryIn: h.carryIn, paid: r2(h.paid + cashNow), cashNow, mode, carry: left,
        advIds, payKeys, by: user.email, at: new Date().toISOString(),
      });
      await onDone();
    } catch (e) {
      const m = String(e?.message || '');
      if (/^LOCKED/.test(m)) alert('That month is already paid & locked — the cash could not be recorded. Nothing was cleared.');
      else alert('Could not save — check the internet and tap Clear again (it will not double).');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-end sm:items-center justify-center p-2" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-bold text-lg text-slate-900">✅ Clear hisab — {emp.name}</div>
        <label className="block text-sm text-slate-600">Cleared till (last day included)
          <input type="date" value={till} min={h.from} max={maxTill} onChange={(e) => setTill(e.target.value || maxTill)}
            className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" /></label>
        {casual && (
          <label className="block text-sm text-slate-600">Days worked by casual loaders ({fmt(h.from)} → {fmt(till)})
            <input type="number" inputMode="decimal" value={casualDays} onChange={(e) => setCasualDays(e.target.value)}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base text-center font-semibold" /></label>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
          <label className="block text-sm text-slate-600">Adjust hours (± , optional)
            <input type="number" inputMode="decimal" step="1" value={adj} placeholder="0" onChange={(e) => setAdj(e.target.value)}
              className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base text-center font-semibold" /></label>
          <div className="text-xs text-slate-500 pb-3 whitespace-nowrap">machine {h.hours}h → <b className="text-slate-800">{totalHours}h</b></div>
        </div>
        {adjHours !== 0 && (
          <label className="block text-sm text-slate-600">Reason (required)
            <input type="text" value={adjReason} placeholder="e.g. 16/9 left early, no out punch" onChange={(e) => setAdjReason(e.target.value)}
              className="mt-1 w-full border-2 border-amber-300 rounded-xl px-3 py-2.5 text-base" /></label>
        )}
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm bg-slate-50 rounded-lg p-2">
          <span className="text-slate-500">{fmt(h.from)} → {fmt(till)}</span><span className="text-right">{casual ? `${casualDays || 0} din` : `${h.hours}h = ${dinGhante(h.hours, h.std)}`}</span>
          {adjHours !== 0 && (<><span className="text-amber-700">Adjusted {adjHours > 0 ? '+' : ''}{adjHours}h</span><span className="text-right text-amber-700">{totalHours}h = {dinGhante(totalHours, h.std)}</span></>)}
          {h.carryIn !== 0 && (<><span className="text-slate-500">From last hisab</span><span className="text-right">{rupee(h.carryIn)}</span></>)}
          <span className="text-slate-500">Earned</span><span className="text-right font-semibold">{rupee(earned)}</span>
          <span className="text-slate-500">Already given</span><span className="text-right font-semibold">− {rupee(h.paid)}</span>
          <span className="font-bold border-t border-slate-200 pt-0.5">{due >= 0 ? 'Due' : 'Extra taken'}</span><span className="text-right font-bold border-t border-slate-200 pt-0.5">{rupee(Math.abs(Math.round(due)))}</span>
        </div>
        <label className="block text-sm text-slate-600">Paying now ₹
          <input type="number" inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value)}
            className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-xl text-center font-bold" /></label>
        <div className="flex gap-2">
          {[['cash', '💵 Cash'], ['account', '🏦 Account']].map(([v, t]) => (
            <button key={v} onClick={() => setMode(v)} className={`flex-1 rounded-xl py-2 font-semibold ${mode === v ? 'bg-slate-800 text-white' : 'border-2 border-slate-200 text-slate-600'}`}>{t}</button>
          ))}
        </div>
        {Math.round(left) !== 0 && (
          <p className={`text-xs font-medium ${left > 0 ? 'text-rose-600' : 'text-amber-700'}`}>
            {left > 0 ? `${rupee(Math.round(left))} stays owed to him — it carries into his next hisab.` : `He takes ${rupee(Math.round(-left))} extra — it is cut from his next hisab.`}
          </p>
        )}
        <div className="flex gap-2">
          <button disabled={busy} onClick={onClose} className="flex-1 border-2 border-slate-200 rounded-xl py-3 font-semibold text-slate-600">Cancel</button>
          <button disabled={busy} onClick={go} className="flex-[2] bg-emerald-600 text-white rounded-xl py-3 font-bold disabled:opacity-50">{busy ? 'Saving…' : `Clear till ${fmt(till)}`}</button>
        </div>
      </div>
    </div>
  );
}

// Owner 29-09-2026: "add advance to loader and unloader". A normal dated advance on the loader — the
// card counts it under "cash given since" and the next ✅ Clear subtracts it (no double counting).
function AdvanceSheet({ loaders, user, viaQueue = false, onClose, onDone }) {
  const [code, setCode] = useState('');
  const [date, setDate] = useState(todayIST());
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => 'adv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));   // retry-safe
  async function go() {
    const amt = Math.round(Number(amount) || 0);
    if (!code) { alert('Pick the loader.'); return; }
    if (amt <= 0) { alert('Enter the amount.'); return; }
    if (!date || date > todayIST()) { alert('Pick the date the cash was given (not a future date).'); return; }
    setBusy(true);
    try {
      const adv = { id, date, mode, amount: amt, remark: remark.trim() || 'Loading advance', paidBy: user.email };
      // manager cannot write att_salary (owner-only rule) → the cloud worker applies it (same as Advances page)
      if (viaQueue) await queueAdvance(code, adv, user.email);
      else await addAdvanceDirect(code, adv, user.email);
      await onDone({ ...adv, name: (loaders.find((e) => e.code === code) || {}).name || code });
    } catch (e) {
      alert(/^LOCKED/.test(String(e?.message || '')) ? 'That month is already paid & locked — advance not saved.' : 'Could not save — check the internet and tap Save again (it will not double).');
      setBusy(false);
    }
  }
  return (
    <Sheet title="💸 Advance to loader" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {loaders.map((e) => (
          <button key={e.code} onClick={() => setCode(e.code)}
            className={`rounded-xl py-3 px-2 text-sm font-semibold ${code === e.code ? 'bg-slate-800 text-white' : 'border-2 border-slate-200 text-slate-700'}`}>{e.name}</button>
        ))}
      </div>
      <label className="block text-sm text-slate-600">Date given
        <input type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" /></label>
      <label className="block text-sm text-slate-600">Amount ₹
        <input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-xl text-center font-bold" /></label>
      <ModeButtons mode={mode} setMode={setMode} />
      <label className="block text-sm text-slate-600">Note (optional)
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" /></label>
      <SaveRow busy={busy} onClose={onClose} onSave={go} label="Save advance" />
    </Sheet>
  );
}

// Owner 29-09-2026: "pay to abc staff for particular day". Casual come-and-go loaders are paid under the
// one MAN-LOADING-ABC record: this records that day's cash AND closes that day in one step, so nothing
// stays open. Uses only its own advance id — other open cash on the record is left untouched.
function CasualDaySheet({ emp, user, onClose, onDone }) {
  const wage = Number(emp.wage) || 700;
  const [date, setDate] = useState(todayIST());
  const [name, setName] = useState('');
  const [days, setDays] = useState('1');
  const [amount, setAmount] = useState(String(wage));
  const [mode, setMode] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [ids] = useState(() => { const s = Date.now() + '-' + Math.random().toString(36).slice(2, 7); return { adv: 'adv-' + s, clear: 'clr-' + s }; });
  useEffect(() => { setAmount(String(Math.round((Number(days) || 0) * wage))); }, [days, wage]);
  async function go() {
    const amt = Math.round(Number(amount) || 0), d = Number(days) || 0;
    if (!name.trim()) { alert('Write the person\'s name.'); return; }
    if (d <= 0) { alert('Enter the days worked (1 for one day, 0.5 for half).'); return; }
    if (amt <= 0) { alert('Enter the amount paid.'); return; }
    if (!date || date > todayIST()) { alert('Pick the day he worked (not a future date).'); return; }
    const who = name.trim();
    setBusy(true);
    try {
      await addAdvanceDirect(emp.code, { id: ids.adv, date, mode, amount: amt, remark: `Casual ${who} · ${d} din ${fmt(date)}`, paidBy: user.email }, user.email);
      const earned = r2(d * wage);
      await addHisabClear(emp.code, {
        id: ids.clear, from: date, till: date, hours: r2(d * stdHoursOf(emp)), machineHours: 0, earned, casualDays: d, casualName: who,
        carryIn: 0, paid: amt, cashNow: amt, mode, carry: 0, advIds: [ids.adv], payKeys: [], dayPay: true,
        by: user.email, at: new Date().toISOString(),
      });
      await onDone();
    } catch (e) {
      alert(/^LOCKED/.test(String(e?.message || '')) ? 'That month is already paid & locked — not saved.' : 'Could not save — check the internet and tap Save again (it will not double).');
      setBusy(false);
    }
  }
  return (
    <Sheet title="👷 Pay casual loader for a day" onClose={onClose}>
      <label className="block text-sm text-slate-600">Name
        <input type="text" value={name} placeholder="e.g. Kamran" onChange={(e) => setName(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" /></label>
      <label className="block text-sm text-slate-600">Day worked
        <input type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm text-slate-600">Days (₹{wage}/day)
          <input type="number" inputMode="decimal" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-xl text-center font-bold" /></label>
        <label className="block text-sm text-slate-600">Paid ₹
          <input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-xl text-center font-bold" /></label>
      </div>
      <ModeButtons mode={mode} setMode={setMode} />
      <SaveRow busy={busy} onClose={onClose} onSave={go} label="Save & clear day" />
    </Sheet>
  );
}

function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-end sm:items-center justify-center p-2" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md p-4 space-y-3 max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-bold text-lg text-slate-900">{title}</div>
        {children}
      </div>
    </div>
  );
}
function ModeButtons({ mode, setMode }) {
  return (
    <div className="flex gap-2">
      {[['cash', '💵 Cash'], ['account', '🏦 Account']].map(([v, t]) => (
        <button key={v} onClick={() => setMode(v)} className={`flex-1 rounded-xl py-2 font-semibold ${mode === v ? 'bg-slate-800 text-white' : 'border-2 border-slate-200 text-slate-600'}`}>{t}</button>
      ))}
    </div>
  );
}
function SaveRow({ busy, onClose, onSave, label }) {
  return (
    <div className="flex gap-2">
      <button disabled={busy} onClick={onClose} className="flex-1 border-2 border-slate-200 rounded-xl py-3 font-semibold text-slate-600">Cancel</button>
      <button disabled={busy} onClick={onSave} className="flex-[2] bg-emerald-600 text-white rounded-xl py-3 font-bold disabled:opacity-50">{busy ? 'Saving…' : label}</button>
    </div>
  );
}
