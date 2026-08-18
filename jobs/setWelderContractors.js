// Stamp which CONTRACTOR each welder works under (owner, 2026-08-19).
// Additive: writes only `contractor` and/or `contractorHistory` on att_salary/{code} — never salary,
// months or advances. merge:true, so re-running is harmless. No reads, so this works even while the
// Firestore READ quota is exhausted (reads and writes are separate buckets).
//   DRY:   node jobs/setWelderContractors.js
//   APPLY: DRY_RUN=false node jobs/setWelderContractors.js
//
// Welders MOVE between contractors, so history matters: open July and the days must credit whoever
// he worked under THEN. `contractorHistory` = [{ from:'YYYY-MM', contractor }]; the app picks the
// entry with the latest `from` <= the month being viewed. A flat `contractor` is fine for anyone
// who never changed hands.
const { db } = require('./lib/firestore');

// never changed contractor → flat field
const FLAT = [
  ['00000302', 'kamtaprasad welder', 'Jitender'],
  ['00000093', 'hardev welder',      'Naveen'],
];
// changed contractor → effective-dated history (owner 01:49–02:07: under RAJU till July, NAVEEN from August)
const HISTORY = [
  ['00000067', 'virender welder (removed)',      [{ from: '', contractor: 'Raju' }, { from: '2026-08', contractor: 'Naveen' }]],
  ['00000075', 'rajesh kumar welder raju (rmvd)', [{ from: '', contractor: 'Raju' }, { from: '2026-08', contractor: 'Naveen' }]],
  ['00000077', 'rakesh singh welder',            [{ from: '', contractor: 'Raju' }, { from: '2026-08', contractor: 'Naveen' }]],
];
const DRY = process.env.DRY_RUN !== 'false';

(async () => {
  for (const [code, name, contractor] of FLAT) {
    if (DRY) { console.log(`[DRY] ${code} ${name.padEnd(32)} contractor="${contractor}"`); continue; }
    await db().collection('att_salary').doc(code).set({ contractor }, { merge: true });
    console.log(`${code} ${name.padEnd(32)} contractor="${contractor}"`);
  }
  for (const [code, name, history] of HISTORY) {
    const shown = history.map((h) => `${h.from || 'start'}→${h.contractor}`).join(', ');
    if (DRY) { console.log(`[DRY] ${code} ${name.padEnd(32)} history: ${shown}`); continue; }
    // clear any flat value so it can never override the history
    await db().collection('att_salary').doc(code).set({ contractorHistory: history, contractor: '' }, { merge: true });
    console.log(`${code} ${name.padEnd(32)} history: ${shown}`);
  }
  console.log(DRY ? 'DRY run — nothing written. Re-run with DRY_RUN=false to apply.' : 'APPLIED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
