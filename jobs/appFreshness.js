// APP FRESHNESS WATCHDOG (owner approved 2026-07-19, born from the transport-freight
// 16-day silent outage): every live app must show a recent write. If an app has recorded
// NOTHING for longer than its threshold, Telegram the owner — silence must never again
// look like success. Runs daily from alerts.yml. DRY=1 prints instead of alerting.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');

// app → where its heartbeat lives + how many quiet days are normal before alarm.
const WATCH = [
  { app: 'Transport Freight', path: ['apps', 'transportfreight', 'entries'], days: 2 },
  { app: 'Welder', path: ['apps', 'welder', 'dispatches'], days: 2 },
  { app: 'Plating', path: ['apps', 'platingjobwork', 'challans'], days: 2 },
  { app: 'Plastic/Molding', path: ['apps', 'plasticjobwork', 'production'], days: 7 },
];

(async () => {
  const now = Date.now();
  const stale = [];
  for (const w of WATCH) {
    const col = db().collection(w.path[0]).doc(w.path[1]).collection(w.path[2]);
    // newest by createdAt (migrated docs may lack it — the newest real entry has it)
    const s = await col.orderBy('createdAt', 'desc').limit(1).get().catch(() => null);
    const last = s && s.docs[0] ? s.docs[0].data().createdAt : null;
    const ageDays = last ? (now - Date.parse(last)) / 86400000 : Infinity;
    const line = `${w.app}: last entry ${last ? last.slice(0, 10) + ` (${ageDays.toFixed(1)}d ago)` : 'NONE with timestamp'}`;
    console.log(line, ageDays > w.days ? '⚠ STALE' : 'ok');
    if (ageDays > w.days) stale.push(`• <b>${w.app}</b> — nothing recorded for ${ageDays === Infinity ? '?' : Math.floor(ageDays)} days (limit ${w.days})`);
  }
  if (!stale.length) { console.log('all apps fresh — no alert'); return; }
  const msg = `🕳️ <b>App gone quiet?</b>\n${stale.join('\n')}\nWorkers may be unable to log in or save (like the July transport outage). Open the app and try one entry; tell Claude if it fails.`;
  if (process.env.DRY === '1') { console.log('[DRY] would send:\n' + msg); return; }
  await sendTelegram(msg);
  console.log('alert sent');
})();
