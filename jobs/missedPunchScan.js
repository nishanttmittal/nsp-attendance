// Scans the current month's daily In-Out report (NewMonthly Button15) for MISSED PUNCHES —
// days where exactly one of First-In / Last-Out is "NA" (the worker punched once). Writes the
// list to att_missed_punch/{YYYY-MM} so the app's Punch tab can show it for one-tap manual fix.
// Overwrites each run, so once a punch is corrected it drops off. Run ~daily (worker gates it).
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { session, setField } = require('./lib/realtime');
const { db } = require('./lib/firestore');
const { range } = require('./salaryData');

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const isNA = s => !/\d/.test(String(s));
const toDDMMYYYY = s => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s)); return m ? `${m[1]}/${m[2]}/${m[3]}` : String(s).trim(); };

async function scanMissed() {
  const { first, to, label } = range(0); // current month, 1st .. yesterday
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/NewMonthly.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
    await setField(page, '#MainContent_txtdate', fmt(first));
    await setField(page, '#MainContent_txttodate', fmt(to));
    const file = path.join(__dirname, 'downloads', `inout_${label}.xls`);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.click('#MainContent_Button15')]);
    await dl.saveAs(file);

    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
    // names from att_salary
    const sal = {}; (await db().collection('att_salary').get()).forEach(d => { sal[d.id] = d.data().name || ''; });

    const entries = [];
    for (const r of rows) {
      const code = String(r[0] || '').trim(); if (!code) continue;
      const inNA = isNA(r[2]), outNA = isNA(r[3]);
      if (inNA === outNA) continue;                    // both present or both NA → not a missed punch
      entries.push({
        code, name: sal[code] || code, date: toDDMMYYYY(r[1]),
        which: inNA ? 'in' : 'out',                    // which punch is missing
        otherTime: String(inNA ? r[3] : r[2]).trim(),  // the punch that IS present
      });
    }
    await db().collection('att_missed_punch').doc(label).set({ month: label, entries, updatedAt: new Date().toISOString() });
    return entries.length;
  } finally { await browser.close(); }
}

module.exports = { scanMissed };

if (require.main === module) scanMissed()
  .then(n => console.log('missed punches scanned', n))
  .catch(e => { console.error(e); process.exit(1); });
