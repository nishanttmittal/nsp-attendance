// Applies the matched April salaries to att_salary. Writes ONLY {amount, type:'monthly',
// active:true} (merge) — never touches name/dept/advances/months. Dry by default; set
// APPLY=true to write.  node importSalaryApply.js "/path/salary april 2026.xlsx"
const { db } = require('./lib/firestore');
const { runMatch } = require('./importSalaryMatch');

// owner-confirmed matches the fuzzy step left as "probable/no-match": app code -> monthly rate
const OVERRIDES = {
  '00000293': 18500, // rakhtiv ansari ahjaj -> rakib ansari ahjaj
  '00000099': 14000, // nand kishor -> anand kishor ray powder
  '00000128': 14000, // lovekush press -> luvkush pressman
  '00000105': 12000, // kindal -> kinder lal press helper
  '00000110': 27500, // AVNISH july -> abnesh tool room
};

(async () => {
  const file = process.argv[2];
  const apply = process.env.APPLY === 'true';
  const { confident } = await runMatch(file);

  // code -> { rate, name }
  const plan = {};
  for (const p of confident) plan[p.best.code] = { rate: p.rate, name: p.best.name, from: p.name };
  for (const [code, rate] of Object.entries(OVERRIDES)) {
    const doc = await db().collection('att_salary').doc(code).get();
    plan[code] = { rate, name: doc.exists ? doc.data().name : code, from: '(confirmed)' };
  }

  const entries = Object.entries(plan);
  console.log(`${apply ? 'APPLYING' : 'DRY (preview)'} — ${entries.length} monthly salaries\n`);
  let n = 0;
  for (const [code, v] of entries) {
    console.log(`  ${apply ? '✔' : '·'} ${v.name} (${code})  ₹${v.rate.toLocaleString('en-IN')}`);
    if (apply) {
      await db().collection('att_salary').doc(code).set(
        { type: 'monthly', amount: Number(v.rate), active: true }, { merge: true });
      n++;
    }
  }
  console.log(`\n${apply ? 'Wrote ' + n + ' salaries.' : 'No writes (set APPLY=true to write).'}`);
})().catch(e => { console.error(e); process.exit(1); });
