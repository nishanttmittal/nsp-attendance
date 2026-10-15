// Pure-engine tests (no Firebase): `node --test test/` from web/. computePay only — paycalc pulls data.js/firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePay } from '../src/lib/payroll.js';
import { createRequire } from 'node:module';
const { applyOverride } = createRequire(import.meta.url)('../../jobs/lib/applyOverride.js');

// September 2026, full month, as monthCtx('2026-09') builds it.
const ctx = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: new Date(Date.UTC(2026, 8, 1)), toDate: new Date(Date.UTC(2026, 8, 30)) };
const shokin = { code: '00000125', type: 'monthly', amount: 10500, shift: 'GEN', joinDate: '2026-09-04' };   // ₹350/day
// what paycalc / applyOverride hand the engine for a typed days box
const boxed = (days) => applyOverride({ presentDays: 20, absentDays: 3, otHrs: 0, lateHrs: 0, earlyHrs: 0 }, { override: { days } }, ctx.elapsedDays);

test('mid-month joiner: owner days box is literal (Shokin: join 04-09, box 30 → 30 days)', () => {
  const p = computePay({ emp: shokin, att: boxed(30), ...ctx });
  assert.equal(p.paidDays, 30);
  assert.equal(p.base, 10500);
  assert.equal(p.payableDays, 27);          // window display unchanged
  assert.equal(p.uncountedDays, 0);
  const p28 = computePay({ emp: shokin, att: boxed(28), ...ctx });
  assert.equal(p28.paidDays, 28); assert.equal(p28.base, 9800);
  const p26 = computePay({ emp: shokin, att: boxed(26), ...ctx });
  assert.equal(p26.paidDays, 26); assert.equal(p26.base, 9100);
});

test('mid-month joiner without a days box: still capped to the employment window (27 days)', () => {
  const p = computePay({ emp: shokin, att: { presentDays: 27, absentDays: 3, otHrs: 0, lateHrs: 0, earlyHrs: 0 }, ...ctx });
  assert.equal(p.paidDays, 27);
  assert.equal(p.base, 9450);
});

test('full-month worker: days box above the month still pays the extra day (unchanged)', () => {
  const emp = { ...shokin, joinDate: '2026-01-10' };
  const p = computePay({ emp, att: boxed(31), ...ctx });
  assert.equal(p.paidDays, 31); assert.equal(p.base, 10850);
  const q = computePay({ emp, att: { presentDays: 24, absentDays: 2, weeklyOff: 4, otHrs: 0, lateHrs: 0, earlyHrs: 0 }, ...ctx });
  assert.equal(q.paidDays, 28); assert.equal(q.base, 9800);
});

test('zero present = zero pay still holds; days box 0 pays 0', () => {
  const emp = { ...shokin, joinDate: '2026-01-10' };
  assert.equal(computePay({ emp, att: { presentDays: 0, absentDays: 8, otHrs: 0, lateHrs: 0, earlyHrs: 0 }, ...ctx }).base, 0);
  assert.equal(computePay({ emp, att: boxed(0), ...ctx }).base, 0);
});

test('daily wager with a days box: wage × days (unchanged)', () => {
  const emp = { code: 'd1', type: 'daily', wage: 700, joinDate: '2026-09-10' };
  const p = computePay({ emp, att: boxed(25), ...ctx });
  assert.equal(p.base, 17500); assert.equal(p.paidDays, 25);
});
