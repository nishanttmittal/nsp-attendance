// REAL call-site checks for the Node payroll engine.
//
// WHY THIS FILE EXISTS (Codex round 3, 2026-07-31): the previous "call-site contract check" never
// imported or executed either caller. It called salaryCalc.computePay() with hand-written arguments
// and printed the results under the callers' filenames. It therefore could not catch the exact
// regressions it was there to catch — a caller forgetting `openingBalance`, forgetting the owner
// override, or printing NET instead of PAYABLE. It reported "healthy" while all three were possible.
//
// What is checked here:
//   1. jobs/lib/payslipText.js — the real module is REQUIRED and RUN, with Firestore stubbed out.
//      This exercises the actual wiring: applyOverride, openingBalance, and the payslip template.
//   2. jobs/worker.js — cannot be executed (it is a job runner that connects to Firestore on load),
//      so its payslip branch is checked at SOURCE level. That is weaker, and is labelled as such.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('module');
const JOBS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../jobs');

// Replace jobs/lib/firestore.js in the require cache BEFORE payslipText.js loads it, so the real
// module never opens a connection. Nothing touches the live database.
function stubFirestore(empDoc, attDoc) {
  const id = require.resolve(path.join(JOBS, 'lib/firestore.js'));
  const snap = (d) => ({ exists: !!d, data: () => d });
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = {
    db: () => ({ collection: (c) => ({ doc: () => ({ get: async () => snap(c === 'att_salary' ? empDoc : attDoc) }) }) }),
  };
  require.cache[id] = m;
  delete require.cache[require.resolve(path.join(JOBS, 'lib/payslipText.js'))];   // force a fresh load
}

const rupees = (s) => [...s.matchAll(/₹([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));

// Runs the REAL payslip builder end to end and asserts the three things that have actually broken.
export async function checkPayslipText() {
  const out = [];
  const now = new Date();
  const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const OPENING = -3000;   // this worker OWES ₹3,000 carried in — the case that was misreported
  const emp = {
    name: 'FIXTURE WORKER', type: 'monthly', amount: 15000, shift: 'GEN', advances: [],
    months: { [mk]: { openingBalance: OPENING, override: { days: 26 } } },
  };
  const att = { presentDays: 20, absentDays: 2, otHrs: 10, lateHrs: 0, earlyHrs: 0 };
  stubFirestore(emp, att);

  let text;
  try {
    const { buildPayslipText } = require(path.join(JOBS, 'lib/payslipText.js'));
    text = await buildPayslipText('FIXTURE');
  } catch (e) {
    return [{ ok: false, what: 'jobs/lib/payslipText.js runs at all', detail: `${e.constructor.name}: ${e.message}` }];
  }

  out.push({ ok: /Payslip/.test(text), what: 'builds a payslip', detail: text.split('\n')[0] });

  // 1. A carried balance must reach the worker. Printing NET alone is what showed +₹6,815 to a
  //    worker who owed ₹37,610 — sign-flipped, not merely understated.
  out.push({
    ok: /PAYABLE/.test(text) && /Previous balance/.test(text),
    what: 'shows Previous balance → PAYABLE when a balance is carried',
    detail: (text.split('\n').find((l) => /PAYABLE/.test(l)) || 'NO PAYABLE LINE — carried balance hidden').replace(/<[^>]+>/g, ''),
  });

  // 2. PAYABLE must equal NET + the carried balance, not be a relabelled NET.
  const netLine = text.split('\n').find((l) => /NET/.test(l)) || '';
  const payLine = text.split('\n').find((l) => /PAYABLE/.test(l)) || '';
  const net = rupees(netLine)[0];
  const payable = rupees(payLine).pop();
  const wanted = net != null && payable != null ? Math.round((net + OPENING) * 100) / 100 : null;
  out.push({
    ok: wanted != null && Math.abs(payable - wanted) < 0.5,
    what: 'PAYABLE == NET + openingBalance',
    detail: `net ₹${net} + carried ₹${OPENING} = ₹${wanted}; payslip says ₹${payable}`,
  });

  // 3. The owner's override must be applied by the Telegram path too. Without applyOverride the
  //    payslip reports the raw portal figure (20 days) instead of the owner's decision (26).
  const presLine = text.split('\n').find((l) => /Present/.test(l)) || '';
  out.push({
    ok: /Present\s*26\b/.test(presLine.replace(/<[^>]+>/g, '')),
    what: "applies the owner's days override (26, not the raw 20)",
    detail: presLine.replace(/<[^>]+>/g, '').trim() || '(no Present line)',
  });
  return out;
}

// SOURCE-level only — worker.js cannot be imported without starting the job runner.
export function checkWorkerSource() {
  const src = readFileSync(path.join(JOBS, 'worker.js'), 'utf8');
  const calls = src.split('computePay(').slice(1).map((s) => s.slice(0, 900));
  return [
    {
      ok: calls.length > 0 && calls.every((c) => /openingBalance/.test(c)),
      what: 'every computePay() call passes openingBalance',
      detail: `${calls.filter((c) => /openingBalance/.test(c)).length}/${calls.length} call site(s)`,
    },
    {
      ok: /applyOverride\(/.test(src),
      what: "applies the owner's override before computing",
      detail: /applyOverride\(/.test(src) ? 'applyOverride() used' : 'applyOverride() NOT used — owner corrections ignored',
    },
    {
      ok: /PAYABLE/.test(src),
      what: 'payslip text reports PAYABLE, not NET alone',
      detail: /PAYABLE/.test(src) ? 'PAYABLE present' : 'no PAYABLE — carried balances hidden',
    },
  ];
}
