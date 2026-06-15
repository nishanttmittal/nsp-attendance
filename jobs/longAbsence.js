// Long absence alert with de-dup: each employee is notified ONCE when they reach 4 absent
// days and ONCE more at 8 (this month). State in att_alert_state/long_absence; resets each month.
const path = require('path');
const fs = require('fs');
const { session, setField, downloadMonthly } = require('./lib/realtime');
const { parseSummary, range } = require('./salaryData');
const { sendTelegram } = require('./lib/notify');
const { db } = require('./lib/firestore');

const MONTH = parseInt(process.env.MONTH || '0', 10);
const OUT_DIR = path.resolve(__dirname, 'downloads');
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const { browser, page } = await session();
    try {
      const { first, to, label } = range(MONTH);
      const file = path.join(OUT_DIR, `longabsence_${label}.xls`);
      const dl = await downloadMonthly(page, fmt(first), fmt(to), 'summary');   // works on either portal
      await dl.saveAs(file);
      const emps = parseSummary(file);

      const ref = db().collection('att_alert_state').doc('long_absence');
      const snap = await ref.get();
      let state = snap.exists ? snap.data() : {};
      if (state.month !== label) state = { month: label, notified: {} };  // new month -> reset
      const notified = state.notified || {};

      const newly = [];
      for (const e of emps) {
        const crossed = e.absentDays >= 8 ? 8 : (e.absentDays >= 4 ? 4 : 0);
        if (crossed && crossed > (notified[e.code] || 0)) { notified[e.code] = crossed; newly.push({ ...e, threshold: crossed }); }
      }
      if (newly.length) {
        const msg = `🚩 <b>Long absence (${label})</b>\n` +
          newly.sort((a, b) => b.threshold - a.threshold).map(e => `  • ${e.name} (${e.code}): ${e.absentDays} days — reached ${e.threshold}`).join('\n');
        await sendTelegram(msg);
      }
      await ref.set({ month: label, notified, updatedAt: new Date().toISOString() });
      console.error(`long-absence: ${newly.length} newly notified (already-notified are skipped)`);
    } finally { await browser.close(); }
  })();
}
