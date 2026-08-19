// Fill in three workers the portal created with placeholder names (owner gave the details
// 2026-08-20 01:03): they existed as name="<code>", dept=DEMO, no salary — so they were invisible
// as people and would have been paid nothing.
//   DRY:   node jobs/addNewWorkers.js
//   APPLY: DRY_RUN=false node jobs/addNewWorkers.js
// nameLocked/deptLocked are LOAD-BEARING: syncEmployees.js overwrites name+dept from the portal on
// every run unless these are set, which would silently revert them to "00000107"/DEMO tonight.
// joinDate is set from each worker's FIRST PUNCH — without it, an advance given while the previous
// month is still open gets attributed to a month they had not even joined (exactly the bug fixed
// for the six August joiners on 2026-08-20).
const { db } = require('./lib/firestore');
const fs = require('fs');

const WORKERS = [
  { code: '00000107', name: 'sajma',    dept: 'FITTING', gender: 'Female', shift: 'GEN', amount: 8000, joinDate: '2026-08-16' },
  { code: '00000109', name: 'shervano', dept: 'FITTING', gender: 'Female', shift: 'GEN', amount: 8000, joinDate: '2026-08-16' },
  { code: '00000113', name: 'kiran',    dept: 'POWDER',  gender: 'Female', shift: 'GEN', amount: 8000, joinDate: '2026-08-17' },
];
const DRY = process.env.DRY_RUN !== 'false';

(async () => {
  const before = {};
  for (const w of WORKERS) {
    const ref = db().collection('att_salary').doc(w.code);
    const snap = await ref.get();
    before[w.code] = snap.data() || null;
    const patch = {
      code: w.code, name: w.name, nameLocked: true, dept: w.dept, deptLocked: true,
      gender: w.gender, shift: w.shift, amount: w.amount, type: 'monthly',
      active: true, joinDate: w.joinDate,
    };
    if (DRY) { console.log(`[DRY] ${w.code}  ${JSON.stringify(snap.data() || {})}\n        ->  ${JSON.stringify(patch)}`); continue; }
    await ref.set(patch, { merge: true });
    console.log(`${w.code} ${w.name.padEnd(10)} ${w.dept.padEnd(8)} ₹${w.amount}/mo  joined ${w.joinDate}  ✓`);
  }
  if (!DRY) {
    const f = require('path').resolve(__dirname, 'rules_backup', 'new-workers-before-' + Date.now() + '.json');
    fs.writeFileSync(f, JSON.stringify(before, null, 2));
    console.log('backup of previous values:', f);
  }
  console.log(DRY ? 'DRY run — nothing written. Re-run with DRY_RUN=false to apply.' : 'APPLIED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
