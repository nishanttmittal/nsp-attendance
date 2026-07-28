// GOLDEN PAYROLL FIXTURES — derived from the APPROVED RULES, not from either implementation.
//
// Source of truth for every `expected` value below:
//   PAYROLL-RULEBOOK.md rules #1–#8 (Desktop/UNICO/PAYROLL-RULEBOOK.md) and the owner decisions
//   recorded in memory: payroll-rulebook-redesign, payroll-daily-wagers, payroll-late-early-policy,
//   payroll-cashier-lock-model, payroll-night-ot-gap, attendance-settings-guard-drift.
//
// RULE: never copy an expected number out of salaryCalc.js or payroll.js. If a rule is silent or
// contradictory, set `expected: null` and fill `ambiguity` — that is a finding, not a failure.
//
// Reference employee: monthly ₹15,000, GEN shift, June 2026 (30 days) → perDay ₹500, OT ₹62.50/hr.

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const JUN_START = D(2026, 6, 1);
const JUN_END = D(2026, 6, 30);

// Base attendance shape — a full, clean June.
const FULL_JUNE = { presentDays: 30, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0, workHrs: 0 };
const MONTHLY = { type: 'monthly', amount: 15000, shift: 'GEN' };
const JUNE = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: JUN_START, toDate: JUN_END };

