// Update monthly SALARY + ADVANCE from Desktop 'salary and advance may.xlsx' (name col A,
// SALARY RATE col C, advance col D). DRY by default (preview only). APPLY=true to write.
// ADV_MODE = balance (set May opening advance balance, default) | entry (add a dated May advance).
const path = require('path');
const XLSX = require('xlsx');
const { runMatch } = require('./importSalaryMatch');
const { db } = require('./lib/firestore');

const FILE = '/mnt/c/Users/lenovo/Desktop/salary and advance may.xlsx';
const APPLY = process.env.APPLY === 'true';
const ADV_MODE = process.env.ADV_MODE || 'balance';
const MK = '2026-05';
const OVERRIDE = { // excel name (lowercased) -> machine code (owner-confirmed, from April work)
  'rakhtiv ansari ahjaj': '00000293', 'nand kishor': '00000099', 'lovekush press': '00000128',
  'kindal': '00000105', 'avnish july': '00000110', 'sonu july': '00000018',
  // 2026-06-14: the 'unmatched' batch, located in the app under fuller names
  'radhey may': 'APP-RADHEY', 'akshay': '00000095', 'somvati': '00000091', 'shivani': '00000089',
  'sukhrani': '00000086', 'mamta': '00000082', 'imran': '00000081', 'poonam': '00000080', 'sahiba': '00000083',
};
// optional: restrict the apply to these excel names only (comma-separated, lowercased)
const ONLY_NAMES = (process.env.ONLY_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const r0 = n => Math.round(Number(n) || 0);

// the April Excel has the SAME roster/naming and matches ~43 people cleanly — reuse its map.
const MAP_FILE = '/mnt/c/Users/lenovo/Desktop/salary april 2026.xlsx';

(async () => {
  // name -> code map (fuzzy matcher on the April file, which matches the same names + overrides)
  const { confident } = await runMatch(MAP_FILE);
  const map = {}; confident.forEach(p => { map[p.name.toLowerCase()] = p.best.code; });
  Object.assign(map, OVERRIDE);

  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets.Sheet1, { header: 1, defval: '' });
  const sal = {}; (await db().collection('att_salary').get()).forEach(d => { sal[d.id] = d.data(); });

  const matched = [], unmatched = [];
  for (const row of rows.slice(1)) {
    const name = String(row[0] || '').trim();
    const salary = Number(row[2]) || 0, advance = Number(row[3]) || 0;
    if (!name || (!salary && !advance)) continue;
    if (ONLY_NAMES.length && !ONLY_NAMES.includes(name.toLowerCase())) continue;  // restrict to a subset
    const code = map[name.toLowerCase()];
    if (!code) { unmatched.push(name); continue; }
    const cur = sal[code] || {};
    matched.push({ name, code, curAmount: cur.amount || cur.wage || 0, newSalary: salary, advance: r0(advance) });
  }

  console.log(`File: salary and advance may.xlsx — ${matched.length} matched, ${unmatched.length} unmatched\n`);
  console.log('name'.padEnd(22) + 'code'.padEnd(11) + 'cur₹'.padStart(8) + ' → newSal₹'.padStart(10) + '   advance₹'.padStart(11));
  matched.forEach(m => console.log(
    m.name.slice(0, 21).padEnd(22) + m.code.padEnd(11) + String(m.curAmount).padStart(8) + String(m.newSalary).padStart(10) + String(m.advance).padStart(13)));
  if (unmatched.length) console.log('\nUNMATCHED (skipped):', unmatched.join(', '));
  console.log(`\nADV_MODE=${ADV_MODE} (${ADV_MODE === 'balance' ? `set months.${MK}.advanceBalanceIn` : `add a dated ${MK} advance entry`})`);

  if (!APPLY) { console.log('\n=== DRY RUN — nothing written. Re-run with APPLY=true to save. ==='); return; }

  let n = 0;
  for (const m of matched) {
    const patch = { type: 'monthly', amount: m.newSalary };
    const cur = sal[m.code] || {};
    if (ADV_MODE === 'balance') {
      const months = { ...(cur.months || {}) };
      months[MK] = { ...(months[MK] || {}), advanceBalanceIn: m.advance };
      patch.months = months;
    } else {
      const advances = [...(cur.advances || []), { date: `${MK}-01`, amount: m.advance, mode: 'cash', remark: 'May advance (import)' }];
      patch.advances = advances;
    }
    await db().collection('att_salary').doc(m.code).set(patch, { merge: true });
    n++;
  }
  console.log(`\n=== APPLIED to ${n} employees (salary + advance ${ADV_MODE}). ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
