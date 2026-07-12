// Browser port of jobs/salaryCalc.js — SAME logic, so on-screen payslips match the engine.
// Keep these two in sync.
const round = (n) => Math.round(n * 100) / 100;
const DAY = 86400000;

// Net work hours per shift (12H uses 12). Drives the 1× OT hourly rate.
export const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10, DSG: 10 };
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
export function computePay({ emp, att, daysInMonth, elapsedDays, fullMonth, advancesThisMonth = 0, advanceBalanceIn = 0, advanceRecover = 0, fines = 0, loanInstallment = 0, bonus = 0, restoreSaturdayDays = 0, graceDays = 0, latePenaltyDays = 0, weeklyOffDockDays = 0, openingBalance = 0, monthStart, toDate }) {
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
  // Owner rule (2026-06-14): a Saturday WORKED in a week that didn't earn the weekly-off
  // (fewer than 4 present days that week) is NOT paid as a day — only its OT counts, and the
  // Saturday stays absent. att.unpaidWorkedSat is the count of such Saturdays (from the daily
  // weekly-off audit). It reduces the paid days but NOT the OT (OT already includes those hrs).
  const unpaidSat = emp.type === 'daily' ? 0 : Number(att.unpaidWorkedSat || 0);

  // app-only daily-wager: pay = wage × equivalent-days (Σ hours/11, each day capped at 1).
  // machine daily-wage: wage × present days. monthly: prorated, deduct absences + unpaid worked Sats.
  const base = emp.type === 'daily'
    ? (emp.appOnly ? rate * (att.equivalentDays || 0) : rate * (att.presentDays || 0))
    : att.noRecord ? 0                                    // no attendance this month (joined later) -> pay 0, never a full month
    : perDay * Math.max(0, effElapsed - (att.absentDays || 0) - unpaidSat);

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
  // Goodwill "give back Saturday" — owner leniently pays back N cut Saturdays at one day's pay each.
  // Additive earning only (monthly staff); does NOT touch attendance, paidDays, or the cut count.
  const restoreSatDays = emp.type === 'daily' ? 0 : Number(restoreSaturdayDays || 0);
  const restoreSaturdayPay = round(perDay * restoreSatDays);
  // 15-min grace top-up: extra present days the grace earns this worker (owner opts in per person).
  const graceDaysN = emp.type === 'daily' ? 0 : Number(graceDays || 0);
  const gracePay = round(perDay * graceDaysN);
  const earnings = base + otPay + perfectBonus + restoreSaturdayPay + gracePay + Number(bonus || 0);
  const fixed = Number(fines || 0) + Number(loanInstallment || 0) + latePenalty + weeklyOffDock;
  const avail = Math.max(0, earnings - fixed);
  const advanceDue = Number(advancesThisMonth || 0) + Number(advanceBalanceIn || 0);
  const advanceRecovered = Math.min(Number(advanceRecover || 0), advanceDue, avail);

  // Day breakdown for the salary tab. Paid days = days the worker is actually PAID for.
  // A WORKED weekly-off (weeklyOffPresent) is NOT an extra paid day — the Saturday is already
  // covered (paid for monthly staff, off for daily) and working it is rewarded as OVERTIME only.
  //  • monthly staff: present + ALL weekly-offs (worked or not) + holidays = all non-absent days.
  //    The worked Saturdays sit INSIDE the weekly-off count; the extra is OT, not days.
  //  • daily wagers: only present working days. Weekly-offs/holidays are unpaid; working one → OT.
  const present = att.presentDays || 0;
  const weeklyOff = att.weeklyOff || 0;
  const weeklyOffPresent = att.weeklyOffPresent || 0;
  const holiday = att.holiday || 0;
  const weeklyOffAll = weeklyOff + weeklyOffPresent;        // Saturdays the worker got CREDIT for (paid rest + worked)
  // Saturdays CUT = calendar Saturdays in the period the worker did NOT earn (low attendance).
  // Purely informational for the salary slip — these days already sit inside absentDays, so this
  // does NOT change any pay figure. Only meaningful for monthly staff (daily wagers: Saturdays never paid).
  let saturdaysInPeriod = 0;
  if (monthStart && toDate) {
    for (const d = new Date(monthStart); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 6) saturdaysInPeriod++;
    }
  }
  const saturdaysCut = emp.type === 'daily' ? 0 : Math.max(0, round(saturdaysInPeriod - weeklyOffAll));
  const paidDays = emp.type === 'daily'
    ? round(present)                                        // daily: only worked weekdays; off/holiday → OT, not paid days
    : round(present + weeklyOffAll + holiday - unpaidSat);  // monthly: paid Saturdays minus those worked in an unearned week (OT only)

  return {
    type: emp.type, effectiveRate: rate, effectiveRemark: eff.remark, perDay: round(perDay), noAttendance: !!att.noRecord,
    payableDays: effElapsed, presentDays: att.presentDays || 0, absentDays: att.absentDays || 0,
    weeklyOff, weeklyOffPresent, weeklyOffAll, holiday, paidDays, unpaidWorkedSat: unpaidSat,
    saturdaysInPeriod, saturdaysCut,
    restoreSaturdayDays: restoreSatDays, restoreSaturdayPay: round(restoreSaturdayPay),
    graceDays: graceDaysN, gracePay: round(gracePay),
    otHrs: round(att.otHrs || 0), otHrsNet: round(netOtHrs),
    base: round(base), otPay: round(otPay), perfectBonus: round(perfectBonus), bonus: round(Number(bonus || 0)),
    fines: round(Number(fines || 0)), loanInstallment: round(Number(loanInstallment || 0)),
    latePenalty: round(latePenalty), latePenaltyDays: Number(latePenaltyDays || 0),
    weeklyOffDock: round(weeklyOffDock), weeklyOffDockDays: Number(weeklyOffDockDays || 0), suggestedDockDays,
    advanceDue: round(advanceDue), advanceRecovered: round(advanceRecovered),
    advanceBalanceCarried: round(advanceDue - advanceRecovered),
    suggestedWeeklyOffDock: { days: penaltyDays, amount: round(perDay * penaltyDays) },
    net: round(Math.max(0, earnings - fixed - advanceRecovered)),
    // Cashier model: opening balance carried from last month (+ = still owed to worker, − = he owes),
    // added to this month's net → the amount to actually settle. Closing balance = payable − amount paid.
    openingBalance: round(openingBalance),
    payable: round(Math.max(0, earnings - fixed - advanceRecovered) + openingBalance),
  };
}
