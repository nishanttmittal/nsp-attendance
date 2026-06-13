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

async function scanMissed(offset = 0) {
  const { first, to, label } = range(offset); // offset 0 = current month (1st..yesterday); >0 = whole past month
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
    // names + shifts from att_salary
    const sal = {}; (await db().collection('att_salary').get()).forEach(d => { sal[d.id] = d.data(); });
    const nameOf = c => (sal[c] && sal[c].name) || c;

    // short-hours: worked span (minus 30-min lunch) clearly below the shift's net hours
    const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10 };
    const toMin = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s).trim()); return m ? +m[1] * 60 + +m[2] : null; };

    const entries = [], shortHours = [];
    for (const r of rows) {
      const code = String(r[0] || '').trim(); if (!code) continue;
      const inNA = isNA(r[2]), outNA = isNA(r[3]);
      if (inNA !== outNA) {                            // exactly one punch → missed punch
        // the report dumps a lone punch into the First-In column regardless, so decide which
        // punch is MISSING by the present punch's TIME: an evening punch (>= 14:00) means the
        // morning IN was missed; a morning punch means the OUT was missed.
        const lone = String(inNA ? r[3] : r[2]).trim();
        const lm = toMin(lone);
        const missingIn = lm != null && lm >= 14 * 60;
        entries.push({
          code, name: nameOf(code), date: toDDMMYYYY(r[1]),
          which: missingIn ? 'in' : 'out',               // which punch is missing
          otherTime: lone,                               // the punch that IS present
        });
        continue;
      }
      if (inNA) continue;                              // both NA → absent, nothing to report
      const i = toMin(r[2]), o = toMin(r[3]);
      if (i == null || o == null) continue;
      let mins = o - i; if (mins < 0) mins += 1440;    // overnight (guards)
      const hours = +(mins / 60 - 0.5).toFixed(1);     // minus lunch
      const need = SHIFT_HOURS[(sal[code] || {}).shift] || 8;
      if (hours < need - 0.25) {
        shortHours.push({ code, name: nameOf(code), date: toDDMMYYYY(r[1]), in: String(r[2]).trim(), out: String(r[3]).trim(), hours, need });
      }
    }
    shortHours.sort((a, b) => (a.date < b.date ? 1 : -1));
    await db().collection('att_missed_punch').doc(label).set({ month: label, entries, shortHours, updatedAt: new Date().toISOString() });
    return entries.length;
  } finally { await browser.close(); }
}

module.exports = { scanMissed };

if (require.main === module) scanMissed(parseInt(process.env.OFFSET || '0', 10))
  .then(n => console.log('missed punches scanned', n))
  .catch(e => { console.error(e); process.exit(1); });
