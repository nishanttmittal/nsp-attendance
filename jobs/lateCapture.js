// Records each day's late-comers into a monthly log (att_late_log/{YYYY-MM}) so the app can
// flag the "4 late marks → 25% / very-late → 50%" penalty as approval tasks. Reads the
// already-published floor state (att_daily_stats/today.late); deduped by date. Called by
// worker.js each cycle (one entry per employee per day; last punch-in of the day wins).
const { db } = require('./lib/firestore');

// Per-shift morning start (minutes) + the 15-min grace. The portal's daily late list is
// SHIFT-BLIND (measures everyone against the generic start) — it listed amarjeet (wir, 9:30
// start) as "late" for 9:20 arrivals, giving him 10 phantom marks in July 2026 vs 2 real.
// Filter here so the Late tab only counts genuinely-late-for-THEIR-shift arrivals.
const SHIFT_START_MIN = { GEN: 540, '10H': 540, '12H': 540, wir: 570, DSG: 540, LOD: 540 };
const GRACE_MIN = 15;
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };

async function captureLate() {
  const fdb = db();
  const snap = await fdb.collection('att_daily_stats').doc('today').get();
  if (!snap.exists) return 0;
  const data = snap.data();
  const date = data.dataDate || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const late = data.late || [];
  if (!late.length) return 0;

  // shift lookup for the per-shift filter (roster is small; one read)
  const shifts = {};
  (await fdb.collection('att_salary').get()).forEach((d) => { shifts[d.id] = (d.data().shift || 'GEN'); });

  const ref = fdb.collection('att_late_log').doc(month);
  const byCode = (await ref.get()).data()?.byCode || {};
  let recorded = 0;
  for (const l of late) {
    if (!l.code) continue;
    const inMin = toMin(l.inT);
    const start = SHIFT_START_MIN[shifts[l.code]] ?? 540;
    if (inMin != null && inMin <= start + GRACE_MIN) continue;   // on time for THEIR shift
    const e = byCode[l.code] || (byCode[l.code] = { name: l.name || '', dept: l.dept || '', days: {} });
    e.days[date] = l.inT || '';     // record/refresh this date's in-time
    recorded++;
  }
  if (recorded) await ref.set({ month, byCode, updatedAt: new Date().toISOString() }, { merge: true });
  return recorded;
}

module.exports = { captureLate };

if (require.main === module) captureLate()
  .then(n => console.log('late captured', n))
  .catch(e => { console.error(e); process.exit(1); });
