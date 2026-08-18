// Publishes each employee's month-to-date attendance (present/absent/OT/late/early) to
// att_attendance/{code}, which the PWA Salary tab reads for on-screen payslips. Runs daily.
const path = require('path');
const fs = require('fs');
const { session, downloadMonthly } = require('./lib/realtime');
const { parseSummary, range } = require('./salaryData');
const { db } = require('./lib/firestore');

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const OUT_DIR = path.resolve(__dirname, 'downloads');

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  try {
    const { first, to, label } = range(0);
    // downloadMonthly works on EITHER portal (old NewMonthly.aspx was deleted 2026-08 — V26 only now)
    const file = path.join(OUT_DIR, `salarydata_${label}.xls`);
    const dl = await downloadMonthly(page, fmt(first), fmt(to), 'summary');
    await dl.saveAs(file);

    const emps = parseSummary(file);
    const fdb = db();
    let batch = fdb.batch(), n = 0, written = 0;
    for (const e of emps) {
      // merge:true is LOAD-BEARING — without it this full-replaces the doc and WIPES the
      // months{} map (past-month attendance = the salary source), which broke June 2026-07-09.
      batch.set(fdb.collection('att_attendance').doc(e.code), {
        month: label, presentDays: e.presentDays, absentDays: e.absentDays,
        otHrs: e.otHrs, lateHrs: e.lateHrs, earlyHrs: e.earlyHrs, updatedAt: new Date().toISOString(),
      }, { merge: true });
      if (++n >= 400) { await batch.commit(); written += n; batch = fdb.batch(); n = 0; }
    }
    if (n) { await batch.commit(); written += n; }
    console.log(`published att_attendance for ${written} employees (${label})`);
  } finally { await browser.close(); }
})();
