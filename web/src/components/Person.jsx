import { useEffect, useMemo, useState } from 'react';
import { loadEmployee, loadAllAttendance, loadPunchDoc, saveEmployee, saveMonth, addAdvance, addIncrement, resignEmployee, settleAndResign, checkActionPassword, queueJob, queueLock, queueUnlock, lockMonthDirect, editNameDept, istMonth } from '../lib/data';
import { monthCtx, payFor, rupee, paymentBreakdown } from '../lib/paycalc';
import { payslipOnePdf, sharePdf } from '../lib/salaryPdf';
import { graceDeltaDays } from '../lib/attendanceEngine';

// One person, one page: this month's money, their ledger, their settings.
export default function Person({ code, mk, user, onBack }) {
  const [emp, setEmp] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [punchDoc, setPunchDoc] = useState(null);
  const [busy, setBusy] = useState(false);
  const ctx = useMemo(() => monthCtx(mk), [mk]);
  const graceDelta = useMemo(() => (emp ? graceDeltaDays(emp.shift, punchDoc, mk, istMonth()) : 0), [emp, punchDoc, mk]);

  async function reload() {
    const [e, am, pd] = await Promise.all([loadEmployee(code), loadAllAttendance(), loadPunchDoc(code)]);
    setEmp(e); setAttMap(am); setPunchDoc(pd);
  }
  useEffect(() => { reload(); }, [code]);
  const act = async (fn) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };

  if (!emp) return <p className="text-gray-500">Loading…</p>;
  const { att, md, pay, portalOt = 0, appOt = 0, otSource = 'portal', otCredit = 0, detail: otDetail = [], presentAdjust = 0, satAdjust = 0, lateFixed = 0, rawLate = 0 } = payFor(emp, attMap, mk, ctx, graceDelta, punchDoc);
  // freeze once LOCKED (cashier settle) or approved/paid — nothing about the month can be edited
  const locked = !!md.locked || !!md.payment || !!md.approved;
  // For a LOCKED month, show the figures as they were AT LOCK (stored snapshot), never recomputed under
  // today's rules — otherwise a change like the new full-advance-cut would make an already-paid month
  // look wrong. Months locked before snapshots existed (e.g. June) have no `breakdown`; there we show
  // base/OT only and skip the advance/loan itemisation (the stored net + carry are still authoritative).
  const snap = locked && md.payment && md.payment.breakdown ? md.payment.breakdown : null;
  // One display object used everywhere (rows, WhatsApp, PDF) so a locked month renders its LOCKED
  // figures, never today's recomputed ones. snapshot → exact stored figures; locked-without-snapshot
  // (June) → hide advance itemisation and show the amount actually paid as the net; open month → live.
  const paidNet = md.payment ? md.payment.net : pay.net;
  const dispPay = snap
    ? { ...pay, ...snap, otHrsNet: snap.otHrsNet ?? pay.otHrsNet, advanceBalanceCarried: 0 }
    : locked
      ? { ...pay, advanceRecovered: 0, advanceBalanceCarried: 0, net: paidNet }
      : pay;
  // Attendance summary for answering a worker on the spot — with the actual DATES.
  // Mid-month joiner: only count/show from the join date onward (nothing before he was employed).
  const joinedThisMonth = (emp.joinDate || '').startsWith(mk);
  const fromYmd = joinedThisMonth ? emp.joinDate : null;
  const keep = (d) => !fromYmd || d.ymd >= fromYmd;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mk.slice(5, 7)) - 1];
  const dates = (list) => list.map((d) => Number(d.ymd.slice(8, 10))).join(', ');
  const absentD = otDetail.filter((d) => d.kind === 'absent' && keep(d));
  const halfD = otDetail.filter((d) => d.kind === 'half' && keep(d));
  const missedD = otDetail.filter((d) => (d.single || d.missing) && keep(d));
  const joinDayLabel = joinedThisMonth ? `${Number(emp.joinDate.slice(8, 10))} ${MON}` : null;
  // Extra days CREDITED this month = full-attendance bonus (1) + goodwill Saturdays + 15-min grace.
  const extraDays = Math.round(((dispPay.perfectBonus > 0 ? 1 : 0) + (dispPay.restoreSaturdayDays || 0) + (dispPay.graceDays || 0)) * 100) / 100;
  // eligible for the +1 full-attendance bonus but owner hasn't granted it yet (reminder in the summary)
  const bonusEligibleUnpaid = pay.perfectEligible && !(dispPay.perfectBonus > 0);
  // owner decides a borderline weekday Full/Half/Absent at pay time (md.dayOverrides). null = clear.
  const setDay = (ymd, value) => {
    const next = { ...(md.dayOverrides || {}) };
    if (value == null) delete next[ymd]; else next[ymd] = value;
    act(() => saveMonth(code, mk, { dayOverrides: next }));
  };
  // MANUAL OT credit for a flaky-machine single-punch day (owner's tap; hours=null to remove)
  const creditOt = (ymd, hours) => {
    const next = { ...(md.otCredits || {}) };
    if (hours == null) delete next[ymd]; else next[ymd] = hours;
    act(() => saveMonth(code, mk, { otCredits: next }));
  };
  const doLock = (cash, account, reason) => act(async () => {
    // Snapshot the salary breakdown AT LOCK so the paid month always shows these exact figures, immune
    // to any later rule change. advanceCarry is always 0 now (advance folds fully into the balance).
    const breakdown = paymentBreakdown(pay);
    // INSTANT: write the lock directly (owner has att_salary write); it freezes + carries right away.
    await lockMonthDirect(code, mk, { cash, account, payable: pay.payable, advanceCarry: pay.advanceBalanceCarried, breakdown, reason }, user.email);
    // background (best-effort): the robot adds the salary-register snapshot + Telegram alert.
    queueLock(code, mk, { cash, account, payable: pay.payable, advanceCarry: pay.advanceBalanceCarried, reason }, user.email).catch(() => {});
  });
  const doUnlock = (reason) => act(() => queueUnlock(code, mk, reason, user.email));
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const presentPct = ctx.elapsedDays > 0 ? Math.round((pay.presentDays / ctx.elapsedDays) * 100) : 0;

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-sm text-gray-600">← Back to list</button>

      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-bold text-lg text-gray-800">{emp.name || code}{emp.nickname ? <span className="text-gray-400 font-normal text-base"> ({emp.nickname})</span> : null}</div>
        <div className="text-xs text-gray-500">{emp.dept || ''} · {emp.shift || ''} · {emp.type === 'daily' ? rupee(emp.wage) + '/day' : rupee(emp.amount) + '/month'}</div>
        <div className="text-xs text-gray-500 mb-2">
          {emp.phone ? '📞 ' + emp.phone + ' · ' : ''}{emp.joinDate ? 'joined ' + emp.joinDate + ' · ' : ''}
          present {presentPct}% · late {att.lateDays || 0}×
        </div>
        {/* At-a-glance summary — read this out when a worker asks about his month */}
        {!pay.noAttendance && emp.type !== 'daily' && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 mb-2 text-sm text-gray-800">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{MON} {mk.slice(0, 4)} — attendance{joinDayLabel ? ` · joined ${joinDayLabel}` : ''}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span>Present <b>{pay.presentDays}</b></span>
              <span>Weekly-off <b>{pay.weeklyOffAll}</b></span>
              <span>Extra day <b className={extraDays ? 'text-green-700' : ''}>{extraDays}</b>{bonusEligibleUnpaid ? <span className="text-[11px] text-green-600"> (+1 eligible)</span> : ''}</span>
              <span>Overtime <b>{pay.otHrsNet}h</b></span>
            </div>
            <div className="border-t border-slate-200 mt-1.5 pt-1.5 space-y-0.5">
              <div>Absent <b className={absentD.length ? 'text-red-600' : ''}>{absentD.length}</b>{absentD.length ? <span className="text-gray-500"> — {dates(absentD)} {MON}</span> : ''}</div>
              <div>Half-day <b>{halfD.length}</b>{halfD.length ? <span className="text-gray-500"> — {dates(halfD)} {MON}</span> : ''}</div>
              <div>Missed punch <b className={missedD.length ? 'text-amber-600' : ''}>{missedD.length}</b>{missedD.length ? <span className="text-gray-500"> — {dates(missedD)} {MON}</span> : ''}</div>
            </div>
            <div className="border-t border-slate-200 mt-1.5 pt-1.5">Advance outstanding <b className={dispPay.advanceDue ? 'text-amber-700' : ''}>{rupee(dispPay.advanceDue || 0)}</b></div>
          </div>
        )}
        {md.approved && !md.payment && <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded p-1.5 mb-2">🔒 Ticked — figures frozen at {rupee(md.approvedNet)}. Undo the tick in the list to edit.</p>}
        {pay.noAttendance && <p className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded p-1.5 mb-2">ℹ️ No attendance for {mk} — not employed this month (joined later). Pays ₹0; old months don't apply.</p>}
        <Row k="Days" v={`present ${pay.presentDays} · absent ${pay.absentDays}`} />
        {(() => {
          const unpaid = pay.unpaidWorkedSat || 0;
          const sat = (att.weeklyOff || 0) + (att.weeklyOffPresent || 0) - unpaid;  // paid Saturdays only
          if (!sat && !att.weeklyOffPresent) return null;
          return <Row k="Weekly off (paid)" v={`${sat} Sat${att.weeklyOffPresent ? ` · worked ${att.weeklyOffPresent} → +OT` : ''}`} />;
        })()}
        {pay.unpaidWorkedSat > 0 && <Row k="Worked Sat (OT only)" v={`${pay.unpaidWorkedSat} — week not earned (4+ absences): day unpaid, OT kept`} />}
        {emp.type !== 'daily' && !pay.noAttendance && <Row k="Paid days" v={`${Math.max(0, (pay.payableDays || 0) - (pay.absentDays || 0))} of ${ctx.daysInMonth} (weekly-offs included)`} />}
        <Row k="Overtime" v={`${pay.otHrsNet}h paid`} />
        {lateFixed > 0.25 && (
          <div className="flex justify-between text-xs py-0.5"><span className="text-gray-500">Late fix</span>
            <span className="text-green-700">broken punch → −{lateFixed}h fake late removed · OT restored <span className="text-gray-400">(portal said {rawLate}h late)</span></span>
          </div>
        )}
        {(portalOt > 0 || appOt > 0) && emp.type !== 'daily' && (
          <div className="flex justify-between text-xs py-0.5"><span className="text-gray-500">OT source</span>
            <span className="text-gray-800">Portal {portalOt}h · App {appOt}h{Math.abs(portalOt - appOt) >= 0.5 ? <span className="text-amber-600"> ⚠ gap</span> : ''}{otCredit > 0 ? <span className="text-green-700"> +{otCredit}h credited</span> : ''} <span className="text-gray-400">(paying {otSource})</span></span>
          </div>
        )}
        <hr className="my-1.5" />
        <Row k="Base pay" v={rupee(dispPay.base)} />
        <Row k="+ Overtime" v={rupee(dispPay.otPay)} />
        {dispPay.perfectBonus > 0 && <Row k="+ Full-attendance bonus" v={rupee(dispPay.perfectBonus)} />}
        {dispPay.gracePay > 0 && <Row k={`+ 15-min grace (${dispPay.graceDays} day)`} v={rupee(dispPay.gracePay)} />}
        {dispPay.restoreSaturdayPay > 0 && <Row k={`+ ${dispPay.restoreSaturdayDays} Saturday${dispPay.restoreSaturdayDays > 1 ? 's' : ''} (goodwill)`} v={rupee(dispPay.restoreSaturdayPay)} />}
        {dispPay.bonus > 0 && <Row k="+ Bonus" v={rupee(dispPay.bonus)} />}
        {dispPay.fines > 0 && <Row k="− Fine" v={rupee(dispPay.fines)} />}
        {dispPay.advanceRecovered > 0 && <Row k="− Advance (full)" v={rupee(dispPay.advanceRecovered)} />}
        <div className="flex justify-between mt-1 pt-1.5 border-t font-bold"><span>This month ({mk})</span><span className="text-red-700">{rupee(dispPay.net)}</span></div>
        {md.payment && <p className="text-xs text-green-700 mt-1">✓ Paid {md.payment.date} ({md.payment.mode})</p>}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <button onClick={() => sharePdf(payslipOnePdf(emp, dispPay, mk), `payslip-${code}-${mk}.pdf`)} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">📄 PDF</button>
          <button onClick={() => {
            const sat = (att.weeklyOff || 0) + (att.weeklyOffPresent || 0);
            const L = [`*NSP — Salary ${mk}*`, `${emp.name || code}`, `Days: ${dispPay.presentDays} present / ${dispPay.absentDays} absent` + (sat ? ` / ${sat} weekly-off (paid)` : '') + (pay.saturdaysCut ? ` / ${pay.saturdaysCut} Sat cut` : ''), `OT: ${dispPay.otHrsNet}h`,
              `Base ₹${dispPay.base}` + (dispPay.otPay ? ` + OT ₹${dispPay.otPay}` : '') + (dispPay.perfectBonus ? ` + bonus ₹${dispPay.perfectBonus}` : '') + (dispPay.gracePay ? ` + grace ₹${dispPay.gracePay}` : '') + (dispPay.restoreSaturdayPay ? ` + ${dispPay.restoreSaturdayDays} Sat goodwill ₹${dispPay.restoreSaturdayPay}` : '') + (dispPay.bonus ? ` + bonus ₹${dispPay.bonus}` : ''),
              ...(dispPay.fines ? [`Fine −₹${dispPay.fines}`] : []),
              ...(dispPay.advanceRecovered ? [`Advance −₹${dispPay.advanceRecovered}`] : []),
              `*NET: ₹${Number(dispPay.net).toLocaleString('en-IN')}*`];
            const phone = (emp.phone || '').replace(/\D/g, '');
            window.open(`https://wa.me/${phone ? (phone.length === 10 ? '91' + phone : phone) : ''}?text=${encodeURIComponent(L.join('\n'))}`);
          }} className="border border-green-300 text-green-700 rounded-lg py-2 text-sm font-medium">🟢 WhatsApp</button>
          <button onClick={async () => { await queueJob('payslip', { code, month: mk }, user.email); alert('Sent to Telegram.'); }} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">✈️ Telegram</button>
        </div>
      </div>

      {emp.type !== 'daily' && (
        <SettleLockCard pay={pay} md={md} busy={busy} onLock={doLock} onUnlock={doUnlock} />
      )}

      {emp.type !== 'daily' && otDetail.length > 0 && (
        <DaysOtCard detail={otDetail} overrides={md.dayOverrides || {}} otCredits={md.otCredits || {}} presentAdjust={Math.round((presentAdjust + satAdjust) * 100) / 100} locked={locked} busy={busy} onSetDay={setDay} onCreditOt={creditOt} />
      )}

      {!locked && (
        <div className="bg-white rounded-xl shadow p-3 space-y-1">
          <div className="text-sm font-semibold text-gray-700">Adjust this month</div>
          {pay.type !== 'daily' && (portalOt > 0 || appOt > 0) && (
            <div className="flex items-center justify-between py-1 border-b mb-1">
              <span className="text-sm">Overtime to pay
                <span className="text-gray-500"> — Actual {portalOt}h · App {appOt}h{Math.abs(portalOt - appOt) >= 0.5 ? ' ⚠' : ''}</span>
              </span>
              <div className="flex gap-1">
                <button disabled={busy} onClick={() => act(() => saveMonth(code, mk, { otSource: 'portal' }))}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${otSource === 'portal' ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600'}`}>Actual</button>
                <button disabled={busy} onClick={() => act(() => saveMonth(code, mk, { otSource: 'app' }))}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${otSource === 'app' ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600'}`}>App</button>
              </div>
            </div>
          )}
          {pay.type !== 'daily' && pay.perfectEligible && (
            <label className="flex items-center justify-between py-1 bg-green-50 border border-green-200 rounded-lg px-2">
              <span className="text-sm">🎯 Full-attendance bonus <span className="text-gray-500">(zero absent → +1 day = {rupee(pay.perfectBonusDay)})</span></span>
              <input type="checkbox" className="w-5 h-5" checked={!!md.perfectBonusPaid} disabled={busy} onChange={(e) => act(() => saveMonth(code, mk, { perfectBonusPaid: e.target.checked }))} />
            </label>
          )}
          {pay.type !== 'daily' && graceDelta > 0 && (
            <label className="flex items-center justify-between py-1">
              <span className="text-sm">⏱ Pay 15-min grace <span className="text-gray-500">(+{graceDelta} day = {rupee(pay.perDay * graceDelta)})</span></span>
              <input type="checkbox" className="w-5 h-5" checked={!!md.gracePaid} disabled={busy} onChange={(e) => act(() => saveMonth(code, mk, { gracePaid: e.target.checked }))} />
            </label>
          )}
          {pay.type !== 'daily' && <NumRow label={`Give back Saturdays${pay.saturdaysCut > 0 ? ` (${pay.saturdaysCut} cut · ${rupee(pay.perDay)}/day)` : ` (${rupee(pay.perDay)}/day)`}`} val={md.restoreSaturdays} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { restoreSaturdays: v }))} />}
          <NumRow label="Bonus ₹" val={md.bonus} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { bonus: v }))} />
          <NumRow label="Fine ₹" val={md.fine} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { fine: v }))} />
          <p className="text-[11px] text-gray-500 pt-1">Advances are cut automatically in full at Settle — give an advance in the ledger below; it adds to this worker's account and the whole balance is squared off when you lock the month.</p>
        </div>
      )}

      <Ledger title="💸 Advances" withMode items={(emp.advances || []).map((a) => ({ d: a.date, t: `${a.mode}${a.remark ? ' · ' + a.remark : ''}${a.paidBy ? ' · by ' + String(a.paidBy).split('@')[0] : ''}`, v: rupee(a.amount) }))}
        submit="Add advance" busy={busy || locked} defDate={today}
        onAdd={(f) => act(() => addAdvance(code, { date: f.date, mode: f.mode, amount: Number(f.amount), remark: f.remark || '', paidBy: user.email }))} />

      <Ledger title="📈 Increments" items={(emp.increments || []).map((i) => ({ d: i.effective, t: i.remark || '', v: '+' + rupee(i.amount), green: true }))}
        submit="Add increment (from that date onward)" busy={busy || locked} defDate={mk + '-01'}
        onAdd={(f) => act(() => addIncrement(code, { amount: Number(f.amount), effective: f.date, remark: f.remark || '' }))} />

      <PaymentsHistory emp={emp} />

      <CorrectionsLog emp={emp} />

      <SalaryEdit emp={emp} busy={busy}
        onSave={(patch) => act(() => saveEmployee(code, patch))}
        onSaveNameDept={(nd) => act(() => editNameDept(code, nd, user.email))} />

      {emp.active !== false ? (
        <button disabled={busy || locked} onClick={async () => {
          const last = prompt(`Final settlement for ${emp.name}.\nLast working day (YYYY-MM-DD):`, today);
          if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last)) { if (last != null) alert('Enter the date as YYYY-MM-DD.'); return; }
          // recompute pay capped at the last working day (prorates a mid-month exit)
          const sp = payFor({ ...emp, exitDate: last }, attMap, mk, ctx).pay;
          const net = sp.net;
          if (!confirm(`Final settlement for ${emp.name}:\n\n` +
            `Days: ${sp.presentDays} present / ${sp.absentDays} absent\n` +
            `Base ₹${sp.base} + OT ₹${sp.otPay}` + (sp.perfectBonus ? ` + bonus ₹${sp.perfectBonus}` : '') + (sp.bonus ? ` + bonus ₹${sp.bonus}` : '') + '\n' +
            (sp.advanceRecovered ? `− Advance ₹${sp.advanceRecovered}\n` : '') +
            `\nFINAL PAYABLE: ₹${net.toLocaleString('en-IN')}\n\n` +
            `This pays & locks ${mk}, removes the worker (last day ${last}). Continue?`)) return;
          const pw = prompt('Enter the action password to confirm:');
          if (pw == null) return;
          const ok = await checkActionPassword(pw);
          if (ok === 'unset') { if (!confirm('No action password set yet (set one in ⚙ Settings). Settle & resign anyway?')) return; }
          else if (!ok) { alert('Wrong password.'); return; }
          act(() => settleAndResign(code, mk, sp, last, user.email));
        }} className="w-full border border-red-200 text-red-700 rounded-lg py-2 text-sm disabled:opacity-40">Final settlement &amp; resign {emp.name}</button>
      ) : (
        <div className="text-center text-xs text-gray-400">
          Resigned {emp.resignedAt || emp.exitDate || ''}{md.payment?.settlement ? ` · final settled ${rupee(md.payment.net)}` : ''}
        </div>
      )}
    </div>
  );
}

