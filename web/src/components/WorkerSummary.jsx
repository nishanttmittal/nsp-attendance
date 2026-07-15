import { rupee } from '../lib/paycalc';

// Compact attendance + money summary for ONE worker/month — the same figures shown on the Person
// page, extracted so the Salary list can show them inline (no need to open each worker).
// `r` is a payFor() row (emp, att, pay, md, detail, advs, rawLate, lateFixed, otSource).
// `disp` (optional) = snapshot-aware pay (Person passes dispPay so a locked month reads its stored
// advance/fine/bonus); the list omits it and reads live `pay`.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;

export default function WorkerSummary({ r, mk, disp }) {
  const { emp, att, pay, md, detail: otDetail = [], advs = [], rawLate = 0, lateFixed = 0, otSource = 'portal' } = r;
  if (pay.noAttendance || emp.type === 'daily') return null;
  // For a LOCKED month, read money fields from the stored snapshot (never recompute under today's rules).
  // Locked-without-snapshot (e.g. June) → zero the advance so it can't show a recomputed outstanding.
  const snap = md && md.payment && md.payment.breakdown ? md.payment.breakdown : null;
  const isLocked = !!(md && (md.locked || md.payment));
  const d = disp || (snap ? { ...pay, ...snap } : isLocked ? { ...pay, advanceRecovered: 0, advanceDue: 0 } : pay);
  const joinedThisMonth = (emp.joinDate || '').startsWith(mk);
  const fromYmd = joinedThisMonth ? emp.joinDate : null;
  const keep = (x) => !fromYmd || x.ymd >= fromYmd;
  const MON = MONTHS[Number(mk.slice(5, 7)) - 1];
  const dates = (list) => list.map((x) => Number(x.ymd.slice(8, 10))).join(', ');
  const absentD = otDetail.filter((x) => x.kind === 'absent' && keep(x));
  const halfD = otDetail.filter((x) => x.kind === 'half' && keep(x));
  const missedD = otDetail.filter((x) => (x.single || x.missing) && keep(x));
  const joinDayLabel = joinedThisMonth ? `${Number(emp.joinDate.slice(8, 10))} ${MON}` : null;
  const extraDays = Math.round(((d.perfectBonus > 0 ? 1 : 0) + (d.restoreSaturdayDays || 0) + (d.graceDays || 0)) * 100) / 100;
  const bonusEligibleUnpaid = pay.perfectEligible && !(d.perfectBonus > 0);
  const lateTimes = att.lateDays || 0;
  const lateHrsEff = otSource === 'app' ? 0 : Math.max(0, r1(rawLate) - r1(lateFixed));
  const earlyHrsEff = otSource === 'app' ? 0 : r1(att.earlyHrs || 0);
  const showLate = lateTimes > 0 || lateHrsEff > 0 || earlyHrsEff > 0;
  const workedSat = pay.weeklyOffPresent || 0;
  const satCut = pay.saturdaysCut || 0;
  const advLines = advs.map((a) => `${rupee(a.amount)} on ${Number((a.date || '').slice(8, 10))} ${MON}`).join(', ');
  const paidDaysN = pay.paidDays || 0;
  const holidayN = pay.holiday || 0;
  const prevBal = Math.round((pay.openingBalance || 0) * 100) / 100;   // + = owed to worker, − = he owes
  const fineAmt = d.fines || 0;
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 mt-1 text-sm text-gray-800">
      <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{MON} {mk.slice(0, 4)} — attendance{joinDayLabel ? ` · joined ${joinDayLabel}` : ''}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <span>Present <b>{pay.presentDays}</b></span>
        <span>Weekly-off <b>{pay.weeklyOffAll}</b></span>
        <span>Holiday <b>{holidayN}</b></span>
        <span>Extra day <b className={extraDays ? 'text-green-700' : ''}>{extraDays}</b>{bonusEligibleUnpaid ? <span className="text-[11px] text-green-600"> (+1 eligible)</span> : ''}</span>
        <span>Paid days <b>{paidDaysN}</b></span>
        <span>Overtime <b>{pay.otHrsNet}h</b></span>
      </div>
      <div className="border-t border-slate-200 mt-1.5 pt-1.5 space-y-0.5">
        <div>Absent <b className={absentD.length ? 'text-red-600' : ''}>{absentD.length}</b>{absentD.length ? <span className="text-gray-500"> — {dates(absentD)} {MON}</span> : ''}</div>
        <div>Half-day <b>{halfD.length}</b>{halfD.length ? <span className="text-gray-500"> — {dates(halfD)} {MON}</span> : ''}</div>
        <div>Missed punch <b className={missedD.length ? 'text-amber-600' : ''}>{missedD.length}</b>{missedD.length ? <span className="text-gray-500"> — {dates(missedD)} {MON}</span> : ''}</div>
        {showLate && <div>Late <b>{lateTimes}×</b>{lateHrsEff > 0 ? ` · ${lateHrsEff}h` : ''}{earlyHrsEff > 0 ? ` · early ${earlyHrsEff}h` : ''}{(lateHrsEff > 0 || earlyHrsEff > 0) ? <span className="text-gray-400"> (cut from OT)</span> : ''}</div>}
        {(workedSat > 0 || satCut > 0) && <div>{workedSat > 0 ? <>Worked Sat <b>{workedSat}</b> <span className="text-gray-400">(paid in OT)</span></> : null}{workedSat > 0 && satCut > 0 ? ' · ' : ''}{satCut > 0 ? <>Sat cut <b className="text-red-600">{satCut}</b> <span className="text-gray-400">(low attendance)</span></> : null}</div>}
      </div>
      <div className="border-t border-slate-200 mt-1.5 pt-1.5 space-y-0.5">
        {prevBal !== 0 && <div>Previous balance <b className={prevBal >= 0 ? 'text-green-700' : 'text-red-600'}>{rupee(Math.abs(prevBal))}</b> <span className="text-gray-400">({prevBal >= 0 ? 'owed to you' : 'you owe'})</span></div>}
        {fineAmt > 0 && <div>Fine <b className="text-red-600">−{rupee(fineAmt)}</b></div>}
        {advs.length > 0 && <div className="text-gray-600">Advance this month: {advLines}</div>}
        {(d.advanceDue || 0) > 0
          ? <div className="flex items-center justify-between mt-1 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
              <span className="font-semibold text-amber-800">💰 Advance carried forward</span>
              <b className="text-lg text-amber-800">{rupee(d.advanceDue)}</b>
            </div>
          : <div>Advance outstanding <b className="text-gray-500">₹0</b></div>}
      </div>
    </div>
  );
}
