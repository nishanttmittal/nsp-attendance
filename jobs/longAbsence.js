// Employees with more than N absent days in the month (default >4). Sends Telegram + prints.
//   MONTH=0|1|2   THRESHOLD=4
const path = require('path');
const fs = require('fs');
const { session, setField } = require('./lib/realtime');
const { parseSummary, range } = require('./salaryData');
const { sendTelegram } = require('./lib/notify');

const MONTH = parseInt(process.env.MONTH || '0', 10);
const THRESHOLD = parseFloat(process.env.THRESHOLD || '4');
const OUT_DIR = path.resolve(__dirname, 'downloads');
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const { browser, page } = await session();
    try {
      const { first, to, label } = range(MONTH);
      await page.goto('https://onlinerealsoft.com/NewMonthly.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
      if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
      await setField(page, '#MainContent_txtdate', fmt(first));
      await setField(page, '#MainContent_txttodate', fmt(to));
      const file = path.join(OUT_DIR, `longabsence_${label}.xls`);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 35000 }), page.click('#MainContent_Button10')]);
      await dl.saveAs(file);

      const flagged = parseSummary(file)
        .filter(e => e.absentDays > THRESHOLD)
        .sort((a, b) => b.absentDays - a.absentDays);

      const msg = [`🚩 <b>Long absence — &gt;${THRESHOLD} absent days (${label})</b>`,
        ...(flagged.length ? flagged.map(e => `  • ${e.name} (${e.code}): ${e.absentDays} days`) : ['  • none'])].join('\n');
      await sendTelegram(msg);
      console.error(`flagged ${flagged.length}`);
      console.log(JSON.stringify({ month: label, threshold: THRESHOLD, flagged }, null, 2));
    } finally { await browser.close(); }
  })();
}
