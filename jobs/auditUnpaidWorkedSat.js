// Scan EVERY stored month for a non-zero `unpaidWorkedSat`, across every worker.
//
// WHY THIS IS A SCRIPT AND NOT A ONE-OFF QUERY (Codex round 3, 2026-07-31): "all values are
// currently zero" had been asserted in review briefs with no saved artifact behind it. A claim that
// cannot be re-run is not evidence. This can be re-run, and it prints what it actually found.
//
// WHAT IT IS FOR: `unpaidWorkedSat` deducts a worked-but-unearned Saturday from paid days. The
// portal ALREADY moves that Saturday into Absent Days (verified across a full month: the five
// attendance columns sum exactly to days-in-month for 54 of 55 workers), so applying it again
// double-deducts. The writer was retired 2026-07-30; both engines still subtract the stored value.
// Before that subtraction is removed, this proves no stored month is relying on it.
//
// READ-ONLY. Writes nothing, changes nothing.
//   node jobs/auditUnpaidWorkedSat.js
const { db } = require('./lib/firestore');

(async () => {
  const hits = [];
  let months = 0, docs = 0;

  const salary = await db().collection('att_salary').get();
  salary.forEach((d) => {
    docs++;
    const e = d.data() || {};
    for (const [mk, md] of Object.entries(e.months || {})) {
      months++;
      const v = Number((md || {}).unpaidWorkedSat || 0);
      if (v) hits.push({ where: 'att_salary', code: d.id, name: e.name || d.id, month: mk, value: v, type: e.type || 'monthly' });
    }
  });

  // The engines read `att.unpaidWorkedSat`, so check the attendance feed too — a value could live
  // there without ever appearing in months[].
  const att = await db().collection('att_attendance').get();
  att.forEach((d) => {
    const a = d.data() || {};
    const v = Number(a.unpaidWorkedSat || 0);
    if (v) hits.push({ where: 'att_attendance', code: d.id, name: a.name || d.id, month: a.month || '(doc)', value: v, type: '' });
  });

  console.log(`Scanned ${docs} worker record(s), ${months} stored month(s), plus ${att.size} attendance doc(s).\n`);
  if (!hits.length) {
    console.log('✅ NO non-zero unpaidWorkedSat anywhere.');
    console.log('   Removing the subtraction from both engines cannot change any stored result.');
    process.exit(0);
  }
  console.log(`🚨 ${hits.length} non-zero value(s) — removing the subtraction WOULD change pay for these:\n`);
  console.log('  where'.padEnd(18) + 'code'.padEnd(12) + 'name'.padEnd(22) + 'month'.padEnd(10) + 'value');
  console.log('  ' + '-'.repeat(74));
  for (const h of hits) {
    console.log('  ' + h.where.padEnd(16) + String(h.code).padEnd(12) + String(h.name).slice(0, 20).padEnd(22) + String(h.month).padEnd(10) + h.value);
  }
  console.log('\nDo NOT remove the subtraction until each of these is understood.');
  process.exit(1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
