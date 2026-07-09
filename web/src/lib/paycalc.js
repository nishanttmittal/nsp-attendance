// Month context + per-person pay computation shared by the Salary list and Person page.
// All rule complexity stays here — screens just show the result.
import { computePay } from './payroll';
import { monthData, dailyAtt, istMonth } from './data';

const pad = (n) => String(n).padStart(2, '0');

export const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export function monthOptions(count = 6) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const mk = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    return { mk, label: d.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
}

export function monthCtx(mk) {
  const [y, m] = mk.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const fullMonth = mk !== istMonth();
  const elapsedDays = fullMonth ? daysInMonth : Math.max(1, nowIst.getUTCDate() - 1); // till yesterday
  return {
    daysInMonth, fullMonth, elapsedDays,
    monthStart: new Date(Date.UTC(y, m - 1, 1)),
    toDate: new Date(Date.UTC(y, m - 1, fullMonth ? daysInMonth : elapsedDays)),
  };
}

export const nextMonthKey = (mk) => { const [y, m] = mk.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };

const ZERO_ATT = { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };
// noRecord marks a month the worker has NO attendance for (e.g. joined later) — must pay 0,
// NOT a full month. Without this, "0 absent" reads as "present all month" and overpays new joiners.
const NO_RECORD = { ...ZERO_ATT, noRecord: true };

export function attFor(emp, attMap, mk) {
  if (emp.appOnly) return dailyAtt(emp, mk);
  const a = attMap[emp.code];
  if (!a) return NO_RECORD;
  if (a.months && a.months[mk]) return a.months[mk];
  if (a.month === mk) return a;
  return NO_RECORD;
}

// Everything about one person's money in one month.
export function payFor(emp, attMap, mk, ctx, graceDelta = 0) {
  const att = attFor(emp, attMap, mk);
  const md = monthData(emp, mk);
  const advs = (emp.advances || []).filter((a) => (a.date || '').startsWith(mk));
  const advancesThisMonth = advs.reduce((s, a) => s + Number(a.amount || 0), 0);
  const advanceBalanceIn = Number(md.advanceBalanceIn || 0);
  const advanceRecover = md.advanceRecover != null ? Number(md.advanceRecover) : advancesThisMonth + advanceBalanceIn;
  const pay = computePay({
    emp, att, ...ctx,
    advancesThisMonth, advanceBalanceIn, advanceRecover,
    fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0), bonus: Number(md.bonus || 0),
    restoreSaturdayDays: Number(md.restoreSaturdays || 0),
    graceDays: md.gracePaid ? Number(graceDelta || 0) : 0,   // owner opted in for this worker/month
    latePenaltyDays: 0, weeklyOffDockDays: 0, // the machine applies late/weekly-off rules
  });
  return { att, md, advs, advancesThisMonth, pay };
}
