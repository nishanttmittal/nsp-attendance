# Payroll core — the canonical contract

**Status:** DESIGN ONLY. No code has been changed. This is step 2 of the agreed migration.
**Written:** 2026-07-30 · **Authority:** `Desktop/UNICO/PAYROLL-RULEBOOK.md` (§9 carries the 2026-07 decisions)

---

## Why this exists

Payroll is computed by **two engines with the same maths written twice**:

| | File | Role |
|---|---|---|
| **web** | `web/src/lib/payroll.js` | **PAYS PEOPLE.** ~70 workers. |
| **node** | `jobs/salaryCalc.js` | Telegram payslips, CLI reports. **Pays nobody.** |

That duplication caused, in two days: six of eight Codex findings, a crash from two names for one
parameter (`advances` vs `advancesThisMonth`), a field-name mismatch (`stdHours` vs `standardHours`),
a settlement figure missing from one engine entirely, and a regression that undid a fix made the
night before. **Every one of these is the same root cause.**

The fix is ONE pure core with two thin adapters — **not** one engine calling the other over a
network, which would trade duplication for an availability dependency.

**This document defines what that core takes and returns.** Nothing can be extracted until the
contract is agreed, because today the two engines disagree on both.

---

## 1. Where the engines differ TODAY

Both were run with identical inputs on 2026-07-30 and their output keys compared.

**web returns 45 keys, node returns 26. The 19 web-only keys:**

```
perDay · noAttendance · weeklyOff · weeklyOffPresent · weeklyOffAll · holiday · paidDays
workHrs · dailyStdHrs · equivalentDays · saturdaysInPeriod · saturdaysCut
restoreSaturdayDays · restoreSaturdayPay · graceDays · gracePay
perfectEligible · perfectBonusDay · suggestedDockDays
```

None is a *money* field — they are display and audit values the PWA renders. **That is exactly why
the gap survived so long:** the harness compared `base`, `otPay` and `net`, all of which matched,
while `payable` was absent from node altogether and 40 workers' settlement was misreported.

**Inputs also differ:** node accepts `advances` (a ledger array) *and* `advancesThisMonth` (a number);
web accepts only the latter. Node's dual acceptance exists solely because two live callers were
written against web's signature and crashed.

**Rule for the core: it returns ONE shape. Adapters may drop fields; they may never add or rename.**

---

## 2. INPUT contract

```
computePay({ emp, att, period, adjustments, ledger }) -> Payslip
```

Grouped deliberately. Today's flat 18-argument signature is how `openingBalance` got passed into a
void by one caller and never passed at all by another.

### 2.1 `emp` — who is being paid

| Field | Type | Meaning |
|---|---|---|
| `type` | `'monthly' \| 'daily'` | Drives the entire base-pay branch. |
| `amount` | number | Monthly salary. **Must be numeric** — text concatenates with increments (see rulebook §9.6). |
| `wage` | number | Daily rate, when `type='daily'`. |
| `shift` | string \| null | Named portal shift. **Null is legitimate** for manual staff. |
| `standardHours` | number | This worker's own paid hours. Used when `shift` is null. `0 < h <= 24`. |
| `appOnly` | boolean | Not on the biometric machine → portal OT never applies. |
| `increments` | `[{amount, effective, remark}]` | Applied when `effective <= period.toDate`. |
| `joinDate` / `exitDate` | date \| null | Clamp the payable window. |

**OT divisor resolution order — one place, no exceptions:**
`SHIFT_HOURS[emp.shift]` → `emp.standardHours` → `8`.
⚠️ A named shift ALWAYS wins. The 2026-07-30 defect was a caller *writing* `shift:'GEN'` by default,
not this precedence.

### 2.2 `att` — what the attendance feed says

`presentDays` · `absentDays` · `otHrs` · `lateHrs` · `earlyHrs` · `workHrs` ·
`weeklyOff` · `weeklyOffPresent` · `holiday` · `unpaidWorkedSat` · `equivalentDays` ·
`noRecord` (bool) · `otOverride` (bool)

Two flags carry meaning that is **not** obvious and must survive extraction:

- **`noRecord`** — no attendance document for this month ⇒ **base = 0**. Never a silent full month
  for someone who never worked.
- **`otOverride`** — this OT figure was **typed by the owner**, not read from the portal. It is the
  ONLY thing that lets an `appOnly` worker be paid OT. Set by the adapter from `md.override.ot`.

### 2.3 `period`

`daysInMonth` · `elapsedDays` · `fullMonth` · `monthStart` · `toDate`

### 2.4 `adjustments` — owner decisions for this month

`fines` · `bonus` · `latePenaltyDays` · `weeklyOffDockDays` · `restoreSaturdayDays` ·
`graceDays` · `payPerfectBonus`

### 2.5 `ledger` — the money account

`advancesThisMonth` · `advanceBalanceIn` · `openingBalance`

**`advances` (the array form) is NOT part of the contract.** Adapters sum it before calling. It
exists today only as crash-compatibility.