export const CASES = [
  // ── Rule #5: base = salary ÷ ACTUAL days in month × credited days ───────────────────────
  {
    id: 'full-month-present',
    rule: '#5 base = perDay × credited days',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE },
    expected: { base: 15000, otPay: 0, net: 15000 },
    derivation: '500 × 30 credited days',
  },
  {
    id: 'absent-5-days',
    rule: '#5 absences reduce credited days',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 25, absentDays: 5 }, params: { ...JUNE },
    expected: { base: 12500, otPay: 0, net: 12500 },
    derivation: '500 × (30 − 5)',
  },
  {
    id: 'half-day-as-0.5-absent',
    rule: '#2 half-day arrives from the portal as 0.5 in Absent Days',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 29.5, absentDays: 0.5 }, params: { ...JUNE },
    expected: { base: 14750, otPay: 0, net: 14750 },
    derivation: '500 × (30 − 0.5)',
  },
  {
    id: 'unpaid-worked-saturday',
    rule: 'Owner 2026-06-14 — Saturday worked in an unearned week is OT only, day stays unpaid',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 26, absentDays: 4, unpaidWorkedSat: 1 }, params: { ...JUNE },
    expected: { base: 12500, otPay: 0, net: 12500 },
    derivation: '500 × (30 − 4 − 1)',
  },

  // ── Rule #6: OT rate = perDay ÷ shift hours, multiplier 1× ──────────────────────────────
  {
    id: 'ot-gen-shift',
    rule: '#6 OT at 1× — GEN shift = 8 h',
    emp: MONTHLY, att: { ...FULL_JUNE, otHrs: 10 }, params: { ...JUNE },
    expected: { base: 15000, otPay: 625, net: 15625 },
    derivation: '10 h × (500 ÷ 8)',
  },
  {
    id: 'ot-12h-shift',
    rule: '#6 OT at 1× — 12H shift = 12 h',
    emp: { ...MONTHLY, shift: '12H' }, att: { ...FULL_JUNE, otHrs: 6 }, params: { ...JUNE },
    expected: { base: 15000, otPay: 250, net: 15250 },
    derivation: '6 h × (500 ÷ 12)',
  },
  {
    id: 'ot-dsg-shift',
    rule: '#6 — DSG (designer) = 09:00–19:00, lunch 13:00–13:30 INSIDE the shift → 10 h (owner 2026-07-28)',
    emp: { ...MONTHLY, shift: 'DSG' }, att: { ...FULL_JUNE, otHrs: 10 }, params: { ...JUNE },
    expected: { base: 15000, otPay: 500, net: 15500 },
    derivation: '10 h × (500 ÷ 10). Lunch is paid — it is not deducted from the shift length.',
  },

  // ── Rule #7: late/early subtracted from OT, never from base, floored at 0 ───────────────
  {
    id: 'ot-minus-late-early',
    rule: '#7 late + early are cut from OT',
    emp: MONTHLY, att: { ...FULL_JUNE, otHrs: 10, lateHrs: 3, earlyHrs: 2 }, params: { ...JUNE },
    expected: { base: 15000, otPay: 312.5, net: 15312.5 },
    derivation: '(10 − 3 − 2) h × 62.50',
  },
  {
    id: 'ot-floored-at-zero-never-touches-base',
    rule: '#7 the OT cut is floored at 0 — it must never eat base pay',
    emp: MONTHLY, att: { ...FULL_JUNE, otHrs: 2, lateHrs: 3, earlyHrs: 2 }, params: { ...JUNE },
    expected: { base: 15000, otPay: 0, net: 15000 },
    derivation: 'max(0, 2 − 3 − 2) = 0 h; base untouched',
  },
  {
    id: 'night-shift-past-midnight-ot',
    rule: 'payroll-night-ot-gap — the portal loses OT that crosses midnight',
    emp: { ...MONTHLY, shift: '12H' }, att: { ...FULL_JUNE, otHrs: 5 }, params: { ...JUNE },
    expected: null,
    ambiguity: 'UPSTREAM DATA GAP, not an engine defect. The worker did 9 h of OT; the portal '
      + 'reports 5 h because the post-midnight span is dropped. Both engines faithfully compute '
      + 'from a wrong input. Fixing this belongs in the attendance feed, not in computePay.',
  },

  // ── Prorating: joiners and leavers must not accrue false absences ───────────────────────
  {
    id: 'mid-month-joiner',
    rule: 'Prorate to the employment window — a joiner has no absences before joining',
    emp: { ...MONTHLY, joinDate: '2026-06-16' },
    att: { ...FULL_JUNE, presentDays: 15, absentDays: 15 },
    params: { ...JUNE },
    expected: { base: 7500, otPay: 0, net: 7500 },
    derivation: 'window = 16–30 Jun = 15 days; the portal\'s 15 whole-month absents are all '
      + 'outside the window, so credited days = 15 → 500 × 15',
  },
  {
    id: 'mid-month-leaver',
    rule: 'Prorate to the employment window — a leaver has no absences after leaving',
    emp: { ...MONTHLY, exitDate: '2026-06-15' },
    att: { ...FULL_JUNE, presentDays: 15, absentDays: 15 },
    params: { ...JUNE },
    expected: { base: 7500, otPay: 0, net: 7500 },
    derivation: 'window = 1–15 Jun = 15 days → 500 × 15',
  },
  {
    id: 'no-attendance-record-this-month',
    rule: 'Owner 2026-07-10 — a worker with no attendance record for the month is paid ₹0',
    emp: MONTHLY,
    att: { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0, workHrs: 0, noRecord: true },
    params: { ...JUNE },
    expected: { base: 0, otPay: 0, net: 0 },
    derivation: 'joined later — no record means no pay, never a silent full month',
  },

  // ── Rule #8: full-attendance bonus is OWNER-CONTROLLED (owner 2026-07-13) ───────────────
  {
    id: 'perfect-bonus-not-opted-in',
    rule: '#8 bonus is eligible on zero absence but only PAID when the owner opts in',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE, payPerfectBonus: false },
    expected: { base: 15000, otPay: 0, net: 15000 },
    derivation: 'eligible, not opted in → no bonus',
  },
  {
    id: 'perfect-bonus-opted-in',
    rule: '#8 opted in → +1 day',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE, payPerfectBonus: true },
    expected: { base: 15000, otPay: 0, net: 15500 },
    derivation: '15000 + one day (500)',
  },
  {
    id: 'perfect-bonus-denied-when-absent',
    rule: '#8 any absence disqualifies the bonus even if the owner opts in',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 29, absentDays: 1 }, params: { ...JUNE, payPerfectBonus: true },
    expected: { base: 14500, otPay: 0, net: 14500 },
    derivation: '500 × 29; not eligible → no bonus',
  },

  // ── Daily wagers (owner 2026-07-22) — wage × hours ÷ 11, lunch unpaid, NO separate OT ───
  {
    id: 'daily-wager-hours-based',
    rule: 'payroll-daily-wagers — (workHrs − 0.5 × presentDays) ÷ 11 × ₹700',
    emp: { type: 'daily', wage: 700, shift: 'GEN' },
    att: { presentDays: 10, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0, workHrs: 121 },
    params: { ...JUNE },
    expected: { base: 7381.82, otPay: 0, net: 7381.82 },
    derivation: '(121 − 5) ÷ 11 = 10.5454 equivalent days × 700',
  },
  {
    id: 'daily-wager-never-gets-separate-ot',
    rule: 'Owner 2026-07-22 — OT hours are already inside workHrs; an OT line would double-pay',
    emp: { type: 'daily', wage: 700, shift: 'GEN' },
    att: { presentDays: 10, absentDays: 0, otHrs: 20, lateHrs: 0, earlyHrs: 0, workHrs: 121 },
    params: { ...JUNE },
    expected: { base: 7381.82, otPay: 0, net: 7381.82 },
    derivation: 'identical to the previous case — 20 OT hours must change nothing',
  },
  {
    id: 'app-only-worker-gets-no-portal-ot',
    rule: 'App-only (manually entered) workers have no biometric OT feed',
    emp: { ...MONTHLY, appOnly: true },
    att: { ...FULL_JUNE, otHrs: 10 },
    params: { ...JUNE },
    expected: { base: 15000, otPay: 0, net: 15000 },
    derivation: 'no portal OT exists for an app-only worker, so no OT can be paid',
  },

  // ── Increments take effect by date ──────────────────────────────────────────────────────
  {
    id: 'increment-already-effective',
    rule: '#8 increments apply from their effective date',
    emp: { ...MONTHLY, increments: [{ amount: 1000, effective: '2026-06-10' }] },
    att: { ...FULL_JUNE }, params: { ...JUNE },
    expected: { base: 16000, otPay: 0, net: 16000 },
    derivation: 'rate 16000 ÷ 30 × 30',
  },
  {
    id: 'increment-not-yet-effective',
    rule: '#8 a future increment must not apply to this month',
    emp: { ...MONTHLY, increments: [{ amount: 1000, effective: '2026-07-01' }] },
    att: { ...FULL_JUNE }, params: { ...JUNE },
    expected: { base: 15000, otPay: 0, net: 15000 },
    derivation: 'effective after 30 Jun → rate stays 15000',
  },
  {
    id: 'rate-stored-as-string',
    rule: 'Owner 2026-07-28 — a text rate must be coerced to a number, never concatenated',
    emp: { type: 'monthly', amount: '15000', shift: 'GEN', increments: [{ amount: 1000, effective: '2026-06-10' }] },
    att: { ...FULL_JUNE }, params: { ...JUNE },
    expected: { base: 16000, otPay: 0, net: 16000 },
    derivation: 'Number("15000") + 1000 = 16000. Without coercion this concatenates to "150001000" '
      + 'and pays ₹15,00,01,000. Owner chose belt-and-braces: reject non-numeric rates on save AND '
      + 'coerce in both engines.',
  },

  // ── Advances: ONE account, full cut at settle, signed carry (owner 2026-07-13) ──────────
  {
    id: 'advance-cut-in-full',
    rule: 'payroll-cashier-lock-model — the full outstanding advance is cut at settle',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE, advancesThisMonth: 5000 },
    expected: { base: 15000, otPay: 0, net: 10000 },
    derivation: '15000 − 5000',
  },
  {
    id: 'advance-exceeds-salary-goes-negative',
    rule: 'Owner 2026-07-13 — net is SIGNED and carries forward; never floored at ₹0',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE, advancesThisMonth: 20000 },
    expected: { base: 15000, otPay: 0, net: -5000 },
    derivation: '15000 − 20000 = −5000, the worker owes it and it carries',
  },
  {
    id: 'advance-carried-in-from-last-month',
    rule: 'Owner 2026-07-13 — prior balance joins this month\'s advances in one account',
    emp: MONTHLY, att: { ...FULL_JUNE }, params: { ...JUNE, advancesThisMonth: 2000, advanceBalanceIn: 10000 },
    expected: { base: 15000, otPay: 0, net: 3000 },
    derivation: '15000 − (2000 + 10000)',
  },

  // ── Fines and penalties ─────────────────────────────────────────────────────────────────
  {
    id: 'fines-late-penalty-and-weekly-off-dock',
    rule: '#4 + #7 — fines, approved late penalty and Saturday dock are fixed cuts',
    emp: MONTHLY, att: { ...FULL_JUNE },
    params: { ...JUNE, fines: 500, latePenaltyDays: 0.5, weeklyOffDockDays: 1 },
    expected: { base: 15000, otPay: 0, net: 13750 },
    derivation: '15000 − 500 fine − 250 (½ day) − 500 (1 Saturday)',
  },

  // ── Owner goodwill adjustments ──────────────────────────────────────────────────────────
  {
    id: 'give-back-saturday-goodwill',
    rule: 'Owner 2026-07-08 — owner may pay back N cut Saturdays at one day each',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 26, absentDays: 4 },
    params: { ...JUNE, restoreSaturdayDays: 1 },
    expected: { base: 13000, otPay: 0, net: 13500 },
    derivation: '500 × (30 − 4) = 13000, plus one goodwill Saturday (500)',
  },
  {
    id: 'grace-top-up-days',
    rule: 'Owner 2026-07-09 — 15-min grace top-up, opted in per worker',
    emp: MONTHLY, att: { ...FULL_JUNE, presentDays: 29, absentDays: 1 },
    params: { ...JUNE, graceDays: 0.5 },
    expected: { base: 14500, otPay: 0, net: 14750 },
    derivation: '500 × 29 = 14500, plus 0.5 grace day (250)',
  },
];

