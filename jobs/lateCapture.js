// Records each day's late-comers into a monthly log (att_late_log/{YYYY-MM}) so the app can
// flag the "4 late marks → 25% / very-late → 50%" penalty as approval tasks. Reads the
// already-published floor state (att_daily_stats/today.late); deduped by date. Called by
// worker.js each cycle (one entry per employee per day; last punch-in of the day wins).
const { db } = require('./lib/firestore');

async function captureLate() {
  const fdb = db();
  const snap = await fdb.collection('att_daily_stats').doc('today').get();
  if (!snap.exists) return 0;
  const data = snap.data();
  const date = data.dataDate || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const late = data.late || [];
  if (!late.length) return 0;

  const ref = fdb.collection('att_late_log').doc(month);
  const byCode = (await ref.get()).data()?.byCode || {};
  for (const l of late) {
    if (!l.code) continue;
    const e = byCode[l.code] || (byCode[l.code] = { name: l.name || '', dept: l.dept || '', days: {} });
    e.days[date] = l.inT || '';     // record/refresh this date's in-time
  }
  await ref.set({ month, byCode, updatedAt: new Date().toISOString() }, { merge: true });
  return late.length;
}

module.exports = { captureLate };

if (require.main === module) captureLate()
  .then(n => console.log('late captured', n))
  .catch(e => { console.error(e); process.exit(1); });
