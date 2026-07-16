import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, loadAllPunches, loadEmployee, setOtSource, saveEmployee, loadPayout, queueMarkPaid, queueAdvance, loadRoster, approveSalary, unapproveSalary, holdSalary, releaseSalary, ensureApprovalBackup, istMonth, queueJob, queueFinalizeHisab, checkActionPassword, lockMonthDirect, unlockMonthDirect, queueLock, queueUnlock, addManualWorker } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee, paymentBreakdown } from '../lib/paycalc';
import Person from './Person.jsx';
import SelfPunchCard from './SelfPunchCard.jsx';
import NamePick from './NamePick.jsx';
import { payslipAllPdf, lockedRegisterPdf, sharePdf, advanceSplit } from '../lib/salaryPdf';
import { shareCheckSheet } from '../lib/checksheet';
import WorkerSummary from './WorkerSummary.jsx';

// SALARY — owner ticks person by person; manager sees ticked list and marks PAID.
export default function Salary({ user }) {
  return user.role === 'admin' ? <OwnerSalary user={user} /> : <ManagerSalary user={user} />;
}

/* ---------------- owner view ---------------- */
function OwnerSalary({ user }) {
  // remember the month the owner is working on (don't snap back to the current month on every visit)
  const [mk, setMkState] = useState(() => { try { return localStorage.getItem('nsp_salary_mk') || istMonth(); } catch { return istMonth(); } });
  const setMk = (m) => { setMkState(m); try { localStorage.setItem('nsp_salary_mk', m); } catch { /* ignore */ } };
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [punches, setPunches] = useState({});
  const [q, setQ] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState('');
  const [payC, setPayC] = useState(null);   // owner pay&settle dialog: { r, mode, amount, remark }
  const [justPaid, setJustPaid] = useState({});   // code -> mode, paid THIS session (shows ✓ + Undo)
  const [showRemoved, setShowRemoved] = useState(false);   // include resigned/removed (kept for costing)
  const [pending, setPending] = useState({});   // code -> paidSoFar-before-tap; a payment is queued (5-min worker)
  const ctx = useMemo(() => monthCtx(mk), [mk]);
  // manual/off-machine workers — passed to the advance card so they can be picked for advances
  const manualPeople = useMemo(() => (emps || []).filter((e) => e.manual || e.appOnly).map((e) => ({ code: e.code, name: e.name || e.code, dept: e.dept || '' })), [emps]);

  async function reload() {
    const [list, am, pu] = await Promise.all([loadEmployees(showRemoved), loadAllAttendance(), loadAllPunches()]);
    setEmps(list); setAttMap(am); setPunches(pu);
  }
  useEffect(() => { reload(); }, [showRemoved]);
  useEffect(() => { setPending({}); }, [mk]);   // queued markers are per selected month
  // clear a "queued" marker once the worker has applied it (fully paid, or paidSoFar advanced)
  useEffect(() => {
    if (!emps) return;
    setPending((prev) => {
      const next = { ...prev }; let changed = false;
      for (const code of Object.keys(prev)) {
        const md = (emps.find((x) => x.code === code)?.months || {})[mk] || {};
        if (md.payment || Number(md.paidSoFar || 0) > prev[code]) { delete next[code]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [emps, mk]);

  if (openCode) return <Person code={openCode} mk={mk} user={user} onBack={() => { setOpenCode(''); reload(); }} />;
  if (emps === null) return <p className="text-gray-500">Loading…</p>;

  const rows = emps.filter((e) => e.amount || e.wage).map((e) => ({ emp: e, ...payFor(e, attMap, mk, ctx, 0, punches[e.code]) }));
  const locked = rows.filter((r) => r.md.locked || r.md.payment);   // settled via Lock
  const brokenFix = rows.filter((r) => (r.lateFixed || 0) > 0.25);   // workers auto-corrected for broken-punch fake "late"
  const visible = rows.filter((r) => !q || (r.emp.name || '').toLowerCase().includes(q.toLowerCase()));
  const noSalary = emps.filter((e) => !(e.amount || e.wage));
  // month payroll totals: payable for the unsettled, actual paid for the locked
  const totalPayable = rows.reduce((s, r) => s + Number((r.md.locked || r.md.payment) ? (r.md.payment?.net || 0) : (r.pay.payable || 0)), 0);
  const paidNet = locked.reduce((s, r) => s + Number(r.md.payment?.net || 0), 0);
  const pendingNet = rows.filter((r) => !(r.md.locked || r.md.payment)).reduce((s, r) => s + Number(r.pay.payable || 0), 0);

  async function tick(r) {
    setBusy(r.emp.code);
    try {
      if (r.md.approved) await unapproveSalary(r.emp.code, mk);
      else { await ensureApprovalBackup(mk, user.email); await approveSalary(r.emp.code, mk, r.pay, user.email); }
      await reload();
    } finally { setBusy(''); }
  }

  // owner picks which OT to pay (portal vs app-computed) — locks in when the row is ticked/paid
  async function chooseOt(r, source) {
    setBusy(r.emp.code);
    try { await setOtSource(r.emp.code, mk, source); await reload(); }
    finally { setBusy(''); }
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
  // owner pays & settles a ticked month (any month, incl. previous). Supports PART payments.
  async function doPay(r, mode, remark, amount) {
    setBusy(r.emp.code);
    const prevPaid = Number(r.md.paidSoFar || 0);
    try {
      await queueMarkPaid(r.emp.code, mk, mode, user.email, remark, amount);
      setPending((p) => ({ ...p, [r.emp.code]: prevPaid }));   // ⏳ until the worker applies it
      setPayC(null); await reload();
    } finally { setBusy(''); }
  }
  // Settle & lock a month. Supports a SPLIT payment (part cash + part account together) and an
  // optional owner-granted BONUS DAY (+1 day's pay) ticked right in the pay sheet. Nothing is
  // auto-applied — the owner sets cash, account, and the bonus tick before locking.
  async function doFastLock(r, cash, account, bonusDay) {
    const code = r.emp.code;
    setBusy(code);
    try {
      const pay = r.pay;
      const perDay = Number(pay.perDay || 0);
      const bonusAdd = bonusDay ? perDay : 0;
      const cashN = Number(cash) || 0;
      const acctN = Number(account) || 0;
      const payable = Math.round(((pay.payable || 0) + bonusAdd) * 100) / 100;
      // bonus day is baked into THIS payment's snapshot only (payable + breakdown), never into the
      // stored month — so an Undo returns the worker to clean pay with no lingering bonus.
      const breakdown = bonusDay
        ? { ...paymentBreakdown(pay), bonus: Math.round(((pay.bonus || 0) + perDay) * 100) / 100, net: Math.round(((pay.net || 0) + perDay) * 100) / 100 }
        : paymentBreakdown(pay);
      const args = { cash: cashN, account: acctN, payable, advanceCarry: pay.advanceBalanceCarried, reason: `Salary ${mk}${bonusDay ? ' +bonus day' : ''}` };
      await lockMonthDirect(code, mk, { ...args, breakdown }, user.email);   // instant freeze + carry
      queueLock(code, mk, args, user.email).catch(() => {});                 // register + Telegram
      // FAST: update ONLY this worker (1 read) instead of reloading the whole roster.
      setPayC(null);
      setJustPaid((p) => ({ ...p, [code]: cashN > 0 && acctN > 0 ? 'split' : (acctN > 0 ? 'account' : 'cash') }));
      const fresh = await loadEmployee(code).catch(() => null);
      if (fresh) setEmps((prev) => prev.map((e) => (e.code === code ? fresh : e)));
    } finally { setBusy(''); }
  }
  // Tap a row's Cash/Account → open the pay sheet PRE-FILLED with the full payable in that method
  // (owner can then split part to the other method, edit amounts, or tick a bonus day).
  const payNow = (r, mode) => {
    const full = String(Math.max(0, r.pay.payable || 0));
    setPayC({ r, cash: mode === 'account' ? '0' : full, account: mode === 'account' ? full : '0', bonusDay: false });
  };
  // Undo a just-paid worker (mis-tap): instant unlock + refresh just that row.
  async function undoPay(r) {
    const code = r.emp.code;
    setBusy(code);
    try {
      await unlockMonthDirect(code, mk, 'undo', user.email);
      queueUnlock(code, mk, 'undo', user.email).catch(() => {});   // cancel the queued lock_month so the robot can't re-lock it
      setJustPaid((p) => { const n = { ...p }; delete n[code]; return n; });
      const fresh = await loadEmployee(code).catch(() => null);
      if (fresh) setEmps((prev) => prev.map((e) => (e.code === code ? fresh : e)));
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
        <button onClick={() => shareCheckSheet(rows, mk)} className="w-full bg-blue-600 text-white rounded-lg py-2.5 text-sm font-semibold">📋 Days &amp; OT check-sheet → WhatsApp <span className="font-normal opacity-90">(staff verify before pay)</span></button>
        <div className="pt-1">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-bold text-gray-800">{locked.length} of {rows.length} paid</span>
            <span className="text-sm text-gray-500">{Math.max(0, rows.length - locked.length)} left</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
            <div className="h-full bg-green-600 rounded-full transition-all" style={{ width: `${rows.length ? Math.round((locked.length / rows.length) * 100) : 0}%` }} />
          </div>
          <div className="flex gap-4 text-xs text-gray-500 mt-1.5">
            <span>Paid <b className="text-green-700">{rupee(paidNet)}</b></span>
            <span>Pending <b className="text-red-600">{rupee(pendingNet)}</b></span>
            <span>Total {rupee(totalPayable)}{ctx.fullMonth ? '' : ' so far'}</span>
          </div>
        </div>
        {!ctx.fullMonth && <p className="text-xs text-gray-400">Running month — figures till yesterday.</p>}
        {brokenFix.length > 0 && (
          <p className="text-xs bg-amber-50 text-amber-800 rounded-lg px-2 py-1.5">
            ⚠ <b>{brokenFix.length}</b> worker{brokenFix.length > 1 ? 's' : ''} had a <b>broken-punch day</b> this month — the app auto-restored their overtime (machine missed a punch, portal wrongly cut OT). Tagged <b>“punch-fixed”</b> below; open each to see the day.
          </p>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-500"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed/resigned staff (kept in the sheet for costing)</label>
        <p className="text-[11px] text-gray-500">Tap 💵 Cash or 🏦 Account → a box opens: split across <b>Cash + Account</b>, tick <b>🎯 Bonus day</b> on top if giving one, then <b>Pay &amp; lock</b> (Undo if you mis-tap). Tap the <b>name</b> for OT / details. <span className="text-gray-400">(pay v4)</span></p>
      </div>

      <input className="w-full border rounded-lg px-3 py-2" placeholder="🔍 Search name…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="bg-white rounded-xl shadow divide-y divide-gray-100">
        {visible.length === 0 && <p className="p-4 text-sm text-gray-400">No one matches.</p>}
        {visible.map((r) => (
          <OwnerRow key={r.emp.code} r={r} mk={mk} busy={busy === r.emp.code} queued={pending[r.emp.code] != null}
            justPaidMode={justPaid[r.emp.code]}
            onName={() => setOpenCode(r.emp.code)}
            onPay={(mode) => payNow(r, mode)}
            onUndo={() => undoPay(r)} />
        ))}
      </div>

      <AdvanceCard user={user} extra={manualPeople} />
      <AddWorkerCard user={user} onAdded={reload} />
      {mk === istMonth() && <SelfPunchCard />}
      {noSalary.length > 0 && <NoSalaryList list={noSalary} onSaved={reload} />}
      {showReport && <ReportModal user={user} mk={mk} rows={rows} onClose={() => setShowReport(false)} />}
      {payC && <FastPaySheet payC={payC} mk={mk} busy={!!busy} onChange={setPayC} onCancel={() => setPayC(null)} onConfirm={doFastLock} />}
    </div>
  );
}

// Settle & lock sheet. Owner can SPLIT one payment across Cash + Account (both fields at once) and
// tick a BONUS DAY (+1 day's pay) on top. Amount fields are front-and-centre, above the Pay button.
function FastPaySheet({ payC, busy, onChange, onCancel, onConfirm }) {
  const { r, cash, account, bonusDay } = payC;
  const pay = r.pay;
  const perDay = Number(pay.perDay || 0);
  const basePayable = pay.payable || 0;
  const effPayable = Math.round((basePayable + (bonusDay ? perDay : 0)) * 100) / 100;   // payable incl. bonus day
  const owes = effPayable < 0;
  const cashN = Number(cash) || 0;
  const acctN = Number(account) || 0;
  const total = Math.round((cashN + acctN) * 100) / 100;
  const closing = Math.round((effPayable - total) * 100) / 100;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={() => busy ? null : onCancel()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-center">
          <p className="font-bold text-gray-900 text-xl">{r.emp.name || r.emp.code}</p>
          <p className="text-xs text-gray-500 mt-0.5">Payable {rupee(Math.abs(effPayable))}{owes ? ' — he owes us' : ''}{bonusDay ? ` · incl. +${rupee(perDay)} bonus` : ''}</p>
        </div>

        {/* BONUS DAY — tick on top; adds one day's pay and bumps the cash field to cover it */}
        {perDay > 0 && (
          <label className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 cursor-pointer">
            <span className="text-sm font-semibold text-amber-900">🎯 Bonus day <span className="font-normal text-amber-700">+{rupee(perDay)} (1 day)</span></span>
            <input type="checkbox" className="w-6 h-6 accent-amber-600" checked={!!bonusDay} disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                const bump = on ? perDay : -perDay;
                onChange({ ...payC, bonusDay: on, cash: String(Math.max(0, Math.round(((Number(cash) || 0) + bump) * 100) / 100)) });
              }} />
          </label>
        )}

        {/* SPLIT — Cash + Account, both editable at once */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-semibold text-gray-600 text-center">💵 Cash ₹
            <input type="number" inputMode="numeric" autoFocus value={cash} onChange={(e) => onChange({ ...payC, cash: e.target.value })} onFocus={(e) => e.target.select()}
              className="mt-1 w-full border-2 border-green-600 rounded-lg px-2 py-2.5 text-2xl font-bold text-gray-900 text-center focus:outline-none focus:ring-2 focus:ring-green-400" />
          </label>
          <label className="block text-xs font-semibold text-gray-600 text-center">🏦 Account ₹
            <input type="number" inputMode="numeric" value={account} onChange={(e) => onChange({ ...payC, account: e.target.value })} onFocus={(e) => e.target.select()}
              className="mt-1 w-full border-2 border-gray-700 rounded-lg px-2 py-2.5 text-2xl font-bold text-gray-900 text-center focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </label>
        </div>

        <p className="text-xs text-center text-gray-600">
          Paying now <b className="text-gray-900">{rupee(total)}</b> · Balance <b className={closing >= 0 ? 'text-red-700' : 'text-green-700'}>{closing >= 0 ? '+' : ''}{rupee(closing)}</b> {closing >= 0 ? 'stays owed to him' : 'he owes us'} → carries next month.
        </p>

        <button disabled={busy} onClick={() => onConfirm(r, cashN, acctN, !!bonusDay)}
          className="w-full bg-green-700 text-white rounded-xl py-4 text-base font-bold disabled:opacity-50 active:scale-95 transition">
          {busy ? 'Paying…' : `Pay ${rupee(total)} & lock`}
        </button>
        <button disabled={busy} onClick={onCancel} className="w-full text-sm text-gray-500 py-1 disabled:opacity-50">Cancel</button>
      </div>
    </div>
  );
}

function OwnerRow({ r, mk, busy, queued, justPaidMode, onName, onPay, onUndo }) {
  const { emp, md, pay } = r;
  const [showDays, setShowDays] = useState(false);
  const isLocked = !!md.locked || !!md.payment;                  // settled & frozen via Lock
  const payable = pay.payable || 0;
  const owes = payable < 0;
  const sub2 = [
    pay.otHrsNet > 0 ? `OT ${pay.otHrsNet}h` : null,
    (pay.openingBalance || 0) !== 0 ? `bal ${pay.openingBalance > 0 ? '+' : ''}${rupee(pay.openingBalance)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className={`p-3 ${justPaidMode ? 'bg-green-50' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <button onClick={onName} className="text-left block">
            <span className="font-semibold text-gray-900 text-[15px]">{emp.name || emp.code}{emp.nickname ? <span className="text-gray-400 font-normal"> ({emp.nickname})</span> : null}</span>
            {(r.lateFixed || 0) > 0.25 && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 align-middle">⚠ punch-fixed +{r.lateFixed}h OT</span>}
            {r.hasOverride && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 align-middle">✍️ manual days/OT</span>}
            {r.emp.manual && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 rounded px-1 py-0.5 align-middle">manual worker</span>}
          </button>
          <div className="text-xs text-gray-500">
            <button onClick={() => setShowDays((s) => !s)} className="text-blue-700 underline decoration-dotted underline-offset-2">{pay.paidDays}d · details {showDays ? '▾' : '▸'}</button>
            {sub2 ? ` · ${sub2}` : ''}
          </div>
          {showDays && <WorkerSummary r={r} mk={mk} />}
        </div>
        <div className="text-right shrink-0">
          <div className={`font-bold text-lg ${owes && !isLocked ? 'text-green-700' : 'text-red-700'}`}>
            {isLocked ? rupee(md.payment?.net || 0) : owes ? `owes ${rupee(Math.abs(payable))}` : rupee(payable)}
          </div>
          {isLocked && !justPaidMode && <span className="text-[11px] text-green-700 font-medium">🔒 Locked{md.payment?.closing ? ` · bal ${md.payment.closing >= 0 ? '+' : ''}${rupee(md.payment.closing)}` : ''}</span>}
          {queued && !isLocked && <span className="text-[11px] text-amber-600 font-medium">⏳ saving…</span>}
        </div>
      </div>
      {/* just paid this session → ✓ confirmation + one-tap Undo for a mis-tap */}
      {justPaidMode && (
        <div className="flex items-center justify-between mt-2 text-sm">
          <span className="text-green-700 font-semibold">✓ Paid {justPaidMode === 'split' ? '💵+🏦 split' : justPaidMode === 'account' ? '🏦 account' : '💵 cash'}{md.payment?.closing ? ` · bal ${md.payment.closing >= 0 ? '+' : ''}${rupee(md.payment.closing)}` : ''}</span>
          <button disabled={busy} onClick={onUndo} className="text-gray-500 underline underline-offset-2 px-2 py-1 disabled:opacity-50">Undo</button>
        </div>
      )}
      {/* not settled → ONE-TAP pay (full amount, that method, locks instantly) */}
      {!isLocked && !queued && (
        <div className="flex gap-2 mt-2.5">
          {owes ? (
            <button disabled={busy} onClick={() => onPay('cash')} className="flex-1 bg-gray-800 text-white rounded-xl py-3 font-semibold text-sm disabled:opacity-50">Settle &amp; lock <span className="font-normal opacity-80">(carries {rupee(Math.abs(payable))})</span></button>
          ) : (
            <>
              <button disabled={busy} onClick={() => onPay('cash')} className="flex-1 bg-green-700 text-white rounded-xl py-3 font-bold text-base disabled:opacity-50 active:scale-95 transition">💵 Cash</button>
              <button disabled={busy} onClick={() => onPay('account')} className="flex-1 bg-gray-800 text-white rounded-xl py-3 font-bold text-base disabled:opacity-50 active:scale-95 transition">🏦 Account</button>
            </>
          )}
        </div>
      )}
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
          const remaining = Math.max(0, Number(i.net) - Number(i.paidSoFar || 0));
          const isPartial = !i.paid && Number(i.paidSoFar || 0) > 0;
          return (
            <div key={i.code} className="flex items-center p-3 gap-2">
              <div className="flex-1">
                <div className="font-medium text-gray-800">{i.name}{i.nickname ? <span className="text-gray-400 font-normal"> ({i.nickname})</span> : null}</div>
                <div className="text-xs text-gray-500">{i.dept}{isPartial ? <span className="text-blue-700"> · {rupee(Number(i.paidSoFar))} paid, {rupee(remaining)} left</span> : null}</div>
              </div>
              <div className="font-bold text-red-700 mr-1">{rupee(isPartial ? remaining : i.net)}</div>
              {paidMode ? <span className="text-xs text-green-700 font-medium">✓ {paidMode}</span> : (
                <div className="flex gap-1">
                  <button disabled={busy === i.code} onClick={() => setConfirm({ item: i, mode: 'cash', remark: '', amount: String(remaining) })} className="bg-green-700 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">💵 Cash</button>
                  <button disabled={busy === i.code} onClick={() => setConfirm({ item: i, mode: 'bank', remark: '', amount: String(remaining) })} className="bg-gray-800 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">🏦 Bank</button>
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
              {(() => { const rem = Math.max(0, Number(confirm.item.net) - Number(confirm.item.paidSoFar || 0)); return (
                <p className="text-xs text-gray-500">{Number(confirm.item.paidSoFar || 0) > 0 ? <>{rupee(Number(confirm.item.paidSoFar))} paid · </> : null}Due: <b className="text-red-700">{rupee(rem)}</b> · {monthOptions(3).find((m) => m.mk === mk)?.label || mk}</p>
              ); })()}
            </div>
            <label className="block text-xs text-gray-500">Amount paid now ₹
              <input type="number" value={confirm.amount} onChange={(e) => setConfirm({ ...confirm, amount: e.target.value })}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-lg font-bold text-gray-800" />
            </label>
            {(() => { const rem = Math.max(0, Number(confirm.item.net) - Number(confirm.item.paidSoFar || 0)); const amt = Number(confirm.amount) || 0; return (<>
              {amt > 0 && amt < rem - 0.5 && <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-2">Part payment — <b>{rupee(rem - amt)}</b> stays pending. Hisab stays open until fully paid.</p>}
              {amt > rem + 0.5 && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">Paying {rupee(amt - rem)} extra → recorded as an <b>advance carried forward</b> to next month.</p>}
            </>); })()}
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
export function AdvanceCard({ user, extra = [] }) {
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const [roster, setRoster] = useState([]);
  const [f, setF] = useState({ code: null, name: '', amount: '', mode: 'cash', date: today, remark: '' });
  const [st, setSt] = useState('');
  useEffect(() => { loadRoster().then(setRoster); }, []);
  // include manual/off-machine workers (Radhey/Dinesh) — they aren't in the machine roster
  const pickList = useMemo(() => {
    const codes = new Set(roster.map((e) => e.code));
    return [...roster, ...extra.filter((e) => e && e.code && !codes.has(e.code))];
  }, [roster, extra]);
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
        <NamePick roster={pickList} value={f.name} onChange={(code, name) => setF({ ...f, code, name })} className="col-span-2" />
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

// Add a MANUAL worker (not on the biometric machine — e.g. Radhey, Dinesh). Owner then fills their
// days/OT each month via the person page override, and pays them like anyone else.
function AddWorkerCard({ user, onAdded }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', dept: '', type: 'monthly', amount: '', standardHours: '8.5' });
  const [st, setSt] = useState('');
  async function go() {
    if (!f.name.trim()) { setSt('Enter a name.'); return; }
    if (!Number(f.amount)) { setSt(f.type === 'daily' ? 'Enter the ₹/day.' : 'Enter the ₹/month.'); return; }
    setSt('saving');
    try {
      await addManualWorker({ name: f.name, dept: f.dept, type: f.type, amount: Number(f.amount), standardHours: Number(f.standardHours) || 8.5 }, user.email);
      setSt('done'); setF({ name: '', dept: '', type: 'monthly', amount: '', standardHours: '8.5' });
      onAdded && onAdded();
    } catch { setSt('Could not save — try again.'); }
  }
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left font-semibold text-gray-800 text-sm">➕ Add a manual worker <span className="font-normal text-xs text-gray-400">— not on the machine (Radhey, Dinesh…)</span> {open ? '▲' : '▼'}</button>
      {open && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input className="border rounded px-2 py-2 text-sm col-span-2" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="border rounded px-2 py-2 text-sm" placeholder="Department (optional)" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })} />
          <select className="border rounded px-2 py-2 text-sm" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="monthly">₹ / month</option><option value="daily">₹ / day</option>
          </select>
          <input className="border rounded px-2 py-2 text-sm" type="number" inputMode="numeric" placeholder={f.type === 'daily' ? 'Wage ₹/day' : 'Salary ₹/month'} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <input className="border rounded px-2 py-2 text-sm" type="number" inputMode="decimal" placeholder="Shift hours (8.5)" value={f.standardHours} onChange={(e) => setF({ ...f, standardHours: e.target.value })} />
          <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-gray-800 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Add worker</button>
          <p className="col-span-2 text-[11px] text-gray-500">After adding, open the worker and use <b>✍️ Override days / OT</b> each month to set their days & overtime, then pay them from the Salary list.</p>
        </div>
      )}
      {st === 'done' && <p className="text-xs text-green-700 mt-1">✓ Added — find them in the list above and set this month's days/OT.</p>}
      {st && !['saving', 'done'].includes(st) && <p className="text-xs text-red-600 mt-1">{st}</p>}
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
  // LOCKED-month salary + payments: only workers whose salary is locked, with days/OT/advance/
  // payable/net/cash/account/carried — a full record of what was paid for the month, till now.
  async function lockedReg() {
    const locked = (rows || []).filter((r) => r.md.payment || r.md.locked);
    if (!locked.length) { setSt('nolock'); return; }
    const list = locked.map((r) => {
      const p = r.md.payment || {};
      const adv = advanceSplit(r.advs);
      return {
        name: r.emp.name || r.emp.code,
        salary: r.emp.type === 'daily' ? Number(r.emp.wage || 0) : Number(r.emp.amount || 0),   // current rate
        days: r.pay.paidDays,          // same paid-days figure shown in the list (not the lower present-days)
        ot: r.pay.otHrsNet,
        advance: adv.bank + adv.cash,
        payable: p.payable ?? r.pay.payable,
        net: p.breakdown?.net ?? p.net ?? r.pay.net,
        cash: p.cash || 0,
        account: p.account || 0,
        carried: p.closing ?? r.pay.advanceBalanceCarried,
      };
    });
    await sharePdf(lockedRegisterPdf(list, mk), `salary-locked-${mk}.pdf`);
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
        <button onClick={lockedReg} className="w-full border border-gray-800 text-gray-800 rounded-lg py-2.5 font-medium">🔒 Locked salary + payments PDF <span className="font-normal text-xs text-gray-500">(days·OT·adv·payable·net·cash·account·carry)</span></button>
        {st === 'nolock' && <p className="text-xs text-amber-700">No salary is locked yet for {monthOptions(3).find((m) => m.mk === mk)?.label || mk}. Lock/pay some workers first.</p>}
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
