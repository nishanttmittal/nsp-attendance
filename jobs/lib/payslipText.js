// Builds a month-to-date payslip text for one employee — mirrors the payslip branch in
// worker.js (single payroll source = salaryCalc.computePay). Returns a string the command
// bot replies privately to the owner. Read-only on att_salary / att_attendance.
const { db } = require('./firestore');
const { computePay } = require('../salaryCalc');

async function buildPayslipText(code) {
  const fdb = db();
  const [empDoc, attDoc] = await Promise.all([
    fdb.collection('att_salary').doc(code).get(),
    fdb.collection('att_attendance').doc(code).get(),
  ]);
  const emp = empDoc.exists ? empDoc.data() : null;
  if (!emp || !(emp.amount || emp.wage)) return `🧾 Payslip: no salary set for ${emp?.name || code}.`;

  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const mk = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;

  let att;
  if (emp.appOnly) {
    const log = (emp.attendanceLog && emp.attendanceLog[mk]) || [];
    att = { presentDays: log.length, equivalentDays: log.reduce((s, d) => s + Math.min(Number(d.hours || 0), 11) / 11, 0), otHrs: 0, lateHrs: 0, earlyHrs: 0, absentDays: 0 };
  } else {
    att = attDoc.exists ? attDoc.data() : { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };
  }
  const md = (emp.months && emp.months[mk]) || {};
  const adv = (emp.advances || []).filter(a => (a.date || '').startsWith(mk)).reduce((s, a) => s + Number(a.amount || 0), 0);
  const pay = computePay({
    emp, att, daysInMonth: last.getDate(), elapsedDays: yest.getDate(), fullMonth: false, monthStart: first, toDate: yest,
    advancesThisMonth: adv, advanceBalanceIn: Number(md.advanceBalanceIn || 0), advanceRecover: Number(md.advanceRecover || 0),
    fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0),
    openingBalance: Number(md.openingBalance || 0),   // carried balance — else the payslip misstates settlement
  });
  const r = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  return [`🧾 <b>Payslip — ${emp.name || code} (${mk}, to date)</b>`,
    `Rate ${r(pay.effectiveRate)} ${emp.type === 'daily' ? '/day' : '/mo'}  ·  Present ${pay.presentDays} / Absent ${pay.absentDays}`,
    `Base ${r(pay.base)} + OT ${r(pay.otPay)}${pay.perfectBonus ? ' + bonus ' + r(pay.perfectBonus) : ''}`,
    `${pay.fines ? '− Fine ' + r(pay.fines) + '  ' : ''}${pay.loanInstallment ? '− Loan ' + r(pay.loanInstallment) + '  ' : ''}${pay.advanceRecovered ? '− Advance ' + r(pay.advanceRecovered) : ''}`,
    `<b>NET ${r(pay.net)}</b>${pay.advanceBalanceCarried ? '  (advance bal ' + r(pay.advanceBalanceCarried) + ')' : ''}`,
    pay.openingBalance ? `Previous balance ${r(pay.openingBalance)}  →  <b>PAYABLE ${r(pay.payable)}</b>` : ''].filter(Boolean).join('\n');
}

module.exports = { buildPayslipText };
