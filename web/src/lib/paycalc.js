// Month context + per-person pay computation shared by the Salary list and Person page.
// All rule complexity stays here — screens just show the result.
import { computePay } from './payroll';
import { monthData, dailyAtt, istMonth } from './data';
import { monthOt, monthDetail, monthLateFix } from './attendanceEngine';

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

// Snapshot of a worker's salary figures AT LOCK — stored on the payment so a paid month always
// shows these exact numbers, never recomputed under a later rule change. Used by the pay screens.
export function paymentBreakdown(pay) {
  return {
    base: pay.base, otPay: pay.otPay, otHrsNet: pay.otHrsNet, perfectBonus: pay.perfectBonus,
    gracePay: pay.gracePay, graceDays: pay.graceDays, restoreSaturdayPay: pay.restoreSaturdayPay,
    restoreSaturdayDays: pay.restoreSaturdayDays, bonus: pay.bonus, fines: pay.fines,
    advanceDue: pay.advanceDue, advanceRecovered: pay.advanceRecovered,
    net: pay.net, openingBalance: pay.openingBalance, presentDays: pay.presentDays, absentDays: pay.absentDays,
  };
}

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
  // ONE advance account (owner 2026-07-13): the engine always cuts the FULL outstanding advance
  // (this-month advances + any carried-in balance) into the running balance. No per-month "advance cut"
  // or "loan cut" input any more — whatever advance was given simply reduces the person's account.
  // OT source: PORTAL (att.otHrs, default) or APP (computed here from raw punches). Owner picks per
  // worker via md.otSource; app-OT is already net (worked − shift), so no late/early re-deduction.
  const portalOt = Number(att.otHrs || 0);
  // OT from raw punches (a missing/single punch earns 0 OT by default — NOT auto-restored).
  const det = punchDoc && !att.noRecord ? monthDetail(emp.shift, punchDoc, mk, istMonth()) : { otHrs: 0, detail: [] };
  const appOt = det.otHrs;
  const otSource = md.otSource === 'app' ? 'app' : 'portal';
  // Owner's MANUAL per-day OT credit for flaky-machine days (md.otCredits {ymd:hours}) — his tap only,
  // added on top of the chosen OT. Off unless he credits a specific single-punch day.
  const otCredit = Object.values(md.otCredits || {}).reduce((s, v) => s + Number(v || 0), 0);
  const effOt = Math.round(((otSource === 'app' ? appOt : portalOt) + otCredit) * 100) / 100;
  // Broken-punch LATE fix (portal source only): a single evening punch on a missing-morning day is
  // misread by the portal as a very-late arrival, inflating `lateHrs` and wrongly eating OT. Recompute
  // the fake portion from real punches and strip it — floored at the genuine both-punch lateness so we
  // never restore more OT than the honest late deduction. App source already ignores late (net OT).
  const rawLate = Number(att.lateHrs || 0);
  const lateFix = (otSource === 'portal' && punchDoc && !att.noRecord)
    ? monthLateFix(emp.shift, punchDoc, mk, istMonth()) : { fake: 0, genuine: 0 };
  const correctedLate = lateFix.fake > 0.25
    ? Math.max(lateFix.genuine, Math.round((rawLate - lateFix.fake) * 100) / 100)
    : rawLate;
  const lateFixed = Math.round(Math.max(0, rawLate - correctedLate) * 100) / 100; // OT hours restored
  // owner's per-day decisions → adjust days for pay: weekdays Full/Half/Absent, Saturdays pay/no-pay
  const presentAdjust = presentAdjustFrom(det.detail, md.dayOverrides);
  const satAdjust = saturdayAdjustFrom(det.detail, md.dayOverrides);
  const otPart = otSource === 'app' ? { otHrs: effOt, lateHrs: 0, earlyHrs: 0 } : { otHrs: effOt, lateHrs: correctedLate };
  const otAtt = { ...att, ...otPart,
    presentDays: (att.presentDays || 0) + presentAdjust,
    weeklyOff: Math.max(0, (att.weeklyOff || 0) + satAdjust),
    absentDays: Math.max(0, (att.absentDays || 0) - presentAdjust - satAdjust) };
  // OWNER MANUAL OVERRIDE (any worker): md.override = { days, ot } fixes the paid days + net OT for the
  // month and WINS over the punch/portal figures. base = perDay × days, OT = ot hours. Used for manual
  // workers (Radhey/Dinesh) and to correct any worker's month. Clear it to fall back to auto figures.
  // Owner override composes independently: setting ONLY days must NOT touch OT, and setting ONLY OT
  // must NOT touch the paid days / weekly-offs (else correcting OT silently drops paid Sundays).
  const ov = md.override;
  const hasDaysOv = !!ov && ov.days != null;
  const hasOtOv = !!ov && ov.ot != null;
  const hasOverride = hasDaysOv || hasOtOv;
  // A manual/app-only worker with NO override AND no logged days must pay 0 (noRecord) — never a full
  // month by default. (Guards a newly-added manual worker before the owner enters their days.)
  const appOnlyNoData = !!emp.appOnly && !hasOverride && !((emp.attendanceLog && emp.attendanceLog[mk]) || []).length;
  let effAtt = appOnlyNoData ? { ...otAtt, noRecord: true } : otAtt;
  if (hasDaysOv) {
    const ovDays = Number(ov.days) || 0;
    const elapsed = ctx.elapsedDays || 0;
    // Honor the override LITERALLY: pay exactly `ovDays` days (monthly base = perDay×ovDays, even if
    // ovDays > days-in-month → the owner can pay an extra day). absentDays is left un-floored so the
    // engine's max(0, elapsed − absent) resolves to ovDays; display paidDays = ovDays (matches pay).
    effAtt = { ...effAtt,
      presentDays: ovDays, equivalentDays: ovDays,   // equivalentDays drives daily/app-only base
      weeklyOff: 0, weeklyOffPresent: 0, holiday: 0, unpaidWorkedSat: 0,
      absentDays: elapsed - ovDays, noRecord: false };
  }
  if (hasOtOv) {
    effAtt = { ...effAtt, otHrs: Number(ov.ot) || 0, lateHrs: 0, earlyHrs: 0 };   // owner's net OT is final
  }
  const pay = computePay({
    emp, att: effAtt, ...ctx,
    advancesThisMonth, advanceBalanceIn,
    fines: Number(md.fine || 0), bonus: Number(md.bonus || 0),
    restoreSaturdayDays: Number(md.restoreSaturdays || 0),
    graceDays: md.gracePaid ? Number(graceDelta || 0) : 0,   // owner opted in for this worker/month
    payPerfectBonus: !!md.perfectBonusPaid,                  // full-attendance bonus: owner adds/rejects per worker
    latePenaltyDays: 0, weeklyOffDockDays: 0, // the machine applies late/weekly-off rules
    openingBalance: Number(md.openingBalance || 0),          // running balance carried from last month
  });
  return { att, md, advs, advancesThisMonth, pay, portalOt, appOt, otSource, otCredit, detail: det.detail, presentAdjust, satAdjust, lateFixed, rawLate, hasOverride };
}
