import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllPunches, addAdvanceDirect, addHisabClear, removeHisabClear } from '../lib/data';
import { rupee } from '../lib/paycalc';
import { isLoader, openHisab, punchesSyncedTill, lastPunchDate, addDays, todayIST, dinGhante, r2 } from '../lib/loadingHisab';

// 🚚 LOADING HISAB — owner-only (feature 'salary'). Owner 13-09-2026: "I pay them once in a while, and
// I cannot remember from which day until which date I have cleared their old account."
// One card per loader: CLEARED TILL date → hours worked since (from the machine) → earned → cash
// given since → balance. "✅ Clear" stores the date on the worker (hisabClears[]) and records any cash
// paid now as a normal dated advance, so the Salary tab sees the same money. It never locks a month,
// never writes a payment and never changes payable.
const fmt = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : '—');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (ymd) => DOW[new Date(ymd + 'T00:00:00').getDay()];

export default function LoadingHisab({ user }) {
  const [emps, setEmps] = useState(null);
  const [punches, setPunches] = useState({});
  const [err, setErr] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [clearing, setClearing] = useState(null);   // code being cleared

  async function reload() {
    try {
      const [list, pu] = await Promise.all([loadEmployees(true), loadAllPunches()]);
      setEmps(list); setPunches(pu); setErr('');
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
          per day like Anshul's slip, 10 h = 1 day), cash given since, and what is due now. Owner-only.
        </p>
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

      <button onClick={shareSlip} className="w-full bg-green-600 text-white rounded-2xl py-3 font-bold active:scale-95 transition-all">📤 Share slip on WhatsApp</button>

      {!rows.length && <p className="text-sm text-slate-400 text-center py-4">No loading staff found.</p>}
      {rows.map(({ emp, h }) => (
        <LoaderCard key={emp.code} emp={emp} h={h} open={openCode === emp.code}
          onToggle={() => setOpenCode(openCode === emp.code ? '' : emp.code)}
          onClear={() => setClearing(emp.code)}
          onUndo={async (entry) => {
            if (!window.confirm(`Undo the clearance till ${fmt(entry.till)} for ${emp.name}?\n\nThe cash entry made with it (${rupee(entry.cashNow || 0)}) is NOT removed — delete it from his Salary page if it was wrong.`)) return;
            try { await removeHisabClear(emp.code, entry); await reload(); } catch { alert('Could not undo — try again.'); }
          }} />
      ))}

      {clearing && (() => {
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

function LoaderCard({ emp, h, open, onToggle, onClear, onUndo }) {
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
                  <span className="text-slate-600">{fmt(c.date)} · {c.mode}{c.remark ? <span className="text-slate-400"> · {c.remark}</span> : ''}</span>
                  <b>{rupee(c.amount)}</b>
                </div>
              ))}
            </div>
          )}

          <button onClick={onClear} className="w-full bg-emerald-600 text-white rounded-xl py-3 text-base font-bold active:scale-95 transition-all">✅ Clear hisab</button>

          {h.clears.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">Past clearances</div>
              {h.clears.slice().reverse().map((c, i) => (
                <div key={c.id} className="flex items-center justify-between gap-2 border-t border-slate-100 py-1">
                  <span className="text-slate-600">
                    till <b>{fmt(c.till)}</b>{c.seed ? <span className="text-slate-400"> · opening</span>
                      : <span className="text-slate-400"> · {c.hours}h · earned {rupee(c.earned)} · paid {rupee(c.paid)}{c.carry ? ` · left ${rupee(c.carry)}` : ''}</span>}
                  </span>
                  {i === 0 && !c.seed && <button onClick={() => onUndo(c)} className="text-[11px] text-slate-500 underline shrink-0">Undo</button>}
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
  const h = useMemo(() => openHisab(emp, punchDoc, till), [emp, punchDoc, till]);
  const casual = !!emp.appOnly;
  const extraHours = casual ? r2((Number(casualDays) || 0) * h.std) : 0;
  const earned = r2(h.earned + (casual ? (Number(casualDays) || 0) * h.wage : 0));
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
        id: ids.clear, from: h.from, till, hours: r2(h.hours + extraHours), earned,
        ...(casual ? { casualDays: Number(casualDays) || 0 } : {}),
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
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm bg-slate-50 rounded-lg p-2">
          <span className="text-slate-500">{fmt(h.from)} → {fmt(till)}</span><span className="text-right">{casual ? `${casualDays || 0} din` : `${h.hours}h = ${dinGhante(h.hours, h.std)}`}</span>
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
