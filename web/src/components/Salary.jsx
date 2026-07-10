import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, saveEmployee, loadPayout, queueMarkPaid, queueAdvance, loadRoster, approveSalary, unapproveSalary, holdSalary, releaseSalary, ensureApprovalBackup, istMonth, queueJob, queueFinalizeHisab, checkActionPassword } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee } from '../lib/paycalc';
import Person from './Person.jsx';
import SelfPunchCard from './SelfPunchCard.jsx';
import NamePick from './NamePick.jsx';
import { payslipAllPdf, sharePdf, advanceSplit } from '../lib/salaryPdf';

// SALARY — owner ticks person by person; manager sees ticked list and marks PAID.
export default function Salary({ user }) {
  return user.role === 'admin' ? <OwnerSalary user={user} /> : <ManagerSalary user={user} />;
}

/* ---------------- owner view ---------------- */
function OwnerSalary({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [q, setQ] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState('');
  const [payC, setPayC] = useState(null);   // owner pay&settle dialog: { r, mode, amount, remark }
  const [showRemoved, setShowRemoved] = useState(false);   // include resigned/removed (kept for costing)
  const ctx = useMemo(() => monthCtx(mk), [mk]);

  async function reload() {
    const [list, am] = await Promise.all([loadEmployees(showRemoved), loadAllAttendance()]);
    setEmps(list); setAttMap(am);
  }
  useEffect(() => { reload(); }, [showRemoved]);

  if (openCode) return <Person code={openCode} mk={mk} user={user} onBack={() => { setOpenCode(''); reload(); }} />;
  if (emps === null) return <p className="text-gray-500">Loading…</p>;

  const rows = emps.filter((e) => e.amount || e.wage).map((e) => ({ emp: e, ...payFor(e, attMap, mk, ctx) }));
  const ticked = rows.filter((r) => r.md.approved);
  const paid = ticked.filter((r) => r.md.payment);
  const held = rows.filter((r) => r.md.hold);
  const visible = rows.filter((r) => !q || (r.emp.name || '').toLowerCase().includes(q.toLowerCase()));
  const noSalary = emps.filter((e) => !(e.amount || e.wage));
  // month payroll totals (approved figure once ticked, else the live computed net)
  const totalNet = rows.reduce((s, r) => s + Number((r.md.approved ? r.md.approvedNet : r.pay.net) || 0), 0);
  const paidNet = paid.reduce((s, r) => s + Number(r.md.payment?.net || 0), 0);
  const pendingNet = Math.max(0, totalNet - paidNet);

  async function tick(r) {
    setBusy(r.emp.code);
    try {
      if (r.md.approved) await unapproveSalary(r.emp.code, mk);
      else { await ensureApprovalBackup(mk, user.email); await approveSalary(r.emp.code, mk, r.pay, user.email); }
      await reload();
    } finally { setBusy(''); }
  }

  async function hold(r) {
    const reason = prompt(`Hold ${r.emp.name}'s salary for ${mk}.\nReason (required):`);
    if (!reason || !reason.trim()) return;
    setBusy(r.emp.code);
    try { await holdSalary(r.emp.code, mk, reason.trim(), user.email); await reload(); }
    finally { setBusy(''); }
  }
  async function release(r) {
    setBusy(r.emp.code);
    try { await releaseSalary(r.emp.code, mk, user.email); await reload(); }
    finally { setBusy(''); }
  }
  // owner pays & settles a ticked month (any month, incl. previous).
  async function doPay(r, mode, remark, amount) {
    setBusy(r.emp.code);
    try { await queueMarkPaid(r.emp.code, mk, mode, user.email, remark, amount); setPayC(null); await reload(); }
    finally { setBusy(''); }
  }
  // owner finalizes the whole month's hisab: locks ticked staff + carries each one's leftover
  // advance forward (advance carries ONLY now). Admin-password gated.
  async function finalizeHisab() {
    if (!ticked.length) { alert('Tick (approve) people first — only ticked staff are finalized.'); return; }
    if (!confirm(`Finalize the ${mk} hisab?\n\nThis LOCKS the ${ticked.length} ticked people for ${mk} and carries each one's leftover advance forward to next month. (Advances carry forward only now.)`)) return;
    const pw = prompt('Admin password to finalize & lock:');
    if (pw == null) return;
    const ok = await checkActionPassword(pw);
    if (ok === 'unset') { if (!confirm('No action password set (set one in ⚙ Settings). Finalize anyway?')) return; }
    else if (!ok) { alert('Wrong password.'); return; }
    setBusy('hisab');
    try { await queueFinalizeHisab(mk, user.email); alert('Hisab finalize queued — locks the month + carries advances in a moment.'); await reload(); }
    finally { setBusy(''); }
  }

  async function tickAll() {
    const remaining = rows.filter((r) => !r.md.approved && !r.md.hold && r.pay.net > 0);
    if (!remaining.length) return;
    if (!confirm(`Tick all remaining ${remaining.length} people for ${mk}? (held salaries are skipped)`)) return;
    setBusy('all');
    try {
      await ensureApprovalBackup(mk, user.email);
      for (const r of remaining) await approveSalary(r.emp.code, mk, r.pay, user.email);
      await reload();
    } finally { setBusy(''); }
  }

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-xl shadow p-3 space-y-2">
        <div className="flex gap-2">
          <select className="flex-1 border rounded-lg px-3 py-2 bg-white font-medium" value={mk} onChange={(e) => setMk(e.target.value)}>
            {monthOptions().map((m) => <option key={m.mk} value={m.mk}>{m.label}{m.mk === istMonth() ? ' (running)' : ''}</option>)}
          </select>
          <button onClick={() => setShowReport(true)} className="border border-gray-300 rounded-lg px-3 text-sm font-medium">📄 Report</button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-sm text-gray-600">
            <b className="text-gray-800">{ticked.length}</b> of {rows.length} ticked · <b className="text-green-700">{paid.length}</b> paid ({rupee(paid.reduce((s, r) => s + Number(r.md.payment?.net || 0), 0))}){held.length > 0 ? <> · <b className="text-red-600">{held.length}</b> hold</> : null}
          </div>
          {rows.some((r) => !r.md.approved && !r.md.hold && r.pay.net > 0) && (
            <button disabled={busy === 'all'} onClick={tickAll} className="text-xs border border-red-300 text-red-700 rounded-lg px-2.5 py-1.5 font-medium disabled:opacity-50">
              {busy === 'all' ? 'Ticking…' : `✓ Tick all (${rows.filter((r) => !r.md.approved && !r.md.hold && r.pay.net > 0).length})`}
            </button>
          )}
        </div>
        <div className="flex items-baseline justify-between border-t border-gray-100 pt-2">
          <span className="text-sm text-gray-600">Total payroll{ctx.fullMonth ? '' : ' (so far)'}</span>
          <span className="text-xl font-bold text-red-700">{rupee(totalNet)}</span>
        </div>
        <div className="flex gap-4 text-xs text-gray-500 -mt-1">
          <span>Paid <b className="text-green-700">{rupee(paidNet)}</b></span>
          <span>Pending <b className="text-red-600">{rupee(pendingNet)}</b></span>
          <span>{rows.length} staff</span>
        </div>
        {!ctx.fullMonth && <p className="text-xs text-gray-400">Running month — figures till yesterday.</p>}
        <label className="flex items-center gap-1.5 text-xs text-gray-500"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed/resigned staff (kept in the sheet for costing)</label>
        {(() => {
          const closed = rows.filter((r) => r.md.payment).length;
          return <p className="text-[11px] text-gray-500">🔒 Each worker's hisab closes when you <b>pay</b> him — his leftover advance carries to next month automatically. No month-end step needed.{closed > 0 ? ` (${closed} of ${rows.length} closed)` : ''}</p>;
        })()}
      </div>

      <input className="w-full border rounded-lg px-3 py-2" placeholder="🔍 Search name…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="bg-white rounded-xl shadow divide-y divide-gray-100">
        {visible.length === 0 && <p className="p-4 text-sm text-gray-400">No one matches.</p>}
        {visible.map((r) => <OwnerRow key={r.emp.code} r={r} busy={busy === r.emp.code} onName={() => setOpenCode(r.emp.code)} onTick={() => tick(r)} onHold={() => hold(r)} onRelease={() => release(r)} onPay={() => setPayC({ r, mode: 'cash', amount: String(r.md.approvedNet ?? r.pay.net), remark: '' })} />)}
      </div>

      <AdvanceCard user={user} />
      {mk === istMonth() && <SelfPunchCard />}
      {noSalary.length > 0 && <NoSalaryList list={noSalary} onSaved={reload} />}
      {showReport && <ReportModal user={user} mk={mk} rows={rows} onClose={() => setShowReport(false)} />}

      {payC && (() => { const due = Number(payC.r.md.approvedNet ?? payC.r.pay.net) || 0; const amt = Number(payC.amount) || 0; return (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={() => busy ? null : setPayC(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-3xl mb-1">💵</div>
              <p className="font-bold text-gray-800 text-lg">{payC.r.emp.name || payC.r.emp.code}</p>
              <p className="text-xs text-gray-500">Pay &amp; settle · Net due <b className="text-red-700">{rupee(due)}</b> · {monthOptions().find((m) => m.mk === mk)?.label || mk}</p>
            </div>
            <label className="block text-xs text-gray-500">Amount paid ₹
              <input type="number" value={payC.amount} onChange={(e) => setPayC({ ...payC, amount: e.target.value })}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-lg font-bold text-gray-800" />
            </label>
            {amt > due && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">Paying {rupee(amt - due)} extra → recorded as an <b>advance carried forward</b> to next month.</p>}
            <div className="grid grid-cols-2 gap-2">
              {['cash', 'bank'].map((m) => (
                <button key={m} onClick={() => setPayC({ ...payC, mode: m })} className={`rounded-lg py-2 text-sm font-medium border ${payC.mode === m ? 'bg-gray-800 text-white border-gray-800' : 'border-gray-300 text-gray-600'}`}>{m === 'cash' ? '💵 Cash' : '🏦 Bank'}</button>
              ))}
            </div>
            <input value={payC.remark} onChange={(e) => setPayC({ ...payC, remark: e.target.value })} placeholder="Remark (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button disabled={!!busy} onClick={() => setPayC(null)} className="flex-1 border rounded-xl py-3 font-medium text-gray-600 disabled:opacity-50">Cancel</button>
              <button disabled={!!busy || !(amt >= 0)} onClick={() => doPay(payC.r, payC.mode, payC.remark.trim(), amt)}
                className="flex-1 bg-green-700 text-white rounded-xl py-3 font-semibold disabled:opacity-50">{busy ? 'Paying…' : `Pay ${rupee(amt)}`}</button>
            </div>
          </div>
        </div>
      ); })()}
    </div>
  );
}

function OwnerRow({ r, busy, onName, onTick, onHold, onRelease, onPay }) {
  const { emp, md, pay } = r;
  const [showDays, setShowDays] = useState(false);
  const isPaid = !!md.payment, isTicked = !!md.approved, isHeld = !!md.hold;
  const sub2 = [
    pay.otHrsNet > 0 ? `OT ${pay.otHrsNet}h` : null,
    pay.advanceRecovered > 0 ? `adv −${rupee(pay.advanceRecovered)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className={`p-3 ${isHeld ? 'bg-red-50' : ''}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <button onClick={onName} className="text-left block">
            <span className="font-medium text-gray-800">{emp.name || emp.code}{emp.nickname ? <span className="text-gray-400 font-normal"> ({emp.nickname})</span> : null}</span>
          </button>
          <div className="text-xs text-gray-500">
            <button onClick={() => setShowDays((s) => !s)} className="text-blue-700 underline decoration-dotted underline-offset-2">{pay.paidDays}d paid {showDays ? '▾' : '▸'}</button>
            {sub2 ? ` · ${sub2}` : ''}
          </div>
          {showDays && <DaysBreakdown pay={pay} />}
        </div>
        <div className="text-right">
          <div className="font-bold text-red-700">{rupee(isPaid ? md.payment.net : (isTicked ? md.approvedNet : pay.net))}</div>
          {isHeld ? <button disabled={busy} onClick={onRelease} className="text-[11px] text-red-600 underline">🚫 hold · release</button>
            : isPaid ? <span className="text-[11px] text-green-700 font-medium">✓ PAID ({md.payment.mode})</span>
            : isTicked ? <div className="flex gap-1 justify-end items-center">
                <button disabled={busy} onClick={onPay} className="text-xs bg-green-700 text-white rounded-lg px-3 py-1.5 font-medium disabled:opacity-50">💵 Pay</button>
                <button disabled={busy} onClick={onTick} className="text-[11px] text-amber-700 underline">undo</button>
              </div>
            : <div className="flex gap-1 justify-end">
                <button disabled={busy} onClick={onTick} className="text-xs bg-red-700 text-white rounded-lg px-3 py-1.5 font-medium disabled:opacity-50">✓ Tick</button>
                <button disabled={busy} onClick={onHold} title="Hold salary" className="text-xs border border-gray-300 text-gray-500 rounded-lg px-2 py-1.5 disabled:opacity-50">🚫</button>
              </div>}
        </div>
      </div>
      {isHeld && <div className="text-[11px] text-red-700 mt-1">🚫 Hold: {md.hold.reason}</div>}
    </div>
  );
}

// Tap "paid days" to see what makes it up — straight from the Realtime sheet:
//  • monthly: Present + Paid Saturday (ALL Saturdays — salaried) + Holiday. Worked Saturdays
//    are in OT (their own line), not an extra day.
//  • daily: only present working days; Saturdays/holidays unpaid (working one → OT).
function DaysBreakdown({ pay }) {
  const daily = pay.type === 'daily';
  const lines = [
    ['Present', pay.presentDays, true],
    [daily ? 'Saturday' : 'Paid Saturday', pay.weeklyOffAll, !daily],
    ['Holiday', pay.holiday, !daily],
  ];
  return (
    <div className="mt-1 bg-gray-50 rounded-lg p-2 text-[11px] text-gray-600 space-y-0.5">
      {lines.map(([label, val, paid]) => (
        <div key={label} className="flex justify-between">
          <span>{label}</span>
          <span className={paid ? 'text-gray-800 font-medium' : 'text-gray-400'}>{val || 0}d{paid ? '' : ' · unpaid'}</span>
        </div>
      ))}
      {pay.absentDays > 0 && <div className="flex justify-between"><span>Absent</span><span className="text-red-500">−{pay.absentDays}d</span></div>}
      {!daily && pay.saturdaysCut > 0 && <div className="flex justify-between"><span>Saturdays cut (low attendance)</span><span className="text-red-500">{pay.saturdaysCut} of {pay.saturdaysInPeriod}</span></div>}
      <div className="flex justify-between border-t border-gray-200 pt-0.5 mt-0.5 font-semibold text-gray-800"><span>Paid days</span><span>{pay.paidDays}d</span></div>
      {pay.otHrsNet > 0 && <div className="flex justify-between text-blue-700"><span>Overtime{pay.weeklyOffPresent > 0 ? ` (incl. ${pay.weeklyOffPresent} Sat worked)` : ''}</span><span>{pay.otHrsNet}h</span></div>}
      <div className="text-gray-400 pt-0.5 leading-snug">
        {daily
          ? 'Daily wage: only worked days are paid. Saturdays & holidays are unpaid — working one earns OT, not a paid day.'
          : pay.saturdaysCut > 0
            ? `A Saturday is paid only when that week's attendance earns it. ${pay.saturdaysCut} of ${pay.saturdaysInPeriod} Saturday${pay.saturdaysInPeriod > 1 ? 's' : ''} were cut for low attendance. Working a Saturday earns overtime on top — not an extra day.`
            : 'Saturdays are paid when the week\'s attendance earns them. Working a Saturday earns overtime on top — not an extra day.'}
      </div>
    </div>
  );
}

/* ---------------- manager view ---------------- */
function ManagerSalary({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [payout, setPayout] = useState(null);
  const [done, setDone] = useState({});       // optimistic: code -> mode
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null); // { item, mode, remark } before paying

  useEffect(() => { setPayout(null); loadPayout(mk).then(setPayout); }, [mk]);
  if (payout === null) return <p className="text-gray-500">Loading…</p>;

  const items = Object.entries(payout.items || {}).map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const pending = items.filter((i) => !i.paid && !done[i.code]);

  async function pay(i, mode, remark, amount) {
    setBusy(i.code);
    try { await queueMarkPaid(i.code, mk, mode, user.email, remark, amount); setDone({ ...done, [i.code]: mode }); setConfirm(null); }
    finally { setBusy(''); }
  }

  return (
    <div className="space-y-3">
      <select className="w-full border rounded-lg px-3 py-2 bg-white font-medium" value={mk} onChange={(e) => setMk(e.target.value)}>
        {monthOptions(3).map((m) => <option key={m.mk} value={m.mk}>{m.label}</option>)}
      </select>
      <p className="text-sm text-gray-600">{pending.length} left to pay · {items.length - pending.length} done</p>
      <div className="bg-white rounded-xl shadow divide-y divide-gray-100">
        {items.length === 0 && <p className="p-4 text-sm text-gray-400">Nothing approved for this month yet.</p>}
        {items.map((i) => {
          const paidMode = i.paid?.mode || done[i.code];
          return (
            <div key={i.code} className="flex items-center p-3 gap-2">
              <div className="flex-1">
                <div className="font-medium text-gray-800">{i.name}{i.nickname ? <span className="text-gray-400 font-normal"> ({i.nickname})</span> : null}</div>
                <div className="text-xs text-gray-500">{i.dept}</div>
              </div>
              <div className="font-bold text-red-700 mr-1">{rupee(i.net)}</div>
              {paidMode ? <span className="text-xs text-green-700 font-medium">✓ {paidMode}</span> : (
                <div className="flex gap-1">
                  <button disabled={busy === i.code} onClick={() => setConfirm({ item: i, mode: 'cash', remark: '', amount: String(i.net) })} className="bg-green-700 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">💵 Cash</button>
                  <button disabled={busy === i.code} onClick={() => setConfirm({ item: i, mode: 'bank', remark: '', amount: String(i.net) })} className="bg-gray-800 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">🏦 Bank</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <AdvanceCard user={user} />
      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={() => busy ? null : setConfirm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-3xl mb-1">{confirm.mode === 'cash' ? '💵' : '🏦'}</div>
              <p className="text-gray-600 text-sm">Pay salary by {confirm.mode === 'cash' ? 'Cash' : 'Bank'}?</p>
              <p className="font-bold text-gray-800 text-lg mt-1">{confirm.item.name}</p>
              <p className="text-xs text-gray-500">Net due: <b className="text-red-700">{rupee(confirm.item.net)}</b> · {monthOptions(3).find((m) => m.mk === mk)?.label || mk}</p>
            </div>
            <label className="block text-xs text-gray-500">Amount paid ₹
              <input type="number" value={confirm.amount} onChange={(e) => setConfirm({ ...confirm, amount: e.target.value })}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-lg font-bold text-gray-800" />
            </label>
            {Number(confirm.amount) > confirm.item.net && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                Paying {rupee(Number(confirm.amount) - confirm.item.net)} extra → recorded as an <b>advance carried forward</b> to next month.
              </p>
            )}
            <input value={confirm.remark} onChange={(e) => setConfirm({ ...confirm, remark: e.target.value })} placeholder="Remark (optional)"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button disabled={!!busy} onClick={() => setConfirm(null)} className="flex-1 border rounded-xl py-3 font-medium text-gray-600 disabled:opacity-50">Cancel</button>
              <button disabled={!!busy || !(Number(confirm.amount) >= 0)} onClick={() => pay(confirm.item, confirm.mode, confirm.remark.trim(), Number(confirm.amount))}
                className="flex-1 bg-green-700 text-white rounded-xl py-3 font-semibold disabled:opacity-50">{busy ? 'Paying…' : `Pay ${rupee(Number(confirm.amount) || 0)}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// quick advance entry (manager + owner): date, amount, mode, remark; blocked once that
// month's salary is already paid for the person.
export function AdvanceCard({ user }) {
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const [roster, setRoster] = useState([]);
  const [f, setF] = useState({ code: null, name: '', amount: '', mode: 'cash', date: today, remark: '' });
  const [st, setSt] = useState('');
  useEffect(() => { loadRoster().then(setRoster); }, []);
  async function go() {
    if (!f.code) { setSt('Pick a person (type the name).'); return; }
    if (!Number(f.amount) || !f.date) { setSt('Fill date and amount.'); return; }
    setSt('saving');
    try {
      const po = await loadPayout(f.date.slice(0, 7));
      if (po.items?.[f.code]?.paid) { setSt(`Salary for ${f.date.slice(0, 7)} is already PAID — advance not allowed for that month.`); return; }
      await queueAdvance(f.code, { date: f.date, mode: f.mode, amount: Number(f.amount), remark: f.remark || '', paidBy: user.email }, user.email);
      setSt('done'); setF({ code: null, name: '', amount: '', mode: 'cash', date: today, remark: '' });
    } catch (e) { setSt('Could not save — try again.'); }
  }
  return (
    <div className="bg-white rounded-xl shadow p-3 space-y-2">
      <div className="font-semibold text-gray-800 text-sm">💸 Give advance</div>
      <div className="grid grid-cols-2 gap-2">
        <NamePick roster={roster} value={f.name} onChange={(code, name) => setF({ ...f, code, name })} className="col-span-2" />
        <input className="border rounded px-2 py-2 text-sm" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input className="border rounded px-2 py-2 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <select className="border rounded px-2 py-2 text-sm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
          <option value="cash">Cash</option><option value="account">Bank</option>
        </select>
        <input className="border rounded px-2 py-2 text-sm" placeholder="Remark (optional)" value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
        <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-red-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Record advance</button>
      </div>
      {f.name && !f.code && <p className="text-xs text-amber-700">Keep typing — more than one name matches.</p>}
      {st === 'done' && <p className="text-xs text-green-700">✓ Recorded — owner gets a Telegram alert.</p>}
      {st && !['saving', 'done'].includes(st) && <p className="text-xs text-red-600">{st}</p>}
    </div>
  );
}

/* ---------------- report modal ---------------- */
const REPORTS = [
  { v: 'perfbtn', label: 'Performance Report' },
  { v: 'Button10', label: 'Monthly Summary (Excel)' },
  { v: 'Button15', label: 'Daily In-Out times' },
  { v: 'Button6', label: 'Missed Punches' },
  { v: 'Button8', label: 'OT Summary' },
  { v: 'Button13', label: 'Late Arrival' },
  { v: 'Button4', label: 'Absent Report' },
];
function ReportModal({ user, mk, rows, onClose }) {
  const [f, setF] = useState({ report: 'perfbtn', month: 0, code: null, name: '' });
  const [roster, setRoster] = useState([]);
  const [st, setSt] = useState('');
  useEffect(() => { loadRoster().then(setRoster); }, []);
  async function send() {
    setSt('sending');
    const payload = { month: Number(f.month), report: f.report, scope: f.code ? 'emp' : 'all', value: f.code || '' };
    try { await queueJob('monthly_download', payload, user.email); setSt('sent'); }
    catch { setSt('error'); }
  }
  // salary register PDF, built on the phone → share sheet (WhatsApp / anywhere)
  async function register() {
    const list = (rows || []).map((r) => ({
      name: r.emp.name || r.emp.code, days: r.pay.presentDays, ot: r.pay.otHrsNet,
      advBank: advanceSplit(r.advs).bank, advCash: advanceSplit(r.advs).cash,
      net: r.md.payment ? r.md.payment.net : (r.md.approved ? r.md.approvedNet : r.pay.net),
      carried: r.pay.advanceBalanceCarried,
    }));
    await sharePdf(payslipAllPdf(list, mk), `salary-register-${mk}.pdf`);
  }
  return (
    <div className="fixed inset-0 bg-black/40 z-20 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-gray-800">📄 Reports</div>
        <select className="w-full border rounded px-3 py-2" value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })}>
          {REPORTS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <select className="w-full border rounded px-3 py-2" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>
          {monthOptions(3).map((m, i) => <option key={m.mk} value={i}>{m.label}</option>)}
        </select>
        <NamePick roster={roster} value={f.name} onChange={(code, name) => setF({ ...f, code, name })}
          placeholder="Type a name… (empty = everyone)" className="w-full" />
        {f.name && !f.code && <p className="text-xs text-amber-700">Keep typing — more than one name matches.</p>}
        {st === 'sent' ? <p className="text-sm text-green-700">✓ On its way to Telegram (1–2 min). Forward it to WhatsApp from there.</p> : (
          <button onClick={send} disabled={st === 'sending'} className="w-full bg-red-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">✈️ Send to Telegram</button>
        )}
        <button onClick={register} className="w-full border border-green-300 text-green-700 rounded-lg py-2.5 font-medium">🟢 Salary register PDF — share / WhatsApp</button>
        {st === 'error' && <p className="text-xs text-red-600">Failed — try again.</p>}
      </div>
    </div>
  );
}

/* ---------------- people without salary ---------------- */
function NoSalaryList({ list, onSaved }) {
  const [show, setShow] = useState(false);
  const [vals, setVals] = useState({});
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-600">
        No salary set ({list.length}) {show ? '▲' : '▼'} <span className="font-normal text-xs text-gray-400">— piece-rate welders can stay empty</span>
      </button>
      {show && (
        <ul className="mt-2 divide-y divide-gray-100">
          {list.map((e) => {
            const v = vals[e.code] || { amount: '', type: 'monthly' };
            return (
              <li key={e.code} className="py-2 flex items-center gap-2 text-sm">
                <span className="flex-1">{e.name || e.code} <span className="text-gray-400 text-xs">{e.dept || ''}</span></span>
                <select className="border rounded px-1 py-1 text-xs" value={v.type} onChange={(ev) => setVals({ ...vals, [e.code]: { ...v, type: ev.target.value } })}>
                  <option value="monthly">₹/mo</option><option value="daily">₹/day</option>
                </select>
                <input className="border rounded px-2 py-1 w-20 text-xs" type="number" placeholder="amount" value={v.amount} onChange={(ev) => setVals({ ...vals, [e.code]: { ...v, amount: ev.target.value } })} />
                <button disabled={!Number(v.amount)} onClick={async () => { await saveEmployee(e.code, v.type === 'daily' ? { type: 'daily', wage: Number(v.amount) } : { type: 'monthly', amount: Number(v.amount) }); onSaved(); }}
                  className="text-xs bg-gray-800 text-white rounded px-2 py-1 disabled:opacity-40">Set</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
