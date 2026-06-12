// Imports the remaining salaries (may - present without salary.xlsx → Set salary col) and the
// advance balances (salary may advance.xlsx → name + amount) into att_salary. Advances go to
// months['2026-06'].advanceBalanceIn (the engine's carried opening balance). Dry by default.
const XLSX = require('xlsx');
const { db } = require('./lib/firestore');
const { runMatch } = require('./importSalaryMatch');

const PAY_MONTH = '2026-06';
const OVERRIDE = {
  'rakhtiv ansari ahjaj': '00000293', 'nand kishor': '00000099', 'lovekush press': '00000128',
  'kindal': '00000105', 'avnish july': '00000110', 'sonu july': '00000018',
  'radhey may': 'APP-RADHEY', 'dinesh': 'APP-DINESH',
  // new joiners (their advances, names differ from the April file)
  'akshay': '00000095', 'somvati': '00000091', 'shivani': '00000089', 'sukhrani': '00000086', 'mamta': '00000082',
};

(async () => {
  const apply = process.env.APPLY === 'true';
  // 1) remaining salaries
  const salWb = XLSX.readFile('/mnt/c/Users/lenovo/Desktop/may - present without salary.xlsx');
  const salRows = XLSX.utils.sheet_to_json(salWb.Sheets['Need salary'], { header: 1, defval: '' }).slice(1);
  const salaries = salRows.map(r => ({ code: String(r[1] || '').trim(), name: r[0], amount: Number(r[5]) }))
    .filter(s => s.code && s.amount > 0);

  // 2) advances → match name to code
  const { confident } = await runMatch('/mnt/c/Users/lenovo/Desktop/salary april 2026.xlsx');
  const map = {}; confident.forEach(p => { map[p.name.toLowerCase()] = p.best.code; }); Object.assign(map, OVERRIDE);
  const advWb = XLSX.readFile('/mnt/c/Users/lenovo/Desktop/salary may advance.xlsx');
  const advRows = XLSX.utils.sheet_to_json(advWb.Sheets[advWb.SheetNames[0]], { header: 1, defval: '' });
  const advances = [], unmatched = [];
  for (const r of advRows) {
    const name = String(r[0] || '').trim(); const amt = Number(r[1]);
    if (!name || !(amt > 0)) continue;
    const code = map[name.toLowerCase()];
    if (code) advances.push({ code, name, amt }); else unmatched.push(name + ' (₹' + Math.round(amt) + ')');
  }

  console.log(`${apply ? 'APPLYING' : 'DRY'} — ${salaries.length} salaries, ${advances.length} advances\n`);
  console.log('SALARIES:'); salaries.forEach(s => console.log(`  ${s.name} (${s.code}) ₹${s.amount}`));
  console.log('\nADVANCES → opening balance (' + PAY_MONTH + '):');
  advances.forEach(a => console.log(`  ${a.name} (${a.code}) ₹${Math.round(a.amt).toLocaleString('en-IN')}`));
  if (unmatched.length) console.log('\n⚠️ advance names NOT matched (skipped):', unmatched.join(', '));

  if (apply) {
    const fdb = db();
    for (const s of salaries) await fdb.collection('att_salary').doc(s.code).set({ type: 'monthly', amount: s.amount, active: true }, { merge: true });
    for (const a of advances) await fdb.collection('att_salary').doc(a.code).set({ months: { [PAY_MONTH]: { advanceBalanceIn: Math.round(a.amt) } } }, { merge: true });
    console.log(`\nWrote ${salaries.length} salaries + ${advances.length} advance balances.`);
  } else console.log('\n(DRY — set APPLY=true to write.)');
})().catch(e => { console.error(e); process.exit(1); });
