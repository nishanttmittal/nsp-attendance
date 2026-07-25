// Print the per-app Firestore read-meter (usage_reads/{YYYY-MM-DD}.totals) for the
// last N days (default 5). Usage: node jobs/readUsage.js [days]
const { db } = require('./lib/firestore');
(async () => {
  const days = Number(process.argv[2]) || 5;
  const now = Date.now() + 5.5 * 3600 * 1000; // IST
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const snap = await db().doc(`usage_reads/${d}`).get();
    if (!snap.exists) { console.log(`${d} — no data`); continue; }
    const t = snap.data().totals || {};
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    console.log(`\n${d} — TOTAL ${sum.toLocaleString()} reads (of 50,000 free)`);
    Object.entries(t).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v.toLocaleString()}`));
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
