// One processing pass (owner wants this 3× daily: 10:00, 17:40, 21:00 IST):
// 1. reprocess yesterday + today on Realtime (so late punches/rule edits land),
// 2. publish current + last month attendance to the app (publishMonthly),
// 3. refresh the missed-punch / short-hours scan.
const { execFileSync } = require('child_process');
const path = require('path');

const run = (file, env) => execFileSync('node', [path.resolve(__dirname, file)], {
  env: { ...process.env, ...env }, encoding: 'utf8', timeout: 280000, stdio: ['ignore', 'inherit', 'inherit'],
});

const pad = n => String(n).padStart(2, '0');
const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
const today = `${pad(ist.getUTCDate())}/${pad(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()}`;
const y = new Date(ist.getTime() - 86400000);
const yesterday = `${pad(y.getUTCDate())}/${pad(y.getUTCMonth() + 1)}/${y.getUTCFullYear()}`;

run('reprocessRange.js', { FROM: yesterday, TO: today });
run('publishMonthly.js', { MONTHS: '0,1' });
try { run('publishPunches.js', { MONTHS: '0,1' }); } catch (e) { console.error('publishPunches failed:', e.message); } // raw punches for the app-side engine (Shadow)
try { run('missedPunchScan.js'); } catch (e) { console.error('missed scan failed:', e.message); }
console.log('processData complete');
