// Stamp the CONTRACTOR on welders whose name doesn't contain it (owner told me 2026-08-19 01:47).
// Additive: writes ONE new field `contractor` on att_salary/{code}; touches nothing else — no salary,
// no months, no advances. merge:true, so a re-run is harmless and no read is needed (writes are a
// separate quota bucket from reads, so this works even while reads are exhausted).
//   DRY:   node jobs/setWelderContractors.js
//   APPLY: DRY_RUN=false node jobs/setWelderContractors.js
const { db } = require('./lib/firestore');

const MAP = [
  ['00000302', 'kamtaprasad welder',      'Jitender'],
  ['00000077', 'rakesh singh welder',     'Naveen'],
  ['00000093', 'hardev welder',           'Naveen'],
  ['00000067', 'virender welder',         'Naveen'],   // removed (owner corrected 01:49: Naveen, not Jitender)
  ['00000075', 'rajesh kumar welder raju', 'Naveen'],  // removed (owner corrected 01:49)
];
const DRY = process.env.DRY_RUN !== 'false';

(async () => {
  for (const [code, name, contractor] of MAP) {
    if (DRY) { console.log(`[DRY] ${code} ${name.padEnd(26)} -> contractor="${contractor}"`); continue; }
    await db().collection('att_salary').doc(code).set({ contractor }, { merge: true });
    console.log(`${code} ${name.padEnd(26)} -> contractor="${contractor}"`);
  }
  console.log(DRY ? 'DRY run — nothing written. Re-run with DRY_RUN=false to apply.' : 'APPLIED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
