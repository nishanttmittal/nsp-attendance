// Salary calculation engine (shared by the PWA later). Pure functions + a CLI that
// joins Realtime attendance (parsed monthly summary) with the salary config.
//   CONFIG=salary_config.sample.json  MONTH=0
// Model (month-to-date, "till previous day"):
//   perDay   = monthly ? amount/daysInMonth : wage
//   monthly base = perDay × (elapsedDays − absentDays)   (offs/holidays in elapsed period are PAID)
//   daily   base = wage × presentDays
//   OT pay  = otHrs × otRatePerHr   (otHrs = Realtime's Working−Shift; see note in report)
//   perfect-attendance bonus: full month + zero absence → +1 day pay
//   excess-absence penalty: floor(absentDays/3) weekly-offs docked — SUGGESTED only, confirm before applying
//   net = base + otPay − advances + bonus     (penalty shown separately, not auto-applied)
// Increment: salary amount/wage effective on or before the calc end-date is used.
const path = require('path');
const fs = require('fs');
const { parseSummary, range } = require('./salaryData');

const CONFIG = process.env.CONFIG || 'salary_config.sample.json';
const MONTH = parseInt(process.env.MONTH || '0', 10);
const round = n => Math.round(n * 100) / 100;

// Net work hours per shift (rulebook §3) — used to derive the normal hourly rate for OT (paid 1×).
// DSG (designer) = 09:00–19:00 with the 13:00–13:30 lunch INSIDE the shift → 10 h (owner 2026-07-28).
// KEEP IN SYNC with web/src/lib/payroll.js.
const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10, DSG: 10 };

// Effective pay on `toDate` = base + sum of increment deltas effective on/before that date.
// Each increment is an ADDED amount (e.g. +1000), recorded with effective date + remark.
function effectiveAmount(emp, toDate) {
  // Number() is load-bearing: a rate saved as TEXT ("15000") would otherwise CONCATENATE with the
  // increment ("15000"+1000 = "150001000") and produce an eight-figure salary. Owner 2026-07-28:
  // guard here AND reject non-numeric rates on save. KEEP IN SYNC with web/src/lib/payroll.js.
  const base = emp.type === 'daily' ? Number(emp.wage || 0) : Number(emp.amount || 0);
  let amount = base, lastRemark = null, raised = 0;
  for (const inc of (emp.increments || [])) {
    if (new Date(inc.effective) <= toDate) {
      amount += Number(inc.amount || 0);
      raised += Number(inc.amount || 0);
      lastRemark = inc.remark || lastRemark;
    }
  }
  return { amount, remark: raised ? `+${raised}${lastRemark ? ' ' + lastRemark : ''}` : null };
}