// ── Call-site contract ──────────────────────────────────────────────────────────────────
// Not a rule disagreement — an INTERFACE disagreement. The two engines name the advances
// parameter differently (`advances` = ledger array vs `advancesThisMonth` = number), and the
// Node engine destructures `advances` with no default. Any caller written against the web
// signature therefore crashes the Node engine. Two live callers do exactly that.
export const CALL_SITE_CASES = [
  {
    id: 'worker.js payslip job → salaryCalc.computePay',
    file: 'jobs/worker.js:361',
    what: 'Telegram payslip requested through the command bot',
    args: {
      emp: { type: 'monthly', amount: 15000, shift: 'GEN' },
      att: { presentDays: 30, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 },
      daysInMonth: 30, elapsedDays: 30, fullMonth: false,
      monthStart: D(2026, 6, 1), toDate: D(2026, 6, 30),
      advancesThisMonth: 5000, advanceBalanceIn: 0, advanceRecover: 5000,
      fines: 0, loanInstallment: 0, bonus: 0, payPerfectBonus: false, openingBalance: 0,
    },
    expectation: 'must return a payslip; passing the web-style advances parameter must not crash',
  },
  {
    id: 'payslipText.js → salaryCalc.computePay',
    file: 'jobs/lib/payslipText.js:31',
    what: 'command-bot payslip text',
    args: {
      emp: { type: 'monthly', amount: 15000, shift: 'GEN' },
      att: { presentDays: 30, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 },
      daysInMonth: 30, elapsedDays: 30, fullMonth: false,
      monthStart: D(2026, 6, 1), toDate: D(2026, 6, 30),
      advancesThisMonth: 5000, advanceBalanceIn: 0, advanceRecover: 0,
      fines: 0, loanInstallment: 0,
    },
    expectation: 'must return a payslip; passing the web-style advances parameter must not crash',
  },
];

export const FIELDS = ['base', 'otPay', 'net'];
