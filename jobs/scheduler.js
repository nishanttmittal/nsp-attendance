// Time-aware dispatcher — runs the daily/weekly jobs at their IST times WITHOUT GitHub cron
// (which proved unreliable). Driven by the heartbeat via worker.js every ~5 min: each task
// fires once it's past its time and hasn't run today (dedup in att_alert_state/scheduler).
// This replaces the alerts.yml cron in practice; that workflow stays as a manual fallback.
const { execFileSync } = require('child_process');
const path = require('path');
const { db, FieldValue } = require('./lib/firestore');

function run(file, env) {
  execFileSync('node', [path.resolve(__dirname, file)], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 280000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// min = IST minutes from midnight; day = weekday 0-6 (undefined = every day)
const TASKS = [
  { name: 'settings-guard', min: 6 * 60 + 45, run: () => run('settingsGuard.js') },               // 06:45 alert if Realtime shift/policy settings drifted (before processing!)
  // owner-set processing times: reprocess yesterday+today, publish current+last month, rescan punches
  { name: 'process-am', min: 10 * 60, run: () => run('processData.js') },                          // 10:00
  { name: 'process-pm', min: 17 * 60 + 40, run: () => run('processData.js') },                     // 17:40
  { name: 'process-night', min: 21 * 60, run: () => run('processData.js') },                       // 21:00
  { name: 'long-absence', min: 9 * 60, run: () => run('longAbsence.js', { THRESHOLD: '4' }) },     // 09:00 long absence
  { name: 'morning-miss', min: 10 * 60, run: () => run('missedPunch.js', { MODE: 'morning' }) },   // 10:00 yesterday's missed punch
  { name: 'morning-summary', min: 10 * 60 + 30, run: () => run('morningSummary.js') },             // 10:30 present/absent/late summary
  { name: 'food', min: 17 * 60 + 40, run: () => run('eveningHeadcount.js') },                      // 17:40 dinner headcount
  { name: 'welder-production', min: 20 * 60, run: () => run('welderProduction.js') },              // 20:00 welder output
  { name: 'plating-summary', min: 20 * 60 + 5, run: () => run('platingSummary.js') },              // 20:05 plating summary
  { name: 'evening-miss', min: 21 * 60 + 30, run: () => run('missedPunch.js', { MODE: 'evening' }) }, // 21:30 no-OUT today
  { name: 'welder-pay', min: 19 * 60, day: 6, run: () => run('welderContractorPay.js') },          // Sat 19:00 pay-ready
  { name: 'backup', min: 7 * 60 + 30, run: () => run('backup.js', { REASON: 'daily' }) },             // 07:30 daily backup
  { name: 'live-prices', min: 8 * 60 + 15, run: () => run('fetchDelhiPrices.js') },                     // 08:15 FX+bullion+LME+Delhi scrap → costing Live Rates (+ dated history)
  { name: 'price-health', min: 8 * 60 + 45, run: () => run('checkPriceHealth.js') },                    // 08:45 alert Telegram if a source broke or a price jumped (silent if OK)
  { name: 'sync-employees', min: 8 * 60, day: 0, run: () => run('syncEmployees.js') },              // Sun 08:00 employee sync
];

async function runDueTasks() {
  const dry = process.env.DRY === 'true';
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const wday = ist.getUTCDay();

  // State is per-IST-day: { day, done{name}, fails{name} }. A task counts as DONE only when it
  // SUCCEEDS — if the machine is down it keeps retrying on later cycles the SAME day (owner rule
  // 2026-06-14), until it succeeds or hits the retry cap. No 3h cutoff: better late, same day.
  const MAX_RETRY = 36;                                  // give up after ~36 failed tries that day (storm guard)
  const ref = db().collection('att_alert_state').doc('scheduler');
  const cur = (await ref.get()).data() || {};
  let st;
  if (cur.day === today) st = cur;
  else {
    // new day, or migrating from the old {lastRun:{name:date}} shape — seed today's already-done
    // tasks from lastRun so a deploy/midday reset doesn't re-fire alerts already sent today.
    const seed = {};
    if (cur.lastRun) for (const [k, v] of Object.entries(cur.lastRun)) if (v === today) seed[k] = true;
    st = { day: today, done: seed, fails: {} };
  }
  const done = st.done || {}, fails = st.fails || {};
  const ran = [];
  for (const t of TASKS) {
    if (t.day !== undefined && t.day !== wday) continue; // wrong weekday
    if (nowMin < t.min) continue;                        // not due yet today
    if (done[t.name]) continue;                          // already SUCCEEDED today
    if ((fails[t.name] || 0) >= MAX_RETRY) continue;     // gave up after too many failures today
    if (dry) { ran.push(t.name + '(due)'); continue; }
    try { t.run(); done[t.name] = true; ran.push(t.name); }                  // success → done for the day
    catch (e) {
      fails[t.name] = (fails[t.name] || 0) + 1;                              // failure → retry next cycle, same day
      console.error(`scheduler ${t.name} failed (try ${fails[t.name]}): ${String(e.message || e).split('\n')[0]}`);
      ran.push(`${t.name}(retry ${fails[t.name]})`);
    }
  }
  if (!dry) await ref.set({ day: today, done, fails, updatedAt: FieldValue.serverTimestamp() });
  return ran;
}

module.exports = { runDueTasks };

if (require.main === module) runDueTasks()
  .then(r => console.log('scheduler ran:', r.join(', ') || 'none due'))
  .catch(e => { console.error(e); process.exit(1); });