const DAY = 86400000;
// core calc for one employee — exported for the PWA to reuse
// `advances` (ledger array) and `advancesThisMonth` (pre-summed number) are BOTH accepted: the web
// engine's signature uses the latter, and two live callers (jobs/worker.js, jobs/lib/payslipText.js)
// were written against it — with `advances` undefined this function threw on every Telegram payslip.
function computePay({ emp, att, daysInMonth, elapsedDays, fullMonth, advances = [], advancesThisMonth = null, advanceBalanceIn = 0, advanceRecover = 0, fines = 0, loanInstallment = 0, bonus = 0, restoreSaturdayDays = 0, graceDays = 0, payPerfectBonus = false, latePenaltyDays = 0, weeklyOffDockDays = 0, monthStart, toDate }) {
  const eff = effectiveAmount(emp, toDate);
  const rate = eff.amount;
  const perDay = emp.type === 'daily' ? rate : rate / daysInMonth;
  // prorate the payable window to the employee's join/exit dates (no false absences for joiners/leavers)
  let effElapsed = elapsedDays;
  if (monthStart && toDate) {
    let start = monthStart, end = toDate;
    if (emp.joinDate) { const j = new Date(emp.joinDate); if (j > start) start = j; }
    if (emp.exitDate) { const x = new Date(emp.exitDate); if (x < end) end = x; }
    effElapsed = Math.max(0, Math.round((end - start) / DAY) + 1);
  }
  // Owner rule (2026-06-14): a Saturday worked in a week that didn't earn the weekly-off
  // (<4 present days that week) is paid as OT only — the day stays absent. att.unpaidWorkedSat
  // (from the daily weekly-off audit) reduces paid days but NOT OT.
  const unpaidSat = emp.type === 'daily' ? 0 : Number(att.unpaidWorkedSat || 0);
  // Absents for BASE are capped to the employment window (web fix 2026-07-18, ported here
  // 2026-07-28): the portal counts WHOLE-MONTH absents, so a mid-month joiner/leaver had
  // out-of-window days counted absent and base collapsed to ₹0. In-window absents can never
  // exceed effElapsed − presentDays. min() deliberately keeps a NEGATIVE override-absent intact.
  const absentForBase = Math.min(Number(att.absentDays || 0), Math.max(0, effElapsed - (att.presentDays || 0)));
  // Daily-wager pay = wage × equivalent-days (owner rule 2026-07-22): machine daily = actual working
  // hours ÷ standard-day hours (11) → pay scales by the hour at 1×; workHrs includes OT hours
  // (so netOtHrs=0 below). appOnly = Σ min(hrs,11)/11; override presets equivalentDays.
  // Portal "Total Work" is RAW first-in→last-out — it never deducts the LOD 13:00–13:30 lunch
  // (verified 2026-07-24). Owner rule: ₹700 = 11 WORKING hours, lunch unpaid → deduct 30 min per
  // present day here. KEEP IN SYNC with web/src/lib/payroll.js.
  const dailyStdHrs = Number(emp.stdHours) || 11;
  const lunchDeductHrs = 0.5 * (att.presentDays || 0);
  const dailyEquivDays = att.equivalentDays != null ? att.equivalentDays
    : Math.max(0, (att.workHrs || 0) - lunchDeductHrs) / dailyStdHrs;
  const base = emp.type === 'daily'
    ? rate * dailyEquivDays
    // No attendance record for the month = joined later → pay ₹0, NEVER a silent full month
    // (owner 2026-07-10; ported from web 2026-07-28).
    : att.noRecord ? 0
    : perDay * Math.max(0, effElapsed - absentForBase - unpaidSat);
  // net OT = Realtime OT (capped Working−Shift) minus late/early shortfall; can go negative.
  // Daily-wagers (owner rule 2026-07-22): FLAT daily wage only — OT hours never add pay.
  // appOnly (manually-entered) workers have no biometric feed, so there is no portal OT to pay
  // (ported from web 2026-07-28).
  const netOtHrs = (emp.appOnly || emp.type === 'daily') ? 0 : Math.max(0, (att.otHrs || 0) - (att.lateHrs || 0) - (att.earlyHrs || 0)); // floored at 0
  // OT paid at NORMAL 1× rate = perDay / shift-hours. (Saturday-worked hours flow in via Realtime's OT.)
  const shiftHrs = SHIFT_HOURS[emp.shift] || 8;
  const hourlyRate = perDay / shiftHrs;
  const otPay = netOtHrs * hourlyRate;
  // perfect attendance bonus (complete month, zero absence; lateness does not disqualify)
  // full-month, zero-absence bonus — NOT for mid-month joiners/leavers (prorated window)
  // full-attendance bonus is OWNER-CONTROLLED now (owner 2026-07-13): eligible on zero-absence, paid only when opted in
  const perfectEligible = fullMonth && att.absentDays === 0 && att.presentDays > 0 && effElapsed === daysInMonth;
  const perfectBonus = (perfectEligible && payPerfectBonus) ? perDay : 0;
  // excess-absence weekly-off dock: every 3 absent days → 1 off — SUGGESTED, confirm before applying
  const penaltyDays = Math.floor(att.absentDays / 3);
  const suggestedPenalty = round(perDay * penaltyDays);
  // deductions: fines + loan installment, then OWNER-CHOSEN advance recovery (default 0 = pay full salary).
  // Advances are a running balance: new advances given this month + prior balance, minus what's recovered.
  // Paying a worker who still owes simply carries the balance forward; extra cash given = a new advance.
  const latePenalty = round(perDay * Number(latePenaltyDays || 0)); // 0.25 (=25%) or 0.5 (=50%) of a day
  const weeklyOffDock = round(perDay * Number(weeklyOffDockDays || 0)); // 3 absences = 1 Saturday cut
  // Owner goodwill adjustments (ported from web 2026-07-28) — additive earnings only; they do NOT
  // change attendance, paid days or the Saturday-cut count.
  //  · restoreSaturdayDays: owner leniently pays back N cut Saturdays at one day each (2026-07-08)
  //  · graceDays: the 15-min grace top-up, opted in per worker (2026-07-09)
  const restoreSatDays = emp.type === 'daily' ? 0 : Number(restoreSaturdayDays || 0);
  const restoreSaturdayPay = round(perDay * restoreSatDays);
  const graceDaysN = emp.type === 'daily' ? 0 : Number(graceDays || 0);
  const gracePay = round(perDay * graceDaysN);
  const earnings = base + otPay + perfectBonus + restoreSaturdayPay + gracePay + Number(bonus || 0);
  // ONE advance account (owner 2026-07-13): loans folded into advances; the FULL outstanding advance is
  // cut at settle into a signed running balance (negative = worker owes; carries forward). Match web/payroll.js.
  const fixedDeductions = Number(fines || 0) + latePenalty + weeklyOffDock;
  // Accept either the ledger array or a pre-summed number (see the signature note above).
  const advThisMonth = advancesThisMonth != null
    ? Number(advancesThisMonth || 0)
    : (advances || []).reduce((s, a) => s + Number(a.amount || 0), 0);
  const advanceDue = advThisMonth + advanceBalanceIn;
  const advanceRecovered = advanceDue;
  return {
    type: emp.type, effectiveRate: rate, effectiveRemark: eff.remark,
    presentDays: att.presentDays, absentDays: att.absentDays, payableDays: effElapsed,
    unpaidWorkedSat: unpaidSat,
    otHrs: round(att.otHrs), otHrsNet: round(netOtHrs),
    base: round(base), otPay: round(otPay), perfectBonus: round(perfectBonus), bonus: round(Number(bonus || 0)),
    fines: round(Number(fines || 0)), loanInstallment: round(Number(loanInstallment || 0)),
    latePenalty: round(latePenalty), latePenaltyDays: Number(latePenaltyDays || 0),
    weeklyOffDock: round(weeklyOffDock), weeklyOffDockDays: Number(weeklyOffDockDays || 0),
    advanceDue: round(advanceDue), advanceRecovered: round(advanceRecovered),
    advanceBalanceCarried: 0,   // advance always fully cut into the running balance now
    suggestedWeeklyOffDock: { days: penaltyDays, amount: suggestedPenalty },
    net: round(earnings - fixedDeductions - advanceRecovered),   // SIGNED (can be negative → carries)
  };
}

