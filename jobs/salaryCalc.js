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
const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10 };

// Effective pay on `toDate` = base + sum of increment deltas effective on/before that date.
// Each increment is an ADDED amount (e.g. +1000), recorded with effective date + remark.
function effectiveAmount(emp, toDate) {
  const base = emp.type === 'daily' ? emp.wage : emp.amount;
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
function computePay({ emp, att, daysInMonth, elapsedDays, fullMonth, advances, advanceBalanceIn = 0, advanceRecover = 0, fines = 0, loanInstallment = 0, monthStart, toDate }) {
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
  const base = emp.type === 'daily'
    ? rate * att.presentDays
    : perDay * Math.max(0, effElapsed - att.absentDays);
  // net OT = Realtime OT (capped Working−Shift) minus late/early shortfall; can go negative
  const netOtHrs = (att.otHrs || 0) - (att.lateHrs || 0) - (att.earlyHrs || 0);
  // OT paid at NORMAL 1× rate = perDay / shift-hours. (Saturday-worked hours flow in via Realtime's OT.)
  const shiftHrs = SHIFT_HOURS[emp.shift] || 8;
  const hourlyRate = perDay / shiftHrs;
  const otPay = netOtHrs * hourlyRate;
  // perfect attendance bonus (complete month, zero absence; lateness does not disqualify)
  const perfectBonus = (fullMonth && att.absentDays === 0 && att.presentDays > 0) ? perDay : 0;
  // excess-absence weekly-off dock: every 3 absent days → 1 off — SUGGESTED, confirm before applying
  const penaltyDays = Math.floor(att.absentDays / 3);
  const suggestedPenalty = round(perDay * penaltyDays);
  // deductions: fines + loan installment, then OWNER-CHOSEN advance recovery (default 0 = pay full salary).
  // Advances are a running balance: new advances given this month + prior balance, minus what's recovered.
  // Paying a worker who still owes simply carries the balance forward; extra cash given = a new advance.
  const earnings = base + otPay + perfectBonus;
  const fixedDeductions = Number(fines || 0) + Number(loanInstallment || 0);
  const availForAdvance = Math.max(0, earnings - fixedDeductions);
  const advThisMonth = advances.reduce((s, a) => s + Number(a.amount || 0), 0);
  const advanceDue = advThisMonth + advanceBalanceIn;
  const advanceRecovered = Math.min(Number(advanceRecover || 0), advanceDue, availForAdvance);
  return {
    type: emp.type, effectiveRate: rate, effectiveRemark: eff.remark,
    presentDays: att.presentDays, absentDays: att.absentDays, payableDays: effElapsed,
    otHrs: round(att.otHrs), otHrsNet: round(netOtHrs),
    base: round(base), otPay: round(otPay), perfectBonus: round(perfectBonus),
    fines: round(Number(fines || 0)), loanInstallment: round(Number(loanInstallment || 0)),
    advanceDue: round(advanceDue), advanceRecovered: round(advanceRecovered),
    advanceBalanceCarried: round(advanceDue - advanceRecovered),
    suggestedWeeklyOffDock: { days: penaltyDays, amount: suggestedPenalty },
    net: round(Math.max(0, earnings - fixedDeductions - advanceRecovered)),
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