// Cashier settle: shows salary + opening balance = payable; owner enters cash + account paid and
// LOCKS the month (freezes it, carries the balance to next month). Unlock reopens it. Reason required.
function SettleLockCard({ pay, md, busy, onLock, onUnlock }) {
  const [cash, setCash] = useState('');
  const [account, setAccount] = useState('');
  const opening = pay.openingBalance || 0;
  const payable = pay.payable || 0;
  const advCut = pay.advanceRecovered || 0;                 // full outstanding advance, auto-cut at settle
  const salaryThisMonth = Math.round(((pay.net || 0) + advCut) * 100) / 100;  // earnings − fines, before advance
  const paid = (Number(cash) || 0) + (Number(account) || 0);
  const closing = Math.round((payable - paid) * 100) / 100;
  if (md.locked) {
    const p = md.payment || {};
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl shadow p-4">
        <div className="font-bold text-green-800">🔒 Locked</div>
        <Row k="Paid" v={`${rupee(p.net)} (cash ${rupee(p.cash)} + account ${rupee(p.account)})`} />
        <Row k="Payable was" v={rupee(p.payable)} />
        <Row k="Balance carried" v={`${(p.closing || 0) >= 0 ? '+' : ''}${rupee(p.closing)} → next month`} />
        <p className="text-xs text-gray-500 mt-1">{p.date} · by {String(p.by || '').split('@')[0]}{p.reason ? ` · “${p.reason}”` : ''}</p>
        <button disabled={!!busy} onClick={() => { const r = prompt('Unlock this month to edit?\nReason (required):'); if (r == null) return; if (!r.trim()) return alert('Reason required.'); onUnlock(r.trim()); }}
          className="mt-2 text-xs border border-red-300 text-red-700 rounded-lg px-3 py-1.5 disabled:opacity-50">🔓 Unlock to edit</button>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-2">
      <div className="font-bold text-gray-800">💵 Settle &amp; lock</div>
      <div className="flex justify-between text-sm"><span className="text-gray-500">Salary this month</span><span className="text-gray-800">{rupee(salaryThisMonth)}</span></div>
      {advCut > 0 && <div className="flex justify-between text-sm"><span className="text-gray-500">− Advance (full)</span><span className="text-amber-700">{rupee(advCut)}</span></div>}
      {opening !== 0 && <div className="flex justify-between text-sm"><span className="text-gray-500">Carried balance</span><span className={opening > 0 ? 'text-red-700' : 'text-green-700'}>{opening > 0 ? '+' : ''}{rupee(opening)} {opening > 0 ? '(owed to him)' : '(he owes)'}</span></div>}
      <div className="flex justify-between text-base font-bold border-t pt-1"><span>{payable >= 0 ? 'Payable now' : 'He owes'}</span><span className={payable >= 0 ? 'text-red-700' : 'text-green-700'}>{rupee(Math.abs(payable))}</span></div>
      <div className="grid grid-cols-2 gap-2 pt-1">
        <label className="text-xs text-gray-500">Cash paid ₹<input type="number" value={cash} onChange={(e) => setCash(e.target.value)} className="mt-0.5 w-full border rounded-lg px-2 py-2 text-base font-bold text-gray-800" /></label>
        <label className="text-xs text-gray-500">Account paid ₹<input type="number" value={account} onChange={(e) => setAccount(e.target.value)} className="mt-0.5 w-full border rounded-lg px-2 py-2 text-base font-bold text-gray-800" /></label>
      </div>
      <p className="text-xs text-gray-600">{paid > 0 ? `Paying ${rupee(paid)} → ` : 'Paying nothing → '}balance <b className={closing >= 0 ? 'text-red-700' : 'text-green-700'}>{closing >= 0 ? '+' : ''}{rupee(closing)}</b> {closing >= 0 ? 'stays owed to him' : 'he owes us'}, carries to next month.</p>
      <button disabled={!!busy} onClick={() => { const r = prompt(`Lock this month?\nPayable ₹${payable} · paying ₹${paid} (cash ${Number(cash) || 0} + account ${Number(account) || 0}) · balance ₹${closing} carries.\n\nReason (required):`); if (r == null) return; if (!r.trim()) return alert('Reason is required to lock.'); onLock(Number(cash) || 0, Number(account) || 0, r.trim()); }}
        className="w-full bg-green-700 text-white rounded-xl py-3 font-semibold disabled:opacity-50">🔒 Lock month</button>
    </div>
  );
}