if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, CONFIG), 'utf8'));
  const { first, to, daysInMonth, elapsedDays, fullMonth, label } = range(MONTH);
  const file = path.resolve(__dirname, 'downloads', `salarydata_${label}.xls`);
  if (!fs.existsSync(file)) { console.error('Run salaryData.js first to fetch ' + file); process.exit(1); }
  const att = Object.fromEntries(parseSummary(file).map(e => [e.code, e]));

  console.log(`Payslips — ${label}  (${first.toLocaleDateString()} .. ${to.toLocaleDateString()}; elapsed ${elapsedDays}/${daysInMonth}d${fullMonth ? ', full month' : ', month-to-date'})\n`);
  for (const [code, emp] of Object.entries(cfg.employees)) {
    const a = att[code] || { presentDays: 0, absentDays: 0, otHrs: 0, name: code };
    const advances = (cfg.advances || []).filter(x => x.code === code && new Date(x.date) >= first && new Date(x.date) <= to);
    const advanceBalanceIn = Number((cfg.advanceBalances || {})[code] || 0); // carried from prior month
    const fines = Number((cfg.fines || {})[code] || 0);
    const loanInstallment = Number((cfg.loans || {})[code] || 0);
    const advanceRecover = Number((cfg.advanceRecover || {})[code] || 0); // owner chooses how much to recover (default 0 = pay full salary)
    const p = computePay({ emp, att: a, daysInMonth, elapsedDays, fullMonth, advances, advanceBalanceIn, advanceRecover, fines, loanInstallment, monthStart: first, toDate: to });
    console.log(`${code} ${a.name || ''}  [${p.type}] rate=${p.effectiveRate}${p.effectiveRemark ? ' ('+p.effectiveRemark+')' : ''}`);
    console.log(`   payable ${p.payableDays}d  present ${p.presentDays}  absent ${p.absentDays}  OT ${p.otHrs}h → net ${p.otHrsNet}h  bonus ₹${p.perfectBonus}`);
    const ded = []; if (p.advanceRecovered) ded.push(`advance ₹${p.advanceRecovered}`); if (p.fines) ded.push(`fine ₹${p.fines}`); if (p.loanInstallment) ded.push(`loan ₹${p.loanInstallment}`);
    console.log(`   base ₹${p.base}  + OT ₹${p.otPay}  + bonus ₹${p.perfectBonus}${ded.length ? '  − (' + ded.join(' + ') + ')' : ''}  =  NET ₹${p.net}`);
    if (p.advanceDue > 0) console.log(`   ↪ advance balance carried forward: ₹${p.advanceBalanceCarried} (of ₹${p.advanceDue} owed)`);
    if (p.suggestedWeeklyOffDock.days > 0) console.log(`   ⚠ suggested weekly-off dock (confirm): ${p.suggestedWeeklyOffDock.days}d = ₹${p.suggestedWeeklyOffDock.amount}`);
    console.log('');
  }
}

module.exports = { computePay, effectiveAmount };