**`advanceRecover` and `loanInstallment` are DEAD** — retained as ignored inputs since 2026-07-13,
when loans were folded into one advance account. The core must not accept them; adapters drop them.

---

## 3. OUTPUT contract

### 3.1 Money — the fields that must never silently disappear

| Field | Meaning |
|---|---|
| `base` | Base pay for the period. |
| `otPay` | Overtime pay. |
| `perfectBonus` · `bonus` · `restoreSaturdayPay` · `gracePay` | Additive earnings. |
| `fines` · `latePenalty` · `weeklyOffDock` | Fixed deductions. |
| `advanceDue` · `advanceRecovered` | The advance account. |
| **`net`** | **THIS MONTH ONLY.** Signed; may be negative. |
| `openingBalance` | Balance carried in from last month. Signed. |
| **`payable`** | **`net + openingBalance` — WHAT THE WORKER IS ACTUALLY OWED.** |

> ⚠️ **Any surface showing a worker what he is owed MUST use `payable`, never `net`.**
> Printing `net` alone hid carried balances for 40 of 73 workers; the worst case showed
> **+₹6,815 to a worker who owed ₹37,610** — sign-flipped, not merely understated.

### 3.2 Explanation — how the number was reached

`type` · `effectiveRate` · `effectiveRemark` · `perDay` · `payableDays` · `presentDays` ·
`absentDays` · `paidDays` · `weeklyOff*` · `holiday` · `otHrs` · `otHrsNet` · `workHrs` ·
`dailyStdHrs` · `equivalentDays` · `saturdaysInPeriod` · `saturdaysCut` · `noAttendance` ·
`perfectEligible` · `perfectBonusDay` · `suggestedDockDays` · `suggestedWeeklyOffDock`

These are not decorative — they are what the owner reads to a worker at pay time. **The core returns
all of them; the node adapter currently drops 19 and must stop doing so.**

### 3.3 Invariants the core must uphold

```
payable          == net + openingBalance
net              == earnings - fixedDeductions - advanceRecovered      (SIGNED, never floored)
advanceRecovered == advanceDue                                          (full cut, always)
otHrsNet         >= 0                                                   (floored; never eats base)
base             >= 0
type='daily'     => otPay == 0                                          (OT already inside workHrs)
appOnly && !otOverride => otPay == 0
att.noRecord     => base == 0
```

---

## 4. Overrides — must live in the CORE, not in each adapter

Today `web/src/lib/paycalc.js` applies the owner's override and `jobs/lib/applyOverride.js` is a
hand-copied mirror of it. **Two copies of the same rule is the very disease being cured.**

`md.override = { days, ot }` — set independently:

- `days` → pay exactly that many days. `absentDays` is left un-floored so `max(0, elapsed − absent)`
  resolves back to exactly `days`. Clears `weeklyOff`, `weeklyOffPresent`, `holiday`,
  `unpaidWorkedSat`, `noRecord`.
- `ot` → `otHrs = ot`, `lateHrs = earlyHrs = 0`, **and `otOverride = true`**.

Setting only one must not disturb the other. Correcting OT previously dropped paid Sundays.

---

## 5. What the core must NOT do

- **No I/O.** No Firestore, no network, no `Date.now()`. Pure function of its inputs.
- **No month-key logic.** Adapters resolve the month and build `period`.
- **No locked-month awareness.** A paid month renders from a stored snapshot; that is the caller's job.
- **No formatting.** No `₹`, no rounding for display. Money returns as numbers rounded to 2 dp.

---

## 6. Migration order (Codex, 2026-07-30 — agreed)

1. ~~Resolve and effective-date the rulebook contradictions~~ — **DONE**, rulebook §9.
2. **Define this contract** — this document. ⬅ *you are here*
3. Extract the web paying logic **without changing results**.
4. Switch the **non-paying** node/Telegram adapter first; dual-run against the old node engine.
5. Shadow-run old vs core across current and historical unlocked months.
6. Switch the web paying adapter **only** after zero differences, behind an immediate rollback flag.
7. Retain the old web engine through one closed payroll cycle; remove it last.

**Gate on every step:** `node tests/payroll/compare.mjs` must stay at 100%, and the harness compares
`payable` — the field whose absence hid the worst defect found so far.

---

## 7. Open questions to settle BEFORE step 3

1. **The 19 display fields** — does the node adapter start returning them, or do payslips explicitly
   declare a smaller view? (Recommend: core returns everything, adapters project.)
2. **`unpaidWorkedSat`** is now inert — the writer was retired 2026-07-30 because the portal already
   deducts that Saturday. Does the core keep the subtraction for history, or drop it?
3. **12H rounds 11.5 → 12** (rulebook §6). Worker-adverse and inconsistent with the DSG decision.
   Owner re-confirm before it is cast into a shared core.
4. **Guard/driver lunch** — their divisors use the full duty span with no lunch deduction, unlike
   every shift. Owner to confirm.
