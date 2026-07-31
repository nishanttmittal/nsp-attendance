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

⚠️ **CORRECTED 2026-07-31 (Codex round 3).** This section previously said "none is a money field."
That is **false**: `restoreSaturdayPay` and `gracePay` are monetary earnings.

What is true — and was verified before this correction was written — is that node's `net` **does
include both amounts** (`jobs/salaryCalc.js:120` adds them into `earnings`). **No worker was ever
underpaid by this.** What node omits is the *itemisation*: a payslip cannot show the worker that
₹250 of his pay was a grace top-up. That is an explanation gap, not a second `openingBalance` defect.

The remaining 17 keys are display and audit values the PWA renders. **This is why the gap survived:**
the harness compared `base`, `otPay` and `net`, all of which matched, while `payable` was absent from
node altogether and 40 workers' settlement was misreported.

**Inputs also differ:** node accepts `advances` (a ledger array) *and* `advancesThisMonth` (a number);
web accepts only the latter. Node's dual acceptance exists solely because two live callers were
written against web's signature and crashed.

**Rule for the core: it returns ONE shape. Adapters may drop fields; they may never add or rename.**

---

## 2. INPUT contract

```
computePay({ emp, att, period, adjustments, ledger }) -> Payslip
```

Grouped deliberately. Today's flat **19**-argument signature (`web/src/lib/payroll.js:23` — counted,
not estimated; this document said 18 until 2026-07-31) is how `openingBalance` got passed into a void
by one caller and never passed at all by another.

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

These are not decorative — they are what the owner reads to a worker at pay time.

**SETTLED (was contradictory until 2026-07-31): the core returns the full shape; an adapter MAY
project a smaller view, but only by explicitly naming the fields it keeps — never by silently
happening to return fewer.** §1 said adapters may drop fields, this section said node must stop
dropping all 19, and §7 reopened the question. One rule now: the core is complete, projection is
deliberate and declared. `payable` is never projectable (§3.1).

### 3.3 Invariants the core must uphold — **8 of them**

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

1. ~~The 19 display fields~~ — **SETTLED 2026-07-31** (§3.2): core complete, projection declared.
2. **`unpaidWorkedSat`** is inert — the writer was retired 2026-07-30 because the portal already
   deducts that Saturday. Codex's answer (accepted): **do not carry it into the core.** Scan every
   stored attendance month for a non-zero value first (`jobs/auditUnpaidWorkedSat.js`), then remove
   the writer capability *and* both engine subtractions as one isolated change. A retired writer
   plus a live deduction is a latent double-deduction path.
3. ~~12H rounds 11.5 → 12~~ — **SETTLED**, owner 2026-07-30: KEPT. Not an inconsistency — the 12H
   shift is worked by a guard and a supervisor who are on duty throughout, the same basis as §7.4.
4. ~~Guard/driver lunch~~ — **SETTLED**, owner 2026-07-30: no deduction, full span paid.

---

## 8. Lifecycle — added 2026-07-31 (Codex round 3). **Step 3 is blocked until this is agreed.**

The contract above describes one calculation. It said nothing about what happens to that result over
time, and every high-severity defect of round 3 lived in exactly that gap. A pure core does not fix
them — but extracting the core without deciding them freezes the ambiguity in place.

### 8.1 A locked month is IMMUTABLE

Once a month is locked, **every figure the owner can be shown for it must come from the stored
snapshot** — not recomputed. Today `paymentBreakdown()` stores 16 fields and the Person screen
overlays them onto a *freshly recomputed* pay, so any field outside those 16 silently follows
today's rules. The locked-register PDF is worse: it reads the **current** salary rate, current paid
days, current OT and the current advance ledger.

The stored payment amount never moves, so **nobody has been mis-paid**. What breaks is the record:
give a worker a raise, reprint June, and June shows the new rate. In a dispute the owner cannot
reproduce what he showed the worker.

**Rule: a locked month renders from its snapshot or it renders "snapshot unavailable" — never from a
recomputation.** Months locked before snapshots existed (June 2026) must be labelled as legacy, not
silently recomputed to look complete.

### 8.2 Snapshots carry versions

Every stored snapshot records `snapshotVersion` (the shape) and `rulesVersion` (the rulebook edition
that produced it). Without these, a later reader cannot tell a missing field from a zero, and cannot
tell which rules applied. Backfill is not required — an absent version means "pre-versioning, legacy".

### 8.3 The carry chain

```
months[m].payment.closing == months[m+1].openingBalance        for every locked m
```

**Locking is chronological.** Writing month *m*'s carry into *m+1* when *m+1* is already locked
desyncs the chain: *m+1*'s payment stays frozen around the old balance while its opening balance
moves. To redo an earlier month, unlock the later ones first. Enforced 2026-07-31 in
`lockMonthDirect` and `worker.js` (`unlockMonthDirect` had always refused it).

### 8.4 Transaction boundaries

A read-modify-write on a whole array or a whole `months` map is **not** safe: `att_salary` has
several concurrent writers (owner app, manager queue, Hisab outbox, the 5-minute worker).

- **Append** → `arrayUnion` only.
- **Remove or reorder** → a Firestore transaction. A post-write count check cannot detect a lost
  concurrent append, because it compares against the stale pre-read length. (This is exactly how a
  manager's advance could be erased with no error; fixed 2026-07-31.)
- **A month's lock/unlock** → must not be a blind overwrite of `months`.

### 8.5 Money may not enter a sealed history

An advance must never be recorded **in** a locked month, nor **before** one. In both cases the cash
is paid out and no salary run will ever deduct it. Every write path enforces this — app, direct
write and background worker — not just the screen that happens to have a check.

### 8.6 Restores are not point-in-time

Backups walk collections sequentially. **Executable queues must be quarantined before any live
restore**, or the worker replays jobs whose effects are already in the restored data. Firestore
`Timestamp` values do not survive JSON: they must be revived on restore, and the drill must assert
the restored *type*, not just the value (see `jobs/restoreDrill.js`).
