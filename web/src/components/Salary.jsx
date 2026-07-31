import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, loadAllPunches, loadEmployee, saveEmployee, loadPayout, loadAdvanceBalances, queueAdvance, addAdvanceDirect, loadRoster, istMonth, queueJob, lockMonthDirect, unlockMonthDirect, queueLock, queueUnlock, addManualWorker, pushWorkerProfile, MACHINE_DEPTS, MACHINE_SHIFTS, MACHINE_GENDERS, DEPT_DEFAULT_SHIFT } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee, paymentBreakdown } from '../lib/paycalc';
import Person from './Person.jsx';
import SelfPunchCard from './SelfPunchCard.jsx';
import NamePick from './NamePick.jsx';
import { payslipAllPdf, lockedRegisterPdf, sharePdf, advanceSplit, advancesPdf } from '../lib/salaryPdf';
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
  const [filter, setFilter] = useState('all');       // all | topay | paid — chips above the list
  const [showMoney, setShowMoney] = useState(false); // 💸 total box tapped open → cash/account detail
  const ctx = useMemo(() => monthCtx(mk), [mk]);
  // manual/off-machine workers — passed to the advance card so they can be picked for advances
  const manualPeople = useMemo(() => (emps || []).filter((e) => e.manual || e.appOnly).map((e) => ({ code: e.code, name: e.name || e.code, dept: e.dept || '' })), [emps]);

  async function reload() {
    const [list, am, pu] = await Promise.all([loadEmployees(showRemoved), loadAllAttendance(), loadAllPunches()]);
    setEmps(list); setAttMap(am); setPunches(pu);
  }
  useEffect(() => { reload(); }, [showRemoved]);
  // instant reflection when an owner records an advance (optimistic — the write persists in background)
  const onAdvanceSaved = (code, adv) => setEmps((prev) => (prev || []).map((e) => e.code === code ? { ...e, advances: [...(e.advances || []), adv] } : e));
  // undo the optimistic add if the background write is rejected (e.g. the month turned out to be locked)
  const onAdvanceRevert = (code, advId) => setEmps((prev) => (prev || []).map((e) => e.code === code ? { ...e, advances: (e.advances || []).filter((a) => a.id !== advId) } : e));

  if (openCode) return <Person code={openCode} mk={mk} user={user} onBack={() => { setOpenCode(''); reload(); }} />;
  if (emps === null) return <p className="text-gray-500">Loading…</p>;

  const rows = emps.filter((e) => e.amount || e.wage).map((e) => ({ emp: e, ...payFor(e, attMap, mk, ctx, 0, punches[e.code]) }));
  const locked = rows.filter((r) => r.md.locked || r.md.payment);   // settled via Lock
  const brokenFix = rows.filter((r) => (r.lateFixed || 0) > 0.25);   // workers auto-corrected for broken-punch fake "late"
  const isSettled = (r) => !!(r.md.locked || r.md.payment);
  // just-paid rows stay visible on EVERY filter (fix 2026-07-18): on "🔴 To pay" a worker used to
  // vanish the instant he was paid, hiding the ✓/Undo — a mis-tap couldn't be undone from there.
  const visible = rows.filter((r) => !q || (r.emp.name || '').toLowerCase().includes(q.toLowerCase()))
    .filter((r) => justPaid[r.emp.code] ? true : filter === 'all' ? true : filter === 'paid' ? isSettled(r) : !isSettled(r));
  const noSalary = emps.filter((e) => !(e.amount || e.wage));
  // month payroll totals: payable for the unsettled, actual paid for the locked
  const totalPayable = rows.reduce((s, r) => s + Number((r.md.locked || r.md.payment) ? (r.md.payment?.net || 0) : (r.pay.payable || 0)), 0);
  const paidNet = locked.reduce((s, r) => s + Number(r.md.payment?.net || 0), 0);
  const pendingNet = rows.filter((r) => !(r.md.locked || r.md.payment)).reduce((s, r) => s + Number(r.pay.payable || 0), 0);
  // Total money GIVEN OUT this month = advances handed out during the month (ALL people, even
  // no-salary ones — an advance is cash out regardless) + salary actually paid (locked payment
  // net = cash+account at lock; part payments via paidSoFar for months not locked yet).
  const advEntries = emps.flatMap((e) => (e.advances || []).filter((a) => (a.date || '').startsWith(mk)));
  const advancesOut = advEntries.reduce((t, a) => t + Number(a.amount || 0), 0);
  const advCash = advEntries.filter((a) => a.mode !== 'account').reduce((t, a) => t + Number(a.amount || 0), 0);
  const salaryOut = rows.reduce((s, r) => s + Number(r.md.payment ? (r.md.payment.net || 0) : (r.md.paidSoFar || 0)), 0);
  const salCash = rows.reduce((s, r) => s + Number(r.md.payment?.cash || 0), 0);
  const salAcct = rows.reduce((s, r) => s + Number(r.md.payment?.account || 0), 0);
  const moneyOut = Math.round((advancesOut + salaryOut) * 100) / 100;

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
      const res = await lockMonthDirect(code, mk, { ...args, breakdown }, user.email);   // instant freeze + carry
      // A later month is already paid — its opening balance is baked into its frozen payment, so
      // locking this one would desync the chain. Skip the queue too (the robot would redo it).
      if (res?.nextLocked) { alert(`Cannot lock ${mk} — ${res.nextLocked} is already paid & locked.\n\nReopen ${res.nextLocked} first, then lock ${mk}.`); return; }
      queueLock(code, mk, { ...args, breakdown }, user.email).catch(() => {});   // register + Telegram (snapshot rides along)
      // FAST: update ONLY this worker (1 read) instead of reloading the whole roster.
      setPayC(null);
      setJustPaid((p) => ({ ...p, [code]: cashN + acctN <= 0 ? 'settled' : cashN > 0 && acctN > 0 ? 'split' : (acctN > 0 ? 'account' : 'cash') }));
      const fresh = await loadEmployee(code).catch(() => null);
      if (fresh) setEmps((prev) => prev.map((e) => (e.code === code ? fresh : e)));
    } finally { setBusy(''); }
  }
  // Tap a row's Cash/Account → open the pay sheet PRE-FILLED with the full payable in that method
  // (owner can then split part to the other method, edit amounts, or tick a bonus day).
  // OWNER RULE (2026-07-17): full attendance = +1 day's pay → 🎯 comes PRE-TICKED for eligible
  // workers (full month, zero absent), amount included in the prefill; owner unticks to refuse.
  // Skipped when the bonus is already in payable via md.perfectBonusPaid (would double it).
  const payNow = (r, mode) => {
    const bonus = !!r.pay.perfectEligible && !(r.pay.perfectBonus > 0) && (r.pay.perDay || 0) > 0;
    const full = String(Math.max(0, Math.round(((r.pay.payable || 0) + (bonus ? r.pay.perDay : 0)) * 100) / 100));
    setPayC({ r, cash: mode === 'account' ? '0' : full, account: mode === 'account' ? full : '0', bonusDay: bonus });
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
  // month navigator (visual only): monthOptions() is newest-first, so ◀ older = index+1
  const mos = monthOptions();
  const mi = mos.findIndex((m) => m.mk === mk);
  const allPaid = rows.length > 0 && locked.length === rows.length;
  return (
    <div className="space-y-3 pb-6">
      {/* month navigator — big ◀ ▶ taps, month itself is still a dropdown for far jumps */}
      <div className="flex items-center justify-between bg-white rounded-2xl border-2 border-slate-200 p-2">
        <button onClick={() => mi >= 0 && mi < mos.length - 1 && setMk(mos[mi + 1].mk)} disabled={!(mi >= 0 && mi < mos.length - 1)}
          className={`w-12 h-12 rounded-xl text-2xl font-bold ${mi >= 0 && mi < mos.length - 1 ? 'bg-slate-100 active:bg-slate-200' : 'bg-slate-50 text-slate-300'}`}>◀</button>
        <div className="text-center">
          <select className="appearance-none bg-transparent text-center font-bold text-slate-800 text-base focus:outline-none" value={mk} onChange={(e) => setMk(e.target.value)}>
            {mos.map((m) => <option key={m.mk} value={m.mk}>{m.label}{m.mk === istMonth() ? ' (running)' : ''}</option>)}
          </select>
          {!ctx.fullMonth && <div className="text-[11px] text-slate-400">running month — figures till yesterday</div>}
        </div>
        <button onClick={() => mi > 0 && setMk(mos[mi - 1].mk)} disabled={mi <= 0}
          className={`w-12 h-12 rounded-xl text-2xl font-bold ${mi > 0 ? 'bg-slate-100 active:bg-slate-200' : 'bg-slate-50 text-slate-300'}`}>▶</button>
      </div>

      {/* hero — the one pay-day number: what is LEFT to pay */}
      <div className={`rounded-2xl shadow-sm p-5 text-center ${allPaid ? 'bg-emerald-50' : 'bg-rose-50'}`}>
        {allPaid ? (
          <>
            <div className="text-xs text-slate-500 font-semibold">EVERYONE PAID 🎉</div>
            <div className="text-4xl font-extrabold mt-1 text-emerald-700">{rupee(paidNet)}</div>
            <div className="text-[11px] text-slate-500 mt-1">{locked.length} workers · full month settled</div>
          </>
        ) : (
          <>
            <div className="text-xs text-slate-500 font-semibold">LEFT TO PAY — {Math.max(0, rows.length - locked.length)} worker{rows.length - locked.length === 1 ? '' : 's'}</div>
            <div className="text-4xl font-extrabold mt-1 text-rose-600">{rupee(pendingNet)}</div>
          </>
        )}
        <div className="h-2.5 bg-white/70 rounded-full mt-3 overflow-hidden">
          <div className="h-full bg-emerald-600 rounded-full transition-all" style={{ width: `${rows.length ? Math.round((locked.length / rows.length) * 100) : 0}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-slate-500 mt-1.5">
          <span>{locked.length} of {rows.length} paid · <b className="text-emerald-700">{rupee(paidNet)}</b></span>
          <span>Total {rupee(totalPayable)}{ctx.fullMonth ? '' : ' so far'}</span>
        </div>
      </div>

      {/* 💸 total money OUT this month (tap for cash/account split) */}
      <button onClick={() => setShowMoney((s) => !s)} className="w-full text-left bg-white rounded-2xl border-2 border-slate-200 p-3 active:bg-slate-50">
        <div className="flex justify-between items-baseline">
          <span className="text-sm font-bold text-slate-700">💸 Total given this month</span>
          <span className="font-extrabold text-slate-900">{rupee(moneyOut)}</span>
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">advances {rupee(advancesOut)} + salary paid {rupee(salaryOut)} <span className="float-right">{showMoney ? '▲' : '▼'}</span></div>
        {showMoney && (
          <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600 space-y-1">
            <div className="flex justify-between"><span>💵 Cash out <span className="text-slate-400">(salary {rupee(salCash)} + adv {rupee(advCash)})</span></span><b className="text-slate-800">{rupee(salCash + advCash)}</b></div>
            <div className="flex justify-between"><span>🏦 Account out <span className="text-slate-400">(salary {rupee(salAcct)} + adv {rupee(advancesOut - advCash)})</span></span><b className="text-slate-800">{rupee(salAcct + (advancesOut - advCash))}</b></div>
            <div className="text-slate-500">📝 {advEntries.length} advance{advEntries.length === 1 ? '' : 's'} given · {locked.length} salar{locked.length === 1 ? 'y' : 'ies'} paid &amp; locked</div>
          </div>
        )}
      </button>

      {/* actions */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => shareCheckSheet(rows, mk)} className="bg-blue-600 text-white rounded-2xl py-4 font-bold shadow-lg shadow-blue-300 active:bg-blue-700 active:scale-95 transition-all">📋 Check-sheet<div className="text-[11px] font-normal opacity-90">days &amp; OT → WhatsApp</div></button>
        <button onClick={() => setShowReport(true)} className="bg-white text-slate-600 border-2 border-slate-200 rounded-2xl py-4 font-bold active:bg-slate-50 active:scale-95 transition-all">📄 Reports<div className="text-[11px] font-normal text-slate-400">register · locked PDF</div></button>
      </div>

      {brokenFix.length > 0 && (
        <p className="text-xs bg-amber-50 border-2 border-amber-200 text-amber-800 rounded-2xl px-3 py-2">
          ⚠ <b>{brokenFix.length}</b> worker{brokenFix.length > 1 ? 's' : ''} had a <b>broken-punch day</b> this month — the app auto-restored their overtime (machine missed a punch, portal wrongly cut OT). Tagged <b>“punch-fixed”</b> below; open each to see the day.
        </p>
      )}

      {/* filter chips — one tap to see only who is LEFT to pay (the main pay-day question) */}
      <div className="flex gap-2">
        {[
          ['all', `All (${rows.length})`],
          ['topay', `🔴 To pay (${Math.max(0, rows.length - locked.length)})`],
          ['paid', `✅ Paid (${locked.length})`],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`flex-1 rounded-2xl py-3 text-sm font-bold transition ${filter === key ? 'bg-emerald-600 text-white shadow' : 'bg-white text-slate-600 border-2 border-slate-200'}`}>
            {label}
          </button>
        ))}
      </div>

      <input className="w-full bg-white border-2 border-slate-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-slate-400" placeholder="🔍 Search name…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="space-y-2">
        {visible.length === 0 && (
          <p className="bg-white rounded-2xl border-2 border-slate-200 p-4 text-sm text-slate-400 text-center">
            {filter === 'topay' && rows.length - locked.length === 0 && !q ? '🎉 Everyone is paid for this month!' : 'No one matches.'}
          </p>
        )}
        {visible.map((r) => (
          <OwnerRow key={r.emp.code} r={r} mk={mk} busy={busy === r.emp.code} user={user}
            justPaidMode={justPaid[r.emp.code]}
            onName={() => setOpenCode(r.emp.code)}
            onPay={(mode) => payNow(r, mode)}
            onAdvanceSaved={onAdvanceSaved}
            onAdvanceRevert={onAdvanceRevert}
            onUndo={() => undoPay(r)} />
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-500 px-1"><input type="checkbox" className="w-5 h-5 accent-slate-700" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed/resigned staff (kept in the sheet for costing)</label>
      <p className="text-[11px] text-slate-500 px-1">Tap 💵 Cash or 🏦 Account → a box opens: split across <b>Cash + Account</b>, tick <b>🎯 Bonus day</b> on top if giving one, then <b>Pay &amp; lock</b> (Undo if you mis-tap). Tap the <b>name</b> for OT / details. <span className="text-slate-400">(pay v5)</span></p>

      <AdvanceCard user={user} extra={manualPeople} onSaved={onAdvanceSaved} />
      <AdvancesExportCard emps={emps} />
      <DeclareWorkerCard user={user} emps={emps} onSaved={reload} />
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
          <p className="font-bold text-slate-900 text-xl">{r.emp.name || r.emp.code}</p>
          <p className="text-xs text-slate-500 mt-0.5">Payable {rupee(Math.abs(effPayable))}{owes ? ' — he owes us' : ''}{bonusDay ? ` · incl. +${rupee(perDay)} bonus` : ''}</p>
        </div>

        {/* BONUS DAY — tick on top; adds one day's pay and bumps the pay field to cover it.
            Pre-ticked when the worker earned it (full attendance — owner rule); untick to refuse.
            If the bonus is ALREADY in the payable (worker-page setting, e.g. Balaji), say so
            instead of showing an unticked box — ticking again would pay the day twice. */}
        {perDay > 0 && pay.perfectBonus > 0 && (
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl px-3 py-2.5 text-sm font-semibold text-emerald-800">
            🎯 Bonus day already included <span className="font-normal text-emerald-700">— +{rupee(pay.perfectBonus)} (full attendance) is inside the amount via the worker's page. No tick needed.</span>
          </div>
        )}
        {perDay > 0 && !(pay.perfectBonus > 0) && (
          <label className="flex items-center justify-between bg-amber-50 border-2 border-amber-200 rounded-xl px-3 py-2.5 cursor-pointer">
            <span className="text-sm font-semibold text-amber-900">🎯 Bonus day <span className="font-normal text-amber-700">+{rupee(perDay)} (1 day)</span>{pay.perfectEligible ? <span className="block text-[11px] font-normal text-amber-700">full attendance ✓ — auto-ticked, untick to refuse</span> : null}</span>
            <input type="checkbox" className="w-6 h-6 accent-amber-600" checked={!!bonusDay} disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                const bump = on ? perDay : -perDay;
                const cashN = Number(cash) || 0;
                const acctN = Number(account) || 0;
                // adjust whichever field holds the money (account for an account-only pay)
                if (cashN === 0 && acctN > 0) onChange({ ...payC, bonusDay: on, account: String(Math.max(0, Math.round((acctN + bump) * 100) / 100)) });
                else onChange({ ...payC, bonusDay: on, cash: String(Math.max(0, Math.round((cashN + bump) * 100) / 100)) });
              }} />
          </label>
        )}

        {/* SPLIT — Cash + Account, both editable at once */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide text-center">💵 Cash ₹
            <input type="number" inputMode="numeric" autoFocus value={cash} onChange={(e) => onChange({ ...payC, cash: e.target.value })} onFocus={(e) => e.target.select()}
              className="mt-1 w-full border-2 border-emerald-600 rounded-xl px-2 py-3 text-2xl font-bold text-slate-900 text-center focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          </label>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide text-center">🏦 Account ₹
            <input type="number" inputMode="numeric" value={account} onChange={(e) => onChange({ ...payC, account: e.target.value })} onFocus={(e) => e.target.select()}
              className="mt-1 w-full border-2 border-slate-700 rounded-xl px-2 py-3 text-2xl font-bold text-slate-900 text-center focus:outline-none focus:ring-2 focus:ring-slate-400" />
          </label>
        </div>

        <p className="text-xs text-center text-slate-600">
          Paying now <b className="text-slate-900">{rupee(total)}</b> · Balance <b className={closing >= 0 ? 'text-rose-600' : 'text-emerald-700'}>{closing >= 0 ? '+' : ''}{rupee(closing)}</b> {closing >= 0 ? 'stays owed to him' : 'he owes us'} → carries next month.
        </p>

        <button disabled={busy} onClick={() => onConfirm(r, cashN, acctN, !!bonusDay)}
          className="w-full bg-emerald-600 text-white rounded-2xl py-4 text-lg font-bold shadow-lg shadow-emerald-300 disabled:opacity-50 disabled:shadow-none active:bg-emerald-700 active:scale-95 transition-all">
          {busy ? 'Paying…' : `Pay ${rupee(total)} & lock`}
        </button>
        <button disabled={busy} onClick={onCancel} className="w-full text-sm text-slate-500 py-2 disabled:opacity-50">Cancel</button>
      </div>
    </div>
  );
}

function OwnerRow({ r, mk, busy, justPaidMode, user, onName, onPay, onUndo, onAdvanceSaved, onAdvanceRevert }) {
  const { emp, md, pay } = r;
  const [showDays, setShowDays] = useState(false);
  // 💸 inline advance box (null = closed). Owner writes the advance DIRECTLY (addAdvanceDirect) so
  // it shows INSTANTLY — no 5-min queue wait — then reflects in this row + the money totals at once.
  const advToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const [adv, setAdv] = useState(null);   // { amount, date, mode, st }
  async function saveAdv() {
    if (!Number(adv.amount) || Number(adv.amount) <= 0 || !adv.date) { setAdv({ ...adv, st: 'Fill amount and date.' }); return; }
    // Client-side guard first (using the worker in memory) so the common case never needs a revert:
    // block a back-dated advance into a month that (or a later month) is already paid & locked.
    const advMk = String(adv.date).slice(0, 7);
    const months = emp.months || {};
    const sealed = months[advMk]?.locked || months[advMk]?.payment || Object.keys(months).some((m) => m > advMk && (months[m]?.locked || months[m]?.payment));
    if (sealed) { setAdv({ ...adv, st: 'That month is already paid & locked — advance not allowed.' }); return; }
    // Mint the id HERE so the direct write and the network-blip fallback share ONE id — a write that
    // lands but times out is then deduped by the worker on retry (never records the advance twice).
    const advance = { id: 'adv-' + adv.date + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), date: adv.date, mode: adv.mode, amount: Number(adv.amount), remark: '', paidBy: user.email };
    // OPTIMISTIC: reflect INSTANTLY, then persist in the background — the owner never waits on the network.
    onAdvanceSaved?.(emp.code, advance);
    setAdv({ amount: '', date: advToday, mode: adv.mode, st: 'done' });
    addAdvanceDirect(emp.code, advance, user.email).catch((e) => {
      if (String(e?.message || '').startsWith('LOCKED:')) {
        onAdvanceRevert?.(emp.code, advance.id);   // undo the optimistic add — it was NOT saved
        setAdv((a) => ({ ...(a || { amount: '', date: advToday, mode: 'cash' }), st: 'That month is already paid & locked — advance was NOT saved.' }));
      } else {
        // network blip → never lose it: fall back to the offline-safe queue (still lands; keep it shown)
        queueAdvance(emp.code, advance, user.email).catch(() => {});
      }
    });
  }
  // this worker's advances already given ON OR BEFORE the box's date (newest first) + total
  const advDate = adv?.date || advToday;
  const priorAdvs = adv ? (emp.advances || []).filter((a) => a.date && a.date <= advDate).sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];
  const priorTotal = priorAdvs.reduce((t, a) => t + Number(a.amount || 0), 0);
  const isLocked = !!md.locked || !!md.payment;                  // settled & frozen via Lock
  const payable = pay.payable || 0;
  const owes = payable < 0;
  const sub2 = [
    pay.otHrsNet > 0 ? `OT ${pay.otHrsNet}h` : null,
  ].filter(Boolean).join(' · ');
  // Advance picture for this row: total the worker owes = balance BROUGHT FORWARD from earlier months
  // (openingBalance; − = owes us, + = credit in his favour) + advances GIVEN this running month.
  const carried = Number(pay.openingBalance || 0);
  const monthAdv = (emp.advances || []).filter((a) => (a.date || '').startsWith(mk)).reduce((t, a) => t + Number(a.amount || 0), 0);
  const advOwed = -carried + monthAdv;               // + = worker owes; − = net credit to worker
  const bfOwed = carried < 0 ? -carried : 0;
  const bfCredit = carried > 0 ? carried : 0;
  const showAdv = Math.round(bfOwed) > 0 || Math.round(bfCredit) > 0 || Math.round(monthAdv) > 0;
  return (
    <div className={`rounded-2xl p-3 ${justPaidMode ? 'bg-emerald-50 border-2 border-emerald-200' : isLocked ? 'bg-white border-2 border-slate-100 opacity-70' : 'bg-white border-2 border-slate-200 shadow-sm'}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <button onClick={onName} className="text-left block">
            <span className="font-bold text-slate-900 text-base">{emp.name || emp.code}{emp.nickname ? <span className="text-slate-400 font-normal"> ({emp.nickname})</span> : null}</span>
            {(r.lateFixed || 0) > 0.25 && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 align-middle">⚠ punch-fixed +{r.lateFixed}h OT</span>}
            {r.hasOverride && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 align-middle">✍️ manual days/OT</span>}
            {r.emp.manual && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 rounded px-1 py-0.5 align-middle">manual worker</span>}
          </button>
          <div className="text-xs text-slate-500">
            <button onClick={() => setShowDays((s) => !s)} className="text-blue-700 underline decoration-dotted underline-offset-2">{pay.paidDays}d · details {showDays ? '▾' : '▸'}</button>
            {sub2 ? ` · ${sub2}` : ''}
          </div>
          {!isLocked && showAdv && (
            <div className="text-xs mt-0.5">
              {advOwed >= 0 ? (
                <span className="text-rose-700">💰 Advance <b>{rupee(Math.round(advOwed))}</b>
                  <span className="text-slate-400"> · {Math.round(bfOwed) > 0 ? `${rupee(Math.round(bfOwed))} b/f` : (Math.round(bfCredit) > 0 ? `${rupee(Math.round(bfCredit))} credit b/f` : `${rupee(0)} b/f`)} + {rupee(Math.round(monthAdv))} this month</span>
                </span>
              ) : (
                <span className="text-emerald-700">💰 <b>{rupee(Math.round(-advOwed))} credit</b> <span className="text-slate-400">(we owe him)</span></span>
              )}
            </div>
          )}
          {showDays && <WorkerSummary r={r} mk={mk} />}
        </div>
        <div className="text-right shrink-0">
          <div className={`font-extrabold text-xl ${isLocked ? 'text-emerald-700' : owes ? 'text-amber-700' : 'text-rose-600'}`}>
            {isLocked ? rupee(md.payment?.net || 0) : owes ? `owes ${rupee(Math.abs(payable))}` : rupee(payable)}
          </div>
          {isLocked && !justPaidMode && <span className="text-[11px] text-emerald-700 font-medium">🔒 Locked{md.payment?.closing ? ` · bal ${md.payment.closing >= 0 ? '+' : ''}${rupee(md.payment.closing)}` : ''}</span>}
        </div>
      </div>
      {/* just paid this session → ✓ confirmation + one-tap Undo for a mis-tap */}
      {justPaidMode && (
        <div className="flex items-center justify-between mt-2 text-sm">
          <span className="text-emerald-700 font-semibold">{justPaidMode === 'settled' ? '✓ Settled — ₹0 paid' : `✓ Paid ${justPaidMode === 'split' ? '💵+🏦 split' : justPaidMode === 'account' ? '🏦 account' : '💵 cash'}`}{md.payment?.closing ? ` · bal ${md.payment.closing >= 0 ? '+' : ''}${rupee(md.payment.closing)}` : ''}</span>
          <button disabled={busy} onClick={onUndo} className="text-slate-500 underline underline-offset-2 px-2 py-1 disabled:opacity-50">Undo</button>
        </div>
      )}
      {/* not settled → ONE-TAP pay (full amount, that method, locks instantly) + 💸 Advance */}
      {!isLocked && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            {owes ? (
              <button disabled={busy} onClick={() => onPay('cash')} className="flex-1 bg-slate-800 text-white rounded-2xl py-4 font-bold text-sm disabled:opacity-50 active:scale-95 transition-all">Settle &amp; lock <span className="font-normal opacity-80">(carries {rupee(Math.abs(payable))})</span></button>
            ) : (
              <>
                <button disabled={busy} onClick={() => onPay('cash')} className="flex-1 bg-emerald-600 text-white rounded-2xl py-4 font-bold text-base shadow-lg shadow-emerald-300 disabled:opacity-50 disabled:shadow-none active:bg-emerald-700 active:scale-95 transition-all">💵 Cash</button>
                <button disabled={busy} onClick={() => onPay('account')} className="flex-1 bg-slate-800 text-white rounded-2xl py-4 font-bold text-base shadow-lg shadow-slate-300 disabled:opacity-50 disabled:shadow-none active:bg-slate-900 active:scale-95 transition-all">🏦 Account</button>
              </>
            )}
            <button onClick={() => setAdv(adv ? null : { amount: '', date: advToday, mode: 'cash', st: '' })} className={`flex-1 rounded-2xl py-4 font-bold text-base active:scale-95 transition-all ${adv ? 'bg-amber-100 text-amber-800 border-2 border-amber-300' : 'bg-amber-500 text-white shadow-lg shadow-amber-200'}`}>💸 Advance</button>
          </div>
          {/* inline advance entry: amount + date + Cash/Account → saves for THIS worker */}
          {adv && adv.st !== 'done' && (
            <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input type="number" inputMode="numeric" autoFocus placeholder="Amount ₹" value={adv.amount} onFocus={(e) => e.target.select()} onChange={(e) => setAdv({ ...adv, amount: e.target.value })} className="border-2 border-amber-200 rounded-xl px-3 py-2.5 text-base bg-white focus:outline-none focus:border-amber-400" />
                <input type="date" value={adv.date} onChange={(e) => setAdv({ ...adv, date: e.target.value })} className="border-2 border-amber-200 rounded-xl px-3 py-2.5 text-base bg-white focus:outline-none focus:border-amber-400" />
              </div>
              {/* advances already given to this worker up to the chosen date */}
              <div className="rounded-xl bg-white border-2 border-amber-200 p-2 text-xs">
                <div className="flex justify-between font-bold text-slate-700 mb-0.5">
                  <span>Advances till {advDate.slice(8)}/{advDate.slice(5, 7)}</span>
                  <span className="text-amber-700">{rupee(priorTotal)}{priorAdvs.length ? ` · ${priorAdvs.length}` : ''}</span>
                </div>
                {priorAdvs.length === 0
                  ? <div className="text-slate-400">None yet</div>
                  : <div className="max-h-32 overflow-auto divide-y divide-slate-100">
                      {priorAdvs.map((a, i) => (
                        <div key={a.id || i} className="flex justify-between py-1">
                          <span className="text-slate-500">{(a.date || '').slice(8)}/{(a.date || '').slice(5, 7)} · {a.mode === 'account' ? '🏦' : '💵'}{a.remark ? ' · ' + a.remark : ''}</span>
                          <span className="text-slate-700 font-medium">{rupee(Number(a.amount || 0))}</span>
                        </div>
                      ))}
                    </div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setAdv({ ...adv, mode: 'cash' })} className={`flex-1 rounded-xl py-3 font-bold text-sm transition ${adv.mode === 'cash' ? 'bg-emerald-600 text-white' : 'bg-white border-2 border-slate-200 text-slate-600'}`}>💵 Cash</button>
                <button onClick={() => setAdv({ ...adv, mode: 'account' })} className={`flex-1 rounded-xl py-3 font-bold text-sm transition ${adv.mode === 'account' ? 'bg-slate-800 text-white' : 'bg-white border-2 border-slate-200 text-slate-600'}`}>🏦 Account</button>
              </div>
              {adv.st && adv.st !== 'saving' && <p className="text-xs text-rose-600 font-medium px-1">{adv.st}</p>}
              <button disabled={adv.st === 'saving'} onClick={saveAdv} className="w-full bg-amber-600 text-white rounded-2xl py-3.5 font-bold text-base disabled:opacity-50 active:bg-amber-700 active:scale-95 transition-all">{adv.st === 'saving' ? 'Saving…' : `Save advance${Number(adv.amount) > 0 ? ' ' + rupee(Number(adv.amount)) : ''}`}</button>
            </div>
          )}
          {adv && adv.st === 'done' && (
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-3 flex items-center justify-between">
              <span className="text-sm text-emerald-700 font-semibold">✓ Advance saved</span>
              <button onClick={() => setAdv(null)} className="text-slate-500 underline underline-offset-2 text-sm px-2 py-1">Close</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- manager view (READ-ONLY since 2026-07-17) ----------------
   The owner pays & locks everything himself; the manager (incharge) only needs to SEE
   who is paid. Built from the payout mirror docs (att_meta/payout_YYYY-MM) the cloud
   worker refreshes every cycle — managers cannot read att_salary directly (rules), and
   the mirror carries paid-status only, no amounts. */
function ManagerSalary({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [payout, setPayout] = useState(null);
  const [filter, setFilter] = useState('all');   // all | topay | paid

  useEffect(() => { setPayout(null); loadPayout(mk).then(setPayout); }, [mk]);
  if (payout === null) return <p className="text-slate-500">Loading…</p>;

  const items = Object.entries(payout.items || {}).map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const paid = items.filter((i) => i.paid);
  const visible = items.filter((i) => filter === 'all' ? true : filter === 'paid' ? i.paid : !i.paid);

  return (
    <div className="space-y-3 pb-6">
      <select className="w-full bg-white border-2 border-slate-200 rounded-2xl px-3 py-3 font-bold text-slate-800 text-center" value={mk} onChange={(e) => setMk(e.target.value)}>
        {monthOptions(3).map((m) => <option key={m.mk} value={m.mk}>{m.label}</option>)}
      </select>
      <div className="flex gap-2">
        {[['all', `All (${items.length})`], ['topay', `🔴 Not paid (${items.length - paid.length})`], ['paid', `✅ Paid (${paid.length})`]].map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`flex-1 rounded-2xl py-3 text-sm font-bold transition ${filter === key ? 'bg-emerald-600 text-white shadow' : 'bg-white text-slate-600 border-2 border-slate-200'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {visible.length === 0 && <p className="bg-white rounded-2xl border-2 border-slate-200 p-4 text-sm text-slate-400 text-center">{items.length === 0 ? 'The list refreshes every few minutes — check back shortly.' : 'No one here.'}</p>}
        {visible.map((i) => (
          <div key={i.code} className={`flex items-center p-3 gap-2 rounded-2xl bg-white border-2 ${i.paid ? 'border-slate-100 opacity-70' : 'border-slate-200 shadow-sm'}`}>
            <div className="flex-1">
              <div className="font-bold text-slate-900">{i.name}{i.nickname ? <span className="text-slate-400 font-normal"> ({i.nickname})</span> : null}</div>
              <div className="text-xs text-slate-500">{i.dept}</div>
            </div>
            {i.paid
              ? <span className="text-xs text-emerald-700 font-bold">✓ Paid {i.paid.mode === 'split' ? '💵+🏦' : i.paid.mode === 'account' ? '🏦' : '💵'}{i.paid.date ? ` · ${i.paid.date.slice(8)}/${i.paid.date.slice(5, 7)}` : ''}</span>
              : <span className="text-xs text-rose-600 font-bold">🔴 Not paid</span>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-400 px-1">Salary is paid & locked by the owner. This list shows paid/not-paid only (updates every few minutes).</p>
      <AdvanceCard user={user} />
    </div>
  );
}

// Owner export: a PDF of EVERY worker's advances given up to a chosen date, Cash & Account in
// separate columns, listed date-wise per worker with subtotals + grand totals. Reads emp.advances.
function AdvancesExportCard({ emps }) {
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [st, setSt] = useState('');
  async function go() {
    setSt('building');
    const mk = asOf.slice(0, 7);   // ledger is for the month of the chosen date
    const groups = (emps || [])
      .map((e) => ({
        name: e.name || e.code, code: e.code, dept: e.dept || '',
        bf: Number(((e.months || {})[mk] || {}).openingBalance || 0),   // leftover carried from last month
        entries: (e.advances || []).filter((a) => a.date && a.date.startsWith(mk) && a.date <= asOf),
      }))
      .filter((g) => g.entries.length || Math.round(g.bf) !== 0)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!groups.length) { setSt('No advances or balances for that month.'); return; }
    const label = `${asOf.slice(8)}/${asOf.slice(5, 7)}/${asOf.slice(0, 4)}`;
    try { await sharePdf(advancesPdf(groups, label), `advances-till-${asOf}.pdf`); setSt('done'); }
    catch { setSt('Could not create the PDF — try again.'); }
  }
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3 space-y-2">
      <div className="font-bold text-slate-700">📄 Advances PDF (till a date)</div>
      <p className="text-[11px] text-slate-500">Every worker's advances up to the date — Cash &amp; Account separate, date-wise, with totals.</p>
      <div className="flex gap-2 items-center">
        <input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setSt(''); }} className="flex-1 border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base bg-white" />
        <button disabled={st === 'building'} onClick={go} className="bg-slate-800 text-white rounded-xl px-5 py-2.5 font-bold text-sm disabled:opacity-50 active:scale-95 transition-all">{st === 'building' ? '…' : 'Export'}</button>
      </div>
      {st && st !== 'building' && st !== 'done' && <p className="text-xs text-rose-600 font-medium px-1">{st}</p>}
      {st === 'done' && <p className="text-xs text-emerald-700 font-semibold px-1">✓ PDF ready</p>}
    </div>
  );
}

// MANAGER Advances page (feature 'advances'): give an advance to any worker and see each worker's
// outstanding balance "till today" — with NO salary/pay figures. Balances come from the salary-free
// att_meta/advance_balances mirror (the worker writes it); the manager can't read att_salary at all.
export function ManagerAdvances({ user }) {
  const [bal, setBal] = useState(null);
  const [extra, setExtra] = useState({});   // code -> amount added this session (instant reflection)
  const [q, setQ] = useState('');
  useEffect(() => { loadAdvanceBalances().then(setBal); }, []);
  const items = bal?.items || {};
  const owedOf = (code) => Math.round((items[code]?.totalOwed || 0) + (extra[code] || 0));
  const onSaved = (code, adv) => setExtra((p) => ({ ...p, [code]: (p[code] || 0) + Number(adv.amount || 0) }));
  const list = useMemo(() => Object.entries(items).map(([code, v]) => ({ code, ...v }))
    .filter((v) => !q || (v.name || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => owedOf(b.code) - owedOf(a.code)), [items, q, extra]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3">
      <AdvanceCard user={user} balances={items} extraOwed={extra} onSaved={onSaved} />
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-bold text-slate-700">Outstanding advances (till today)</div>
          {bal?.updatedAt && <span className="text-[11px] text-slate-400">as of {new Date(bal.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
        <input className="w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 text-base" placeholder="🔍 Search worker…" value={q} onChange={(e) => setQ(e.target.value)} />
        {!bal && <p className="text-sm text-slate-400">Loading…</p>}
        <div className="divide-y divide-slate-100 max-h-[58vh] overflow-auto">
          {list.map((v) => {
            const owed = owedOf(v.code);
            return (
              <div key={v.code} className="py-2.5 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-slate-700">{v.name}{v.dept ? <span className="text-slate-400"> · {v.dept}</span> : null}</span>
                <b className={`shrink-0 ${owed > 0 ? 'text-rose-700' : owed < 0 ? 'text-emerald-700' : 'text-slate-400'}`}>{owed > 0 ? `₹${owed.toLocaleString('en-IN')}` : owed < 0 ? `₹${(-owed).toLocaleString('en-IN')} cr` : '₹0'}</b>
              </div>
            );
          })}
          {bal && !list.length && <p className="text-sm text-slate-400 py-2">No workers match.</p>}
        </div>
      </div>
      <p className="text-[11px] text-slate-500 px-1">Advances you record here are applied within a few minutes and the owner gets a Telegram alert. Balances refresh automatically. This page never shows salaries.</p>
    </div>
  );
}

// quick advance entry (manager + owner): date, amount, mode, remark; blocked once that
// month's salary is already paid for the person.
export function AdvanceCard({ user, extra = [], onSaved, balances = null, extraOwed = null }) {
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
    // one shared id so the direct write + any fallback queue dedupe on retry (no double advance).
    const advance = { id: 'adv-' + f.date + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), date: f.date, mode: f.mode, amount: Number(f.amount), remark: f.remark || '', paidBy: user.email };
    try {
      // OWNER writes directly (instant); MANAGER queues (can't write att_salary) with a best-effort paid check.
      if (user.role === 'admin') {
        const saved = await addAdvanceDirect(f.code, advance, user.email);
        onSaved?.(f.code, saved);
      } else {
        const po = await loadPayout(f.date.slice(0, 7));
        if (po.items?.[f.code]?.paid) { setSt(`Salary for ${f.date.slice(0, 7)} is already PAID — advance not allowed for that month.`); return; }
        await queueAdvance(f.code, advance, user.email);
        onSaved?.(f.code, advance);   // let the Advances page reflect the new balance instantly
      }
      setSt('done'); setF({ code: null, name: '', amount: '', mode: 'cash', date: today, remark: '' });
    } catch (e) {
      const m = String(e?.message || '');
      if (m.startsWith('LOCKED:')) { setSt(`Salary for ${m.slice(7)} is already paid & locked — advance not allowed.`); return; }
      // owner direct-write hit a network blip → never lose it: fall back to the offline-safe queue
      if (user.role === 'admin') {
        try { await queueAdvance(f.code, advance, user.email); setSt('done'); setF({ code: null, name: '', amount: '', mode: 'cash', date: today, remark: '' }); return; } catch { /* fall through */ }
      }
      setSt('Could not save — try again.');
    }
  }
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3 space-y-2">
      <div className="font-bold text-slate-700">💸 Give advance</div>
      <div className="grid grid-cols-2 gap-2">
        <NamePick roster={pickList} value={f.name} onChange={(code, name) => setF({ ...f, code, name })} className="col-span-2" />
        {balances && f.code && (() => {
          const owed = Math.round((balances[f.code]?.totalOwed || 0) + ((extraOwed && extraOwed[f.code]) || 0));
          return <p className={`col-span-2 -mt-1 text-sm font-bold ${owed >= 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{owed >= 0 ? `💰 Owes ₹${owed.toLocaleString('en-IN')} till today` : `💰 ₹${(-owed).toLocaleString('en-IN')} credit (we owe him)`}</p>;
        })()}
        <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <select className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm bg-white" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
          <option value="cash">Cash</option><option value="account">Bank</option>
        </select>
        <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" placeholder="Remark (optional)" value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
        <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-amber-500 text-white rounded-2xl py-3.5 font-bold shadow-lg shadow-amber-200 disabled:opacity-50 disabled:shadow-none active:bg-amber-600 active:scale-95 transition-all">＋ Record advance</button>
      </div>
      {f.name && !f.code && <p className="text-xs text-amber-700">Keep typing — more than one name matches.</p>}
      {st === 'done' && <p className="text-xs text-green-700">✓ Recorded — owner gets a Telegram alert.</p>}
      {st && !['saving', 'done'].includes(st) && <p className="text-xs text-red-600">{st}</p>}
    </div>
  );
}

// Declare / update a NEW biometric worker on the machine. Flow: the fingerprint is enrolled on the
// device first (worker appears here), then the owner sets Name + Department + Shift + Gender and it
// pushes to the Realtime portal automatically. Loading auto-selects the LOD (daily-wager) shift.
function DeclareWorkerCard({ user, emps, onSaved }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', dept: '', shift: '', gender: '' });
  const [pick, setPick] = useState('');   // picker search text — SEPARATE from the editable name box
  const [st, setSt] = useState('');
  // biometric (machine) workers only — app-only staff (Radhey/Dinesh) can't be pushed to the machine.
  const byCode = useMemo(() => Object.fromEntries((emps || []).map((e) => [e.code, e])), [emps]);
  const machineRoster = useMemo(
    () => (emps || []).filter((e) => e && e.code && !e.appOnly && e.onMachine !== false && e.active !== false).map((e) => ({ code: e.code, name: e.name })),
    [emps]);

  // Pick a worker → load their current record. If the name is still just the code (freshly enrolled,
  // un-named) start the Name box EMPTY so the owner simply types the real name. The picker no longer
  // shares state with the Name box, so editing the name can't wipe the selected code.
  function onPick(code, text) {
    setPick(text);
    if (!code) return;
    const e = byCode[code] || {};
    const orig = e.name || '';
    setF({ code, name: orig === code ? '' : orig, dept: e.dept || '', shift: e.shift || '', gender: e.gender || '' });
    setPick(''); setSt('');
  }
  function reset() { setF({ code: '', name: '', dept: '', shift: '', gender: '' }); setPick(''); setSt(''); }
  function pickDept(dept) { setF((prev) => ({ ...prev, dept, shift: DEPT_DEFAULT_SHIFT[dept] || prev.shift })); }
  async function go() {
    if (!f.code) { setSt('Pick a worker first.'); return; }
    if (!f.name.trim()) { setSt('Type the worker’s name.'); return; }
    if (!f.gender) { setSt('Choose Male / Female — the machine won’t save without it.'); return; }
    setSt('saving');
    try {
      await pushWorkerProfile(f.code, { name: f.name, dept: f.dept, shift: f.shift, gender: f.gender }, user.email);
      setSt('done'); reset();
      onSaved && onSaved();
    } catch (e) { setSt(String(e?.message || 'Could not save — try again.')); }
  }
  const inp = 'border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm bg-white';
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left font-bold text-slate-700">🆕 Declare a new machine worker <span className="font-normal text-xs text-slate-400">— set name/dept/shift/gender → updates the machine</span> <span className="float-right text-slate-400">{open ? '▲' : '▼'}</span></button>
      {open && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          {!f.code ? (
            <div className="col-span-2">
              <NamePick roster={machineRoster} value={pick} onChange={onPick} placeholder="Pick worker by number or name…" />
              <p className="text-[11px] text-slate-500 mt-1">A freshly-enrolled worker shows as his code number — search that number, tap it, then type his name below.</p>
            </div>
          ) : (<>
            <div className="col-span-2 flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <span className="text-sm text-slate-700">Worker <b>{byCode[f.code]?.name || f.code}</b> <span className="text-slate-400">({f.code})</span></span>
              <button onClick={reset} className="text-xs text-blue-600 font-semibold">change</button>
            </div>
            <input className={inp + ' col-span-2'} placeholder="Name (type the real name)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <select className={inp} value={f.dept} onChange={(e) => pickDept(e.target.value)}>
              <option value="">Department…</option>
              {MACHINE_DEPTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select className={inp} value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>
              <option value="">Shift…</option>
              {MACHINE_SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className={inp + ' col-span-2'} value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}>
              <option value="">Gender… (required)</option>
              {MACHINE_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-emerald-600 text-white rounded-2xl py-3.5 font-bold shadow-lg shadow-emerald-200 disabled:opacity-50 disabled:shadow-none active:bg-emerald-700 active:scale-95 transition-all">Save &amp; update machine</button>
            <p className="col-span-2 text-[11px] text-slate-500">Enroll the finger on the device first. Loading auto-picks the LOD daily-wager shift. On Save it pushes to the machine and confirms it stuck (Telegram).</p>
          </>)}
        </div>
      )}
      {st === 'saving' && <p className="text-xs text-slate-500 mt-1">Sending to the machine…</p>}
      {st === 'done' && <p className="text-xs text-green-700 mt-1">✓ Saved — the machine updates in a few minutes (owner gets a Telegram confirmation).</p>}
      {st && !['saving', 'done'].includes(st) && <p className="text-xs text-red-600 mt-1">{st}</p>}
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
    // REJECT, don't default (2026-07-31, Codex round 3). This used to read `Number(...) || 8.5`, so
    // 0, blank or a typo silently became 8.5 — and standardHours IS this worker's OT divisor, the
    // number that decides what an hour of his overtime is worth. A silent default is how the
    // manual-worker OT bug happened in the first place; the data layer's own 0 < h <= 24 check never
    // saw the bad value because this line had already replaced it.
    const hrs = Number(f.standardHours);
    if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 24) { setSt('Enter working hours per day between 0 and 24 — this sets his overtime rate.'); return; }
    setSt('saving');
    try {
      await addManualWorker({ name: f.name, dept: f.dept, type: f.type, amount: Number(f.amount), standardHours: hrs }, user.email);
      setSt('done'); setF({ name: '', dept: '', type: 'monthly', amount: '', standardHours: '8.5' });
      onAdded && onAdded();
    } catch { setSt('Could not save — try again.'); }
  }
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left font-bold text-slate-700">➕ Add a manual worker <span className="font-normal text-xs text-slate-400">— not on the machine (Radhey, Dinesh…)</span> <span className="float-right text-slate-400">{open ? '▲' : '▼'}</span></button>
      {open && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm col-span-2" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" placeholder="Department (optional)" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })} />
          <select className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm bg-white" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="monthly">₹ / month</option><option value="daily">₹ / day</option>
          </select>
          <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" type="number" inputMode="numeric" placeholder={f.type === 'daily' ? 'Wage ₹/day' : 'Salary ₹/month'} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <input className="border-2 border-slate-200 rounded-xl px-2 py-2.5 text-sm" type="number" inputMode="decimal" placeholder="Shift hours (8.5)" value={f.standardHours} onChange={(e) => setF({ ...f, standardHours: e.target.value })} />
          <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-slate-800 text-white rounded-2xl py-3.5 font-bold shadow-lg shadow-slate-300 disabled:opacity-50 disabled:shadow-none active:bg-slate-900 active:scale-95 transition-all">Add worker</button>
          <p className="col-span-2 text-[11px] text-slate-500">After adding, open the worker and use <b>✍️ Override days / OT</b> each month to set their days & overtime, then pay them from the Salary list.</p>
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
        <div className="font-bold text-lg text-slate-800">📄 Reports</div>
        <select className="w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 bg-white" value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })}>
          {REPORTS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <select className="w-full border-2 border-slate-200 rounded-xl px-3 py-2.5 bg-white" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>
          {monthOptions(3).map((m, i) => <option key={m.mk} value={i}>{m.label}</option>)}
        </select>
        <NamePick roster={roster} value={f.name} onChange={(code, name) => setF({ ...f, code, name })}
          placeholder="Type a name… (empty = everyone)" className="w-full" />
        {f.name && !f.code && <p className="text-xs text-amber-700">Keep typing — more than one name matches.</p>}
        {st === 'sent' ? <p className="text-sm text-emerald-700">✓ On its way to Telegram (1–2 min). Forward it to WhatsApp from there.</p> : (
          <button onClick={send} disabled={st === 'sending'} className="w-full bg-blue-600 text-white rounded-2xl py-3 font-bold shadow-lg shadow-blue-300 disabled:opacity-50 disabled:shadow-none active:bg-blue-700 active:scale-95 transition-all">✈️ Send to Telegram</button>
        )}
        <button onClick={register} className="w-full bg-white border-2 border-emerald-300 text-emerald-700 rounded-2xl py-3 font-bold active:bg-emerald-50 active:scale-95 transition-all">🟢 Salary register PDF — share / WhatsApp</button>
        <button onClick={lockedReg} className="w-full bg-white border-2 border-slate-300 text-slate-800 rounded-2xl py-3 font-bold active:bg-slate-50 active:scale-95 transition-all">🔒 Locked salary + payments PDF <span className="font-normal text-xs text-slate-500">(days·OT·adv·payable·net·cash·account·carry)</span></button>
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
    <div className="bg-white rounded-2xl border-2 border-slate-200 p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left font-bold text-slate-600">
        No salary set ({list.length}) <span className="font-normal text-xs text-slate-400">— piece-rate welders can stay empty</span> <span className="float-right text-slate-400">{show ? '▲' : '▼'}</span>
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
