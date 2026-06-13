// Browser port of jobs/salaryCalc.js — SAME logic, so on-screen payslips match the engine.
// Keep these two in sync.
const round = (n) => Math.round(n * 100) / 100;
const DAY = 86400000;

// Net work hours per shift (12H uses 12). Drives the 1× OT hourly rate.
export const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10 };
// App-only daily-wagers: 11-hour standard day; pay prorates by hours worked.
export const DAILY_WAGER_HOURS = 11;

// Effective pay = base + sum of increment deltas effective on/before the date.
export function effectiveAmount(emp, toDate) {
  const base = emp.type === 'daily' ? Number(emp.wage || 0) : Number(emp.amount || 0);
  let amount = base, lastRemark = null, raised = 0;
  for (const inc of (emp.increments || [])) {
    if (new Date(inc.effective) <= toDate) { amount += Number(inc.amount || 0); raised += Number(inc.amount || 0); lastRemark = inc.remark || lastRemark; }
  }
  return { amount, remark: raised ? `+${raised}${lastRemark ? ' ' + lastRemark : ''}` : null };
}

// One employee's pay for the period. att = {presentDays,absentDays,otHrs,lateHrs,earlyHrs}.
export function computePay({ emp, att, daysInMonth, elapsedDays, fullMonth, advancesThisMonth = 0, advanceBalanceIn = 0, advanceRecover = 0, fines = 0, loanInstallment = 0, bonus = 0, latePenaltyDays = 0, weeklyOffDockDays = 0, monthStart, toDate }) {
  const eff = effectiveAmount(emp, toDate);
  const rate = eff.amount;
  const perDay = emp.type === 'daily' ? rate : rate / daysInMonth;

  let effElapsed = elapsedDays;
  if (monthStart && toDate) {
    let start = monthStart, end = toDate;
    if (emp.joinDate) { const j = new Date(emp.joinDate); if (j > start) start = j; }
    if (emp.exitDate) { const x = new Date(emp.exitDate); if (x < end) end = x; }
    effElapsed = Math.max(0, Math.round((end - start) / DAY) + 1);
  }
  // app-only daily-wager: pay = wage × equivalent-days (Σ hours/11, each day capped at 1).
  // machine daily-wage: wage × present days. monthly: prorated, deduct absences.
  const base = emp.type === 'daily'
    ? (emp.appOnly ? rate * (att.equivalentDays || 0) : rate * (att.presentDays || 0))
    : perDay * Math.max(0, effElapsed - (att.absentDays || 0));

  // Net OT = raw OT − late − early, floored at 0 (lateness is also handled by the penalty tab)
  const netOtHrs = emp.appOnly ? 0 : Math.max(0, (att.otHrs || 0) - (att.lateHrs || 0) - (att.earlyHrs || 0));
  const hourlyRate = perDay / (SHIFT_HOURS[emp.shift] || 8);
  const otPay = netOtHrs * hourlyRate;

  // full-month, zero-absence bonus — NOT for mid-month joiners/leavers (prorated window)
  const perfectBonus = (fullMonth && (att.absentDays || 0) === 0 && (att.presentDays || 0) > 0 && effElapsed === daysInMonth) ? perDay : 0;
  const penaltyDays = Math.floor((att.absentDays || 0) / 3);

  // late-arrival penalty: approved 25% (¼ day) or 50% (½ day) of a day's pay
  const latePenalty = round(perDay * Number(latePenaltyDays || 0));
  // weekly-off dock: every 3 absences = 1 Saturday cut (owner-set; 0 if Realtime already did it)
  const weeklyOffDock = round(perDay * Number(weeklyOffDockDays || 0));
  const suggestedDockDays = Math.floor((att.absentDays || 0) / 3);
  const earnings = base + otPay + perfectBonus + Number(bonus || 0);
  const fixed = Number(fines || 0) + Number(loanInstallment || 0) + latePenalty + weeklyOffDock;
  const avail = Math.max(0, earnings - fixed);
  const advanceDue = Number(advancesThisMonth || 0) + Number(advanceBalanceIn || 0);
  const advanceRecovered = Math.min(Number(advanceRecover || 0), advanceDue, avail);

  return {
    type: emp.type, effectiveRate: rate, effectiveRemark: eff.remark,
    payableDays: effElapsed, presentDays: att.presentDays || 0, absentDays: att.absentDays || 0,
    otHrs: round(att.otHrs || 0), otHrsNet: round(netOtHrs),
    base: round(base), otPay: round(otPay), perfectBonus: round(perfectBonus), bonus: round(Number(bonus || 0)),
    fines: round(Number(fines || 0)), loanInstallment: round(Number(loanInstallment || 0)),
    latePenalty: round(latePenalty), latePenaltyDays: Number(latePenaltyDays || 0),
    weeklyOffDock: round(weeklyOffDock), weeklyOffDockDays: Number(weeklyOffDockDays || 0), suggestedDockDays,
    advanceDue: round(advanceDue), advanceRecovered: round(advanceRecovered),
    advanceBalanceCarried: round(advanceDue - advanceRecovered),
    suggestedWeeklyOffDock: { days: penaltyDays, amount: round(perDay * penaltyDays) },
    net: round(Math.max(0, earnings - fixed - advanceRecovered)),
  };
}
