// Month context + per-person pay computation shared by the Salary list and Person page.
// All rule complexity stays here — screens just show the result.
import { computePay } from './payroll';
import { monthData, dailyAtt, istMonth } from './data';
import { monthOt, monthDetail } from './attendanceEngine';

// Day-value for present-count: full=1, half=0.5, absent=0. Owner's per-day override (md.dayOverrides,
// keyed by YYYY-MM-DD) lets him decide a borderline weekday at pay time. Returns the net +/- present days.
const DAYVAL = { full: 1, half: 0.5, absent: 0 };
export function presentAdjustFrom(detail, overrides) {
  if (!overrides || !Object.keys(overrides).length) return 0;
  let adj = 0;
  for (const d of detail) {
    const ov = overrides[d.ymd];
    if (!ov || ['weekly-off', 'sat-worked', 'sat-absent'].includes(d.kind)) continue;  // weekdays only
    const def = d.kind === 'half' ? 0.5 : d.kind === 'absent' ? 0 : 1;                  // single-punch counts as full
    adj += (DAYVAL[ov] ?? def) - def;
  }
  return Math.round(adj * 100) / 100;
}
// Owner's per-SATURDAY pay/no-pay override → net +/- paid Saturdays. Default paid = weekly-off (earned
// rest) or a worked Saturday; default no-pay = an un-earned (cut) Saturday.
export function saturdayAdjustFrom(detail, overrides) {
  if (!overrides || !Object.keys(overrides).length) return 0;
  let adj = 0;
  for (const d of detail) {
    if (!['weekly-off', 'sat-worked', 'sat-absent'].includes(d.kind)) continue;
    const ov = overrides[d.ymd];
    if (ov !== 'pay' && ov !== 'nopay') continue;
    const defPaid = d.kind === 'sat-absent' ? 0 : 1;
    adj += (ov === 'pay' ? 1 : 0) - defPaid;
  }
  return adj;
}

const pad = (n) => String(n).padStart(2, '0');

export const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export const DATA_START = '2026-06';   // app runs from June 2026 onward — no data before this
export function monthOptions(count = 6) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const mk = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    return { mk, label: d.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }).filter((m) => m.mk >= DATA_START);   // never offer pre-June months
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
export function payFor(emp, attMap, mk, ctx, graceDelta = 0, punchDoc = null) {
  const att = attFor(emp, attMap, mk);
  const md = monthData(emp, mk);
  const advs = (emp.advances || []).filter((a) => (a.date || '').startsWith(mk));
  const advancesThisMonth = advs.reduce((s, a) => s + Number(a.amount || 0), 0);
  const advanceBalanceIn = Number(md.advanceBalanceIn || 0);
  const advanceRecover = md.advanceRecover != null ? Number(md.advanceRecover) : advancesThisMonth + advanceBalanceIn;
  // OT source: PORTAL (att.otHrs, default) or APP (computed here from raw punches). Owner picks per
  // worker via md.otSource; app-OT is already net (worked − shift), so no late/early re-deduction.
  const portalOt = Number(att.otHrs || 0);
  // OT from raw punches (missing/single punch = 0 OT, never restored) + per-day detail for overrides.
  const det = punchDoc && !att.noRecord ? monthDetail(emp.shift, punchDoc, mk, istMonth()) : { otHrs: 0, detail: [] };
  const appOt = det.otHrs;
  const otSource = md.otSource === 'app' ? 'app' : 'portal';
  // owner's per-day decisions → adjust days for pay: weekdays Full/Half/Absent, Saturdays pay/no-pay
  const presentAdjust = presentAdjustFrom(det.detail, md.dayOverrides);
  const satAdjust = saturdayAdjustFrom(det.detail, md.dayOverrides);
  const otPart = otSource === 'app' ? { otHrs: appOt, lateHrs: 0, earlyHrs: 0 } : { otHrs: portalOt };
  const otAtt = { ...att, ...otPart,
    presentDays: (att.presentDays || 0) + presentAdjust,
    weeklyOff: Math.max(0, (att.weeklyOff || 0) + satAdjust),
    absentDays: Math.max(0, (att.absentDays || 0) - presentAdjust - satAdjust) };
  const pay = computePay({
    emp, att: otAtt, ...ctx,
    advancesThisMonth, advanceBalanceIn, advanceRecover,
    fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0), bonus: Number(md.bonus || 0),
    restoreSaturdayDays: Number(md.restoreSaturdays || 0),
    graceDays: md.gracePaid ? Number(graceDelta || 0) : 0,   // owner opted in for this worker/month
    latePenaltyDays: 0, weeklyOffDockDays: 0, // the machine applies late/weekly-off rules
  });
  return { att, md, advs, advancesThisMonth, pay, portalOt, appOt, otSource, detail: det.detail, presentAdjust, satAdjust };
}