// Per-day in/out + OT, with a Full / Half / Absent picker per working day so the OWNER decides
// borderline days at pay time (missing punch still earns 0 OT — never restored). Saturdays & OT unaffected.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayDefault = (d) => (d.kind === 'half' ? 'half' : d.kind === 'absent' ? 'absent' : 'full');  // single = full
function DaysOtCard({ detail, overrides = {}, otCredits = {}, presentAdjust = 0, locked, busy, onSetDay, onCreditOt }) {
  const [open, setOpen] = useState(false);
  const missing = detail.filter((d) => d.missing);
  const totalOt = detail.reduce((s, d) => s + (d.ot || 0), 0);
  const lbl = (ymd) => ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + ' ' + DOW[new Date(ymd + 'T00:00:00').getDay()];
  const isSat = (d) => ['weekly-off', 'sat-worked', 'sat-absent'].includes(d.kind);
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setOpen(!open)} className="w-full flex justify-between items-center text-sm font-semibold text-gray-700">
        <span>📅 Days &amp; overtime{missing.length ? <span className="text-amber-600 font-normal"> · {missing.length} missing</span> : ''}{presentAdjust !== 0 ? <span className="text-indigo-600 font-normal"> · {presentAdjust > 0 ? '+' : ''}{presentAdjust}d adjusted</span> : ''}</span>
        <span className="text-gray-500 font-normal">{totalOt.toFixed(1)}h OT {open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-0.5">
          <p className="text-[10px] text-gray-400">Tap <b>Full / ½ / Abs</b> to set a working day for pay. Missing-punch days pay 0 OT. Saturdays follow the weekly-off rule.</p>
          {detail.map((d) => {
            if (isSat(d)) {
              const defPaid = d.kind === 'sat-absent' ? 'nopay' : 'pay';
              const cur = overrides[d.ymd] || defPaid;
              const overridden = !!overrides[d.ymd];
              const desc = d.kind === 'sat-worked' ? 'Sat worked (OT)' : d.kind === 'weekly-off' ? 'weekly off' : 'Sat — not earned';
              return (
                <div key={d.ymd} className={`text-xs px-2 py-1 rounded ${overridden ? 'bg-indigo-50' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-blue-500">{lbl(d.ymd)}</span>
                    <span className="flex-1 text-gray-400">{d.in ? `${d.in} → ${d.out || 'no out'} · ` : ''}{desc}</span>
                    <span className="w-12 text-right text-gray-500">{d.ot > 0 ? '+' + d.ot + 'h' : ''}</span>
                  </div>
                  <div className="flex gap-1 mt-1 ml-16 items-center">
                    {[['pay', 'Pay'], ['nopay', 'No pay']].map(([v, t]) => (
                      <button key={v} disabled={busy || locked} onClick={() => onSetDay(d.ymd, cur === v ? null : v)}
                        className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? 'bg-blue-700 text-white font-semibold' : 'border border-gray-200 text-gray-500'} disabled:opacity-50`}>{t}</button>
                    ))}
                    {overridden && <span className="text-[10px] text-indigo-600">was {defPaid === 'pay' ? 'paid' : 'not paid'}</span>}
                  </div>
                </div>
              );
            }
            const hasPunch = !!(d.in || d.out);
            const cur = overrides[d.ymd] || dayDefault(d);
            const overridden = !!overrides[d.ymd];
            return (
              <div key={d.ymd} className={`text-xs px-2 py-1 rounded ${d.missing ? 'bg-amber-50' : overridden ? 'bg-indigo-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="w-16 text-gray-600">{lbl(d.ymd)}</span>
                  <span className="flex-1 text-gray-500">{d.missing ? <span className="text-amber-700">⚠ missing {d.missing === 'in' ? 'IN' : 'OUT'} · {d.in}</span> : hasPunch ? `${d.in || '—'} → ${d.out || '—'}` : <span className="text-red-400">absent</span>}</span>
                  <span className={`w-12 text-right ${d.ot > 0 ? 'text-gray-800' : 'text-gray-300'}`}>{d.ot > 0 ? '+' + d.ot + 'h' : '—'}</span>
                </div>
                {hasPunch && (
                  <div className="flex gap-1 mt-1 ml-16 items-center flex-wrap">
                    {[['full', 'Full'], ['half', '½'], ['absent', 'Abs']].map(([v, t]) => (
                      <button key={v} disabled={busy || locked} onClick={() => onSetDay(d.ymd, cur === v ? null : v)}
                        className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? 'bg-red-700 text-white font-semibold' : 'border border-gray-200 text-gray-500'} disabled:opacity-50`}>{t}</button>
                    ))}
                    {overridden && <span className="text-[10px] text-indigo-600">was {dayDefault(d)}</span>}
                    {d.missing && d.otIfFixed > 0 && (() => { const credited = otCredits[d.ymd] != null; return (
                      <button disabled={busy || locked} onClick={() => onCreditOt(d.ymd, credited ? null : d.otIfFixed)}
                        className={`ml-1 px-2 py-0.5 rounded text-[11px] ${credited ? 'bg-green-700 text-white font-semibold' : 'border border-green-300 text-green-700'} disabled:opacity-50`}>
                        {credited ? `✓ OT +${otCredits[d.ymd]}h` : `Credit OT +${d.otIfFixed}h`}</button>
                    ); })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// log + entry form: every advance/increment goes in with date, amount, (mode) and remark
function Ledger({ title, items, withMode, submit, onAdd, busy, defDate }) {
  const [f, setF] = useState({ amount: '', mode: 'cash', remark: '', date: defDate });
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">{title} ({items.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
        {items.length === 0 && <li className="text-gray-400 py-1">None yet</li>}
        {[...items].reverse().map((x, i) => <li key={i} className="py-1 flex justify-between"><span>{x.d}{x.t ? ' · ' + x.t : ''}</span><b className={x.green ? 'text-green-700' : ''}>{x.v}</b></li>)}
      </ul>
      <div className="grid grid-cols-2 gap-1.5 mt-2">
        <input className="border rounded px-2 py-1.5 text-sm" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input className="border rounded px-2 py-1.5 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        {withMode && <select className="border rounded px-2 py-1.5 text-sm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="cash">Cash</option><option value="account">Bank</option></select>}
        <input className={`border rounded px-2 py-1.5 text-sm ${withMode ? '' : 'col-span-2'}`} placeholder="Remark (optional)" value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
        <button disabled={busy || !Number(f.amount) || !f.date} onClick={() => { onAdd(f); setF({ amount: '', mode: 'cash', remark: '', date: defDate }); }}
          className="col-span-2 bg-gray-800 text-white rounded py-1.5 text-xs font-medium disabled:opacity-40">{submit}</button>
      </div>
    </div>
  );
}

