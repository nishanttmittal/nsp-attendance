// Telegram alert when someone crosses 4 late marks in the month. Reads att_late_log/{month}
// (built by lateCapture.js), alerts once per person per month (dedup in att_alert_state/
// late_alerts), and points the owner to the Late tab to approve/reject the 25%/50% penalty.
// Called by worker.js each cycle.
const { db, FieldValue } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');

const THRESHOLD = 4;

async function alertLate() {
  const fdb = db();
  const mk = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10).slice(0, 7);
  const logSnap = await fdb.collection('att_late_log').doc(mk).get();
  if (!logSnap.exists) return 0;
  const byCode = logSnap.data().byCode || {};

  const stateRef = fdb.collection('att_alert_state').doc('late_alerts');
  const st = stateRef ? (await stateRef.get()).data() : null;
  const alerted = new Set((st && st.month === mk && st.codes) || []);

  let sent = 0;
  for (const [code, e] of Object.entries(byCode)) {
    const dates = Object.keys(e.days || {});
    if (dates.length < THRESHOLD || alerted.has(code)) continue;
    const list = dates.sort().map(d => `${d.slice(8)}·${e.days[d] || '—'}`).join(', ');
    await sendTelegram(`⏰ <b>${e.name || code}</b> has crossed <b>${dates.length} late marks</b> this month.\n${list}\n\n<i>Review in the app → Late tab to apply 25% / 50% or reject.</i>`);
    alerted.add(code); sent++;
  }
  if (sent) await stateRef.set({ month: mk, codes: [...alerted], updatedAt: FieldValue.serverTimestamp() });
  return sent;
}

module.exports = { alertLate };

if (require.main === module) alertLate()
  .then(n => console.log('late alerts sent', n))
  .catch(e => { console.error(e); process.exit(1); });
