// Runs BOTH payroll implementations against the same golden fixtures and prints a
// disagreement table. It CHANGES NOTHING — no Firestore, no network, no writes.
//
//   node tests/payroll/compare.mjs            # table
//   node tests/payroll/compare.mjs --json     # machine-readable
//
// Step 3 of the approved plan: produce input | expected | Node | web, then classify every
// disagreement as spec ambiguity / Node defect / web defect / fixture defect.
// NOTHING is refactored on the strength of this output — findings go to the owner first.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, CALL_SITE_CASES, FIELDS } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const nodeImpl = require(path.join(__dirname, '..', '..', 'jobs', 'salaryCalc.js'));
const webImpl = await import(path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'payroll.js'));

const JSON_OUT = process.argv.includes('--json');

// The two implementations take advances differently: the Node engine wants a ledger array,
// the web engine wants a pre-summed number. That interface drift is itself a finding — the
// adapter below exists only so the CALCULATIONS can be compared on equal footing.
function callNode(c) {
  const p = c.params;
  return nodeImpl.computePay({
    emp: c.emp, att: c.att,
    daysInMonth: p.daysInMonth, elapsedDays: p.elapsedDays, fullMonth: p.fullMonth,
    advances: p.advancesThisMonth ? [{ amount: p.advancesThisMonth }] : [],
    advanceBalanceIn: p.advanceBalanceIn || 0,
    fines: p.fines || 0, loanInstallment: p.loanInstallment || 0, bonus: p.bonus || 0,
    payPerfectBonus: !!p.payPerfectBonus,
    latePenaltyDays: p.latePenaltyDays || 0, weeklyOffDockDays: p.weeklyOffDockDays || 0,
    monthStart: p.monthStart, toDate: p.toDate,
  });
}

function callWeb(c) {
  const p = c.params;
  return webImpl.computePay({
    emp: c.emp, att: c.att,
    daysInMonth: p.daysInMonth, elapsedDays: p.elapsedDays, fullMonth: p.fullMonth,
    advancesThisMonth: p.advancesThisMonth || 0,
    advanceBalanceIn: p.advanceBalanceIn || 0,
    fines: p.fines || 0, loanInstallment: p.loanInstallment || 0, bonus: p.bonus || 0,
    restoreSaturdayDays: p.restoreSaturdayDays || 0, graceDays: p.graceDays || 0,
    payPerfectBonus: !!p.payPerfectBonus,
    latePenaltyDays: p.latePenaltyDays || 0, weeklyOffDockDays: p.weeklyOffDockDays || 0,
    openingBalance: p.openingBalance || 0,
    monthStart: p.monthStart, toDate: p.toDate,
  });
}

// Money compare: both must be finite and equal to the paisa. A non-number (string
// concatenation, NaN) is never "equal" — it is a defect by definition.
const money = v => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 100) / 100 : v;
const same = (a, b) => {
  const x = money(a), y = money(b);
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  return Math.abs(x - y) < 0.005;
};

function classify({ expected, nodeVal, webVal }) {
  if (expected === null || expected === undefined) return 'specification ambiguity';
  const nodeOK = same(nodeVal, expected);
  const webOK = same(webVal, expected);
  if (nodeOK && webOK) return 'agree';
  if (webOK && !nodeOK) return 'Node implementation defect';
  if (nodeOK && !webOK) return 'web implementation defect';
  return 'BOTH disagree with the rules — spec ambiguity or fixture defect (needs owner review)';
}

const rows = [];
for (const c of CASES) {
  let nodeRes = null, nodeErr = null, webRes = null, webErr = null;
  try { nodeRes = callNode(c); } catch (e) { nodeErr = e.message; }
  try { webRes = callWeb(c); } catch (e) { webErr = e.message; }

  for (const f of FIELDS) {
    const expected = c.expected ? c.expected[f] : null;
    const nodeVal = nodeErr ? `THREW: ${nodeErr}` : nodeRes?.[f];
    const webVal = webErr ? `THREW: ${webErr}` : webRes?.[f];
    const verdict = classify({ expected, nodeVal, webVal });
    const agrees = verdict === 'agree';
    rows.push({
      case: c.id, rule: c.rule, field: f,
      expected, node: money(nodeVal), web: money(webVal),
      verdict, agrees,
      derivation: c.derivation || null, ambiguity: c.ambiguity || null,
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const disagreements = rows.filter(r => !r.agrees);
  const pad = (s, n) => String(s ?? '—').padEnd(n).slice(0, n);
  const num = v => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '—')).padStart(12).slice(-12);

  console.log('\nPAYROLL DISAGREEMENT TABLE');
  console.log('Fixtures derived from the approved rulebook. Nothing here has been refactored.\n');
  console.log(pad('case', 40) + pad('field', 8) + num('expected') + num('Node') + num('web') + '  verdict');
  console.log('-'.repeat(132));
  for (const r of rows) {
    if (r.agrees) continue;
    console.log(pad(r.case, 40) + pad(r.field, 8) + num(r.expected) + num(r.node) + num(r.web) + '  ' + r.verdict);
  }

  const byVerdict = {};
  for (const r of disagreements) (byVerdict[r.verdict] ||= []).push(r);

  console.log('\n\nCLASSIFICATION SUMMARY');
  console.log('-'.repeat(132));
  console.log(`cases: ${CASES.length}   comparisons: ${rows.length}   agree: ${rows.length - disagreements.length}   disagree: ${disagreements.length}`);
  for (const [v, list] of Object.entries(byVerdict)) {
    const cases = [...new Set(list.map(r => r.case))];
    console.log(`\n  ${v}  (${cases.length} case${cases.length === 1 ? '' : 's'})`);
    for (const id of cases) {
      const c = CASES.find(x => x.id === id);
      console.log(`    · ${id} — ${c.rule}`);
      if (c.ambiguity) console.log(`        ${c.ambiguity.replace(/\s+/g, ' ')}`);
    }
  }
  console.log('\n\nCALL-SITE CONTRACT CHECK');
  console.log('Do the engine\'s real callers actually work? (interface, not arithmetic)');
  console.log('-'.repeat(132));
  for (const cs of CALL_SITE_CASES) {
    let verdict;
    try {
      const r = nodeImpl.computePay(cs.args);
      verdict = `OK — net ₹${money(r.net)}`;
    } catch (e) {
      verdict = `BROKEN — ${e.constructor.name}: ${e.message}`;
    }
    console.log(`  ${cs.file.padEnd(32)} ${cs.what}`);
    console.log(`      ${verdict}`);
  }

  console.log('\nNext step is owner review of these findings. Refactor nothing until they are approved.\n');
}