// read-only log of every salary payment made to this person
function PaymentsHistory({ emp }) {
  const rows = Object.entries(emp.months || {})
    .filter(([, m]) => m && m.payment)
    .map(([mk, m]) => ({ mk, ...m.payment }))
    .sort((a, b) => (a.mk < b.mk ? 1 : -1));
  if (!rows.length) return null;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">🧾 Salary payments ({rows.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
        {rows.map((p) => (
          <li key={p.mk} className="py-1 flex justify-between">
            <span>{p.mk} · paid {p.date} · {p.mode}{p.bank != null ? ` (bank ${rupee(p.bank)} + cash ${rupee(p.cash)})` : ''}{p.by ? ' · by ' + String(p.by).split('@')[0] : ''}</span>
            <b>{rupee(p.net)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// permanent log of attendance corrections (written by the worker on each manual punch)
function CorrectionsLog({ emp }) {
  const rows = [...(emp.corrections || [])].reverse();
  if (!rows.length) return null;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">📝 Attendance corrections ({rows.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-44 overflow-auto">
        {rows.map((c, i) => (
          <li key={i} className="py-1">
            <div className="flex justify-between"><span className="font-medium">{c.date}</span><span className="text-gray-500">{c.in ? 'in ' + c.in : ''}{c.in && c.out ? ' · ' : ''}{c.out ? 'out ' + c.out : ''}</span></div>
            <div className="text-gray-500">{c.reason || ''}{c.by ? ' · by ' + String(c.by).split('@')[0] : ''}{c.at ? ' · ' + c.at.slice(0, 16).replace('T', ' ') : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SalaryEdit({ emp, onSave, onSaveNameDept, busy }) {
  const [show, setShow] = useState(false);
  const DEPTS = ['FITTING', 'Frame', 'HELPER', 'POWDER', 'PRESS', 'T', 'DEMO'];
  const [f, setF] = useState({
    type: emp.type || 'monthly', amount: emp.type === 'daily' ? emp.wage : emp.amount, shift: emp.shift || 'GEN',
    phone: emp.phone || '', joinDate: emp.joinDate || '', nickname: emp.nickname || '',
  });
  const [nd, setNd] = useState({ name: emp.name || '', dept: emp.dept || '' });
  const ndChanged = nd.name !== (emp.name || '') || nd.dept !== (emp.dept || '');
  const onMachine = !emp.appOnly && emp.onMachine !== false;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-700">⚙ Salary &amp; profile {show ? '▲' : '▼'}</button>
      {show && (
        <div className="space-y-3 mt-2">
          {/* Name + Department — corrections here are pushed to the biometric machine too */}
          <div className="border rounded-lg p-2">
            <div className="text-xs text-gray-500 mb-1">Name &amp; department {onMachine ? '(also updated on the machine)' : '(app-only worker)'}</div>
            <input className="border rounded px-2 py-2 text-sm w-full mb-1.5" placeholder="Full name" value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} />
            <select className="border rounded px-2 py-2 text-sm w-full" value={nd.dept} onChange={(e) => setNd({ ...nd, dept: e.target.value })}>
              <option value="">— department —</option>
              {[...new Set([emp.dept, ...DEPTS].filter(Boolean))].map((d) => <option key={d}>{d}</option>)}
            </select>
            <button disabled={busy || !ndChanged} onClick={() => onSaveNameDept({ name: nd.name, dept: nd.dept })}
              className="mt-1.5 w-full bg-gray-800 text-white rounded py-1.5 text-xs font-medium disabled:opacity-40">
              {onMachine ? 'Save & push to machine' : 'Save name/dept'}
            </button>
          </div>
          {/* Salary / profile (app-only — not on the machine) */}
          <div className="grid grid-cols-3 gap-2">
            <select className="border rounded px-2 py-2 text-sm" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="monthly">Monthly</option><option value="daily">Daily</option>
            </select>
            <input className="border rounded px-2 py-2 text-sm" type="number" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <select className="border rounded px-2 py-2 text-sm" value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>
              {['GEN', '10H', '12H', 'wir', 'DSG'].map((s) => <option key={s}>{s}</option>)}
            </select>
            <input className="border rounded px-2 py-2 text-sm col-span-3" placeholder="Nickname (e.g. Raju Chrome line)" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
            <input className="border rounded px-2 py-2 text-sm col-span-2" placeholder="📞 Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <input className="border rounded px-2 py-2 text-sm" type="date" title="Joining date" value={f.joinDate} onChange={(e) => setF({ ...f, joinDate: e.target.value })} />
            <button disabled={busy} onClick={() => onSave({
              ...(f.type === 'daily' ? { type: 'daily', wage: Number(f.amount) } : { type: 'monthly', amount: Number(f.amount) }),
              shift: f.shift, phone: f.phone, joinDate: f.joinDate, nickname: f.nickname,
            })} className="col-span-3 bg-gray-800 text-white rounded py-1.5 text-xs font-medium">Save salary &amp; profile</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) { return <div className="flex justify-between text-sm py-0.5"><span className="text-gray-500">{k}</span><span className="text-gray-800">{v}</span></div>; }
function NumRow({ label, val, onSave, disabled }) {
  const [v, setV] = useState(val ?? 0);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 flex-1">{label}</span>
      <input className="border rounded px-2 py-1 w-24 text-right text-sm" type="number" value={v} onChange={(e) => setV(e.target.value)} disabled={disabled} />
      <button disabled={disabled} onClick={() => onSave(Number(v))} className="text-xs bg-gray-800 disabled:opacity-40 text-white rounded px-2 py-1">Set</button>
    </div>
  );
}
