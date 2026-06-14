// Publishes per-month attendance into att_attendance/{code}.months[YYYY-MM] (and the
// top-level fields for the current month, like publishSalaryData) so the PWA Pay tab can
// compute salary for ANY month. Also flags employees absent the ENTIRE previous month
// with att_salary.resignPrompt (owner decides remove/resign/keep in the Attention tab).
//   MONTHS=0,1  (default) → current month + last month.
const path = require('path');
const fs = require('fs');
const { session, setField } = require('./lib/realtime');
const { parseSummary, range } = require('./salaryData');
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const OUT_DIR = path.resolve(__dirname, 'downloads');
const MONTHS = (process.env.MONTHS || '0,1').split(',').map(s => parseInt(s.trim(), 10));

async function downloadMonth(page, offset) {
  const { first, to, label, fullMonth, daysInMonth } = range(offset);
  await page.goto('https://onlinerealsoft.com/ERP_NewMonthly.aspx', { waitUntil: 'domcontentloaded' });   // V26 portal
  await page.waitForTimeout(1500);
  await setField(page, '#txtdate', fmt(first));        // V26: was #MainContent_txtdate
  await setField(page, '#txtdateto', fmt(to));         // V26: was #MainContent_txttodate
  const file = path.join(OUT_DIR, `salarydata_${label}.xls`);
  // V26: "Monthly Summary In Excel" is LinkButton21 (was #MainContent_Button10)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.click('#LinkButton21')]);
  await dl.saveAs(file);
  return { label, fullMonth, daysInMonth, emps: parseSummary(file) };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  const fdb = db();
  // FREEZE guard: never overwrite a month that's been frozen (e.g. May 2026 after the
  // 2026-06-14 mass-insert corruption was cleaned in-app). att_meta/freeze = { months:[...] }.
  let frozen = [];
  try { const fz = await fdb.collection('att_meta').doc('freeze').get(); frozen = (fz.exists && fz.data().months) || []; } catch {}
  try {
    for (const offset of MONTHS) {
      const { label, fullMonth, daysInMonth, emps } = await downloadMonth(page, offset);
      if (frozen.includes(label)) { console.log(`publishMonthly: SKIP frozen month ${label} (att_meta/freeze)`); continue; }
      let batch = fdb.batch(), n = 0, written = 0;
      for (const e of emps) {
        const rec = {
          presentDays: e.presentDays, absentDays: e.absentDays, otHrs: e.otHrs, otDays: e.otDays,
          lateHrs: e.lateHrs, lateDays: e.lateDays, earlyHrs: e.earlyHrs, workHrs: e.workHrs,
          weeklyOff: e.weeklyOff, weeklyOffPresent: e.weeklyOffPresent || 0, holiday: e.holiday, fullMonth, daysInMonth,
        };
        const payload = { months: { [label]: rec }, updatedAt: new Date().toISOString() };
        if (offset === 0) Object.assign(payload, { month: label, ...rec }); // top-level = current month (back-compat)
        batch.set(fdb.collection('att_attendance').doc(e.code), payload, { merge: true });
        if (++n >= 400) { await batch.commit(); written += n; batch = fdb.batch(); n = 0; }
      }
      if (n) { await batch.commit(); written += n; }
      console.log(`published months.${label} for ${written} employees${offset === 0 ? ' (+current)' : ''}`);

      // full-month absentees → resign prompt (only for COMPLETE months)
      if (fullMonth) {
        const zero = emps.filter(e => (e.presentDays || 0) === 0);
        const salSnap = await fdb.collection('att_salary').get();
        const sal = {}; salSnap.forEach(d => { sal[d.id] = d.data(); });
        const flagged = [];
        for (const e of zero) {
          if (e.code === '1') continue; // the owner himself
          const s = sal[e.code];
          if (!s || s.active === false || s.appOnly) continue;
          const cur = s.resignPrompt;
          if (cur && cur.month === label) continue;          // already prompted/decided for this month
          await fdb.collection('att_salary').doc(e.code).set({
            resignPrompt: { month: label, status: 'pending', flaggedAt: new Date().toISOString() },
          }, { merge: true });
          flagged.push(s.name || e.code);
        }
        if (flagged.length) {
          const aref = fdb.collection('att_alert_state').doc('resign_' + label);
          if (!(await aref.get()).exists) {
            await sendTelegram(`🚪 <b>Absent the whole of ${label}:</b>\n` + flagged.map(x => '• ' + x).join('\n') +
              '\nDecide remove/resign or keep in the app → Attention tab.').catch(() => {});
            await aref.set({ at: new Date().toISOString(), names: flagged });
          }
          console.log('resign prompts:', flagged.join(', '));
        }
      }
    }
  } finally { await browser.close(); }
})();
