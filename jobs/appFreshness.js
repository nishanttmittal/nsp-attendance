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
  // FAIL LOUD, NOT OPEN (2026-07-31, Codex round 3): this used to swallow a read failure and return
  // no warnings, so the run printed "payroll config ok" — a permission outage or Firestore error
  // reported as a clean configuration. A monitor that cannot read must say so, not stay silent.
  let snap, attSnap;
  try {
    [snap, attSnap] = await Promise.all([
      db().collection('att_salary').get(),
      db().collection('att_attendance').get(),
    ]);
  } catch (err) { return [`• ⚠️ Could NOT read payroll data (${err.message}) — payroll configuration was <b>not checked</b> this run. This is "unknown", not "ok".`]; }

  const attOf = {};
  attSnap.forEach(d => { attOf[d.id] = d.data() || {}; });

  snap.forEach(d => {
    const e = d.data() || {};
    if (e.active === false) return;
    if ((e.shift || '') === 'LOD' && (e.type || 'monthly') !== 'daily') {
      out.push(`• <b>${e.name || d.id}</b> is MONTHLY on the LOD shift — LOD Saturdays are not supposed to be paid, but a monthly worker WILL be paid them (~Rs 2,580/mo on Rs 20,000). Move them to daily wage, or tell Claude to fix the engine.`);
    }

    // WORKING BUT NO PAY RATE (owner approved 2026-08-02). Ravi ahmed (00000051) clocked in for five
    // days and was handed a Rs 3,500 cash advance while his record carried no `type` and no `wage`.
    // The engine paid him base Rs 0.00 and showed him owing the whole advance — and NOTHING said so,
    // because an unset wage is indistinguishable from a worker who genuinely earned nothing.
    // He was found by chance. This is the check that would have caught him on day one.
    const a = attOf[d.id] || {};
    // "Working" must mean WORKING, not a trace. The owner's own record (code 1, DEMO) carries
    // workHrs 0.3 — an 18-minute stray punch from walking past the machine — and any-hours > 0
    // flagged him every day. A watchdog that cries wolf daily is one the owner learns to ignore,
    // which is how the thing it was built for gets missed. One present day, one logged day, or
    // half a day of hours.
    const logged = Object.values(e.attendanceLog || {}).reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0);
    const working = Number(a.presentDays || 0) >= 1 || logged >= 1 || Number(a.workHrs || 0) >= 4;
    const rate = (e.type || '') === 'daily' ? Number(e.wage || 0) : Number(e.amount || 0);
    if (working && !(rate > 0)) {
      const adv = (e.advances || []).reduce((s, x) => s + Number(x.amount || 0), 0);
      out.push(`• 💸 <b>${e.name || d.id}</b> is WORKING (${a.presentDays || 0} present, ${Math.round(Number(a.workHrs || 0))}h) but has <b>NO pay rate set</b> (type=${e.type || 'unset'}, wage=${e.wage ?? '—'}, salary=${e.amount ?? '—'}). He will be paid <b>Rs 0</b>.${adv ? ` He has already taken Rs ${adv.toLocaleString('en-IN')} in advances.` : ''} Set it on the Salary screen, or: <code>CODE=${d.id} TYPE=daily WAGE=&lt;rs&gt; DRY=false node jobs/setWorkerPay.js</code>`);
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
