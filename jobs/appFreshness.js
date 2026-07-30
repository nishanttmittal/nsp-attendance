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

// PAYROLL CONFIG SANITY (owner approved 2026-07-30). Same principle as the freshness watch: a
// mis-configuration must not sit silent until it reaches a payslip.
//
// LOD (loading, 09:00-20:30) gets NO paid Saturday — owner 2026-07-30, and the portal agrees (it is
// the only shift with Weekly Off = None). That rule holds today ONLY because every LOD worker is a
// daily wager paid `wage × hours ÷ 11`, a formula that never reads weekly-offs. The portal
// nevertheless RECORDS 3-4 weekly-offs for them (mechanism unknown, deliberately not guessed at).
// Put a MONTHLY worker on LOD and those Saturdays WOULD be paid — `perDay × (days − absent)`, and a
// weekly-off is not an absence: ~Rs 2,580/month on a Rs 20,000 salary, against the owner's rule.
// Nobody is monthly on LOD today. This shouts if that ever changes.
async function payrollConfigWarnings() {
  const out = [];
  const snap = await db().collection('att_salary').get().catch(() => null);
  if (!snap) return out;
  snap.forEach(d => {
    const e = d.data() || {};
    if (e.active === false) return;
    if ((e.shift || '') === 'LOD' && (e.type || 'monthly') !== 'daily') {
      out.push(`• <b>${e.name || d.id}</b> is MONTHLY on the LOD shift — LOD Saturdays are not supposed to be paid, but a monthly worker WILL be paid them (~Rs 2,580/mo on Rs 20,000). Move them to daily wage, or tell Claude to fix the engine.`);
    }
  });
  return out;
}

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
  const cfg = await payrollConfigWarnings();
  cfg.forEach(c => console.log('PAYROLL CONFIG ⚠', c.replace(/<[^>]+>/g, '')));
  if (!cfg.length) console.log('payroll config ok — no monthly worker on LOD');

  if (!stale.length && !cfg.length) { console.log('all apps fresh, config ok — no alert'); return; }
  const parts = [];
  if (stale.length) parts.push(`🕳️ <b>App gone quiet?</b>\n${stale.join('\n')}\nWorkers may be unable to log in or save (like the July transport outage). Open the app and try one entry; tell Claude if it fails.`);
  if (cfg.length) parts.push(`⚙️ <b>Payroll setup needs a look</b>\n${cfg.join('\n')}`);
  const msg = parts.join('\n\n');
  if (process.env.DRY === '1') { console.log('[DRY] would send:\n' + msg); return; }
  await sendTelegram(msg);
  console.log('alert sent');
})();
