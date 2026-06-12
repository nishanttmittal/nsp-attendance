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
  { name: 'reprocess', min: 7 * 60, run: () => run('dailyReprocess.js') },                       // 07:00 reprocess yesterday
  { name: 'salary-data', min: 7 * 60 + 15, run: () => run('publishSalaryData.js') },              // 07:15 publish salary attendance
  { name: 'long-absence', min: 9 * 60, run: () => run('longAbsence.js', { THRESHOLD: '4' }) },     // 09:00 long absence
  { name: 'morning-miss', min: 10 * 60, run: () => run('missedPunch.js', { MODE: 'morning' }) },   // 10:00 yesterday's missed punch
  { name: 'morning-summary', min: 10 * 60 + 30, run: () => run('morningSummary.js') },             // 10:30 present/absent/late summary
  { name: 'food', min: 17 * 60 + 40, run: () => run('eveningHeadcount.js') },                      // 17:40 dinner headcount
  { name: 'welder-production', min: 20 * 60, run: () => run('welderProduction.js') },              // 20:00 welder output
  { name: 'plating-summary', min: 20 * 60 + 5, run: () => run('platingSummary.js') },              // 20:05 plating summary
  { name: 'evening-miss', min: 21 * 60 + 30, run: () => run('missedPunch.js', { MODE: 'evening' }) }, // 21:30 no-OUT today
  { name: 'welder-pay', min: 19 * 60, day: 6, run: () => run('welderContractorPay.js') },          // Sat 19:00 pay-ready
  { name: 'backup', min: 7 * 60 + 30, day: 0, run: () => run('backup.js') },                        // Sun 07:30 backup
  { name: 'sync-employees', min: 8 * 60, day: 0, run: () => run('syncEmployees.js') },              // Sun 08:00 employee sync
];

async function runDueTasks() {
  const dry = process.env.DRY === 'true';
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const wday = ist.getUTCDay();

  const ref = db().collection('att_alert_state').doc('scheduler');
  const last = (await ref.get()).data()?.lastRun || {};
  const ran = [];
  for (const t of TASKS) {
    if (t.day !== undefined && t.day !== wday) continue; // wrong weekday
    if (nowMin < t.min) continue;                        // not due yet today
    if (nowMin > t.min + 180) continue;                  // >3h late — skip, catch up tomorrow (no stale alerts)
    if (last[t.name] === today) continue;                // already ran today
    if (dry) { ran.push(t.name + '(due)'); continue; }
    try { t.run(); ran.push(t.name); }
    catch (e) { console.error(`scheduler ${t.name} failed: ${String(e.message || e).split('\n')[0]}`); }
    last[t.name] = today;                                // mark attempted (once/day, no retry storms)
  }
  if (!dry && ran.length) await ref.set({ lastRun: last, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ran;
}

module.exports = { runDueTasks };

if (require.main === module) runDueTasks()
  .then(r => console.log('scheduler ran:', r.join(', ') || 'none due'))
  .catch(e => { console.error(e); process.exit(1); });
