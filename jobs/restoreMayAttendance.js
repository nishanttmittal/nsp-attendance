// Restore att_attendance May 2026 from the CLEAN pre-corruption summary (downloads/may_final_rules.xls,
// 2026-06-13), undoing the 2026-06-14 mass-insert corruption. Backs up current data first, freezes
// May so it can't be re-pulled, then verifies. APPLY=false = preview only.
const path = require('path');
const fs = require('fs');
const { parseSummary } = require('./salaryData');
const { db } = require('./lib/firestore');

const CLEAN = path.resolve(__dirname, 'downloads/may_final_rules.xls');
const MK = '2026-05';
const DIM = 31;
const APPLY = process.env.APPLY !== 'false';   // default: do it (owner approved)

(async () => {
  const fdb = db();
  const clean = {}; parseSummary(CLEAN).forEach(e => { clean[e.code] = e; });

  // 1. backup current att_attendance May
  const snap = await fdb.collection('att_attendance').get();
  const backup = {};
  snap.forEach(d => { const m = (d.data().months || {})[MK]; if (m) backup[d.id] = m; });
  const bf = path.resolve(__dirname, `downloads/backup_att_${MK}_${Date.now()}.json`);
  fs.writeFileSync(bf, JSON.stringify(backup, null, 2));
  console.log(`backed up ${Object.keys(backup).length} employees' May data → ${path.basename(bf)}`);

  if (!APPLY) { console.log('PREVIEW only (APPLY=false). Clean source has ' + Object.keys(clean).length + ' employees.'); process.exit(0); }

  // 2. restore months[MK] from clean summary
  let batch = fdb.batch(), n = 0, written = 0;
  for (const [code, e] of Object.entries(clean)) {
    const rec = {
      presentDays: e.presentDays, absentDays: e.absentDays, otHrs: e.otHrs, otDays: e.otDays,
      lateHrs: e.lateHrs, lateDays: e.lateDays, earlyHrs: e.earlyHrs, workHrs: e.workHrs,
      weeklyOff: e.weeklyOff, weeklyOffPresent: e.weeklyOffPresent, holiday: e.holiday,
      fullMonth: true, daysInMonth: DIM, unpaidWorkedSat: 0, restoredFromClean: true,
    };
    batch.set(fdb.collection('att_attendance').doc(code), { months: { [MK]: rec } }, { merge: true });
    if (++n >= 400) { await batch.commit(); written += n; batch = fdb.batch(); n = 0; }
  }
  if (n) { await batch.commit(); written += n; }
  console.log(`restored months.${MK} for ${written} employees from clean baseline`);

  // 3. freeze May
  await fdb.collection('att_meta').doc('freeze').set({ months: [MK], reason: 'mass-insert corruption 2026-06-14; restored in-app', at: new Date().toISOString() }, { merge: true });
  console.log('froze ' + MK + ' (att_meta/freeze) — publishMonthly will not overwrite it');

  // 4. verify
  const after = await fdb.collection('att_attendance').get();
  let ok = 0, bad = 0;
  after.forEach(d => { const c = clean[d.id]; const m = (d.data().months || {})[MK]; if (!c || !m) return;
    if (Math.abs((m.presentDays || 0) - (c.presentDays || 0)) < 0.01) ok++; else bad++; });
  console.log(`verify: ${ok} match clean, ${bad} mismatch`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
