# Fixture disagreements — status

Deployment rule: no *unexplained* disagreement may ship. Intentional disagreement is fine.

Run `node tests/payroll/compare.mjs` to regenerate. Last run: **2026-07-30**.

```
cases: 33   comparisons: 132   agree: 132   disagree: 0
```

⚠️ **This file went stale within two days of being written** — it still claimed 28 cases / 84
comparisons after fixtures were added, and the Codex review caught it. Exactly the documentation rot
this whole session was spent removing. **Re-run the harness and update these numbers in the same
commit that changes fixtures.**

`payable` is now a compared field. Where a fixture declares no expected value for a field, the
harness still requires the TWO ENGINES TO AGREE — that parity check is what was missing when the Node
engine shipped with no `payable` at all while every declared field matched.

## Current status: ZERO disagreements

Both engines agree with the approved rules, and with each other, on all 132 comparisons.
Both live call-sites of the server engine pass their contract check.

## History — the 3 that were open, and how they closed

Earlier the same day the suite read `agree: 81, disagree: 3`. All three were **one fixture case
measured across three fields** (`base`, `otPay`, `net`), and on all three the app engine and the
server engine returned **identical figures**. There was never a disagreement *between the engines* —
only against an `expected` column deliberately left blank.

**The case:** `night-shift-past-midnight-ot` — a 12H-shift worker whose overtime crosses midnight.

**Why it was blank:** the working assumption (memory `payroll-night-ot-gap`) was that the biometric
portal DROPS hours after midnight, because it records one row per calendar day and a post-midnight
punch-out makes the row span negative time. If the input overtime figure were understated, no
calculation engine could be judged right or wrong on it.

**How it closed — the assumption was DISPROVEN (2026-07-28):**

1. `jobs/auditMidnightOt.js` found 50 cross-midnight nights across 17 workers in June–July 2026.
2. The app's own attendance engine (`web/src/lib/attendanceEngine.js`), which provably handles
   midnight via `workedHours()` adding 24 h, was run over the raw punches for all 17.
3. Its **monthly overtime totals matched the portal's exactly** — 17 of 17, net difference 0.01 h.
4. Per-day inspection confirmed it directly. Example, raju 2026-07-02: in `09:03`, out `01:32`,
   worked 16.48 h, **overtime credited 7.98 h**. Across 16 such nights: 127.95 h credited.

**Conclusion: cross-midnight overtime IS being credited correctly. Nothing was lost.** The
≈₹25,600 previously logged as "overtime at risk" is closed at **₹0 owed**. No portal access was
needed to establish this, and no worker top-up is due.

The fixture now carries a real expected value and passes normally.

## Fixture categories

- **Normative** — derived from the approved rulebook and owner decisions; the final authority on
  what payroll *should* calculate. All 28 current cases are normative.
- **Regression** — derived from real defects and unusual records: "what failure must never come
  back?" Code may reveal the case; code must never define the expected salary.

When a rule changes, the fixture encoding it needs an **effective date**, so recalculating a
historical month cannot silently apply today's rule to a period it never governed.
