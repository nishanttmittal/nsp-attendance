// Pulls Realtime's "Monthly Summary In Excel" (all employees) for a month and parses
// per-employee attendance/OT figures used by salary calc. Default range = 1st .. previous day.
//   MONTH=0|1|2 (0=current month, default).  Outputs JSON array on stdout.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { session, setField } = require('./lib/realtime');

const URL = 'https://onlinerealsoft.com/NewMonthly.aspx';
const OUT_DIR = path.resolve(__dirname, 'downloads');
const MONTH = parseInt(process.env.MONTH || '0', 10);

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const hhmmToHours = s => { if (!s || !/:/.test(String(s))) return 0; const [h, m] = String(s).split(':').map(Number); return h + (m || 0) / 60; };

// 1st of target month .. (current month -> yesterday; past month -> last day)
function range(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const to = offset === 0 ? yesterday : lastOfMonth;
  const daysInMonth = lastOfMonth.getDate();
  const elapsedDays = to.getDate();            // 1st..to inclusive (first is always the 1st)
  const fullMonth = offset > 0;                // past months are complete
  return { first, to, daysInMonth, elapsedDays, fullMonth, label: `${first.getFullYear()}-${pad(first.getMonth() + 1)}` };
}

function parseSummary(file) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
  const hi = rows.findIndex(r => String(r[0]).trim() === 'Emp Code');
  if (hi < 0) throw new Error('header row not found');
  const H = rows[hi].map(c => String(c).trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = H.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };
  const c = {
    code: col('emp code'), name: col('employee name'), present: col('present days'),
    absent: col('absent days'), work: col('total work'), ot: col('ot hours'), otDays: col('ot days'),
    lateHrs: col('late coming hrs'), lateDays: col('late coming days'),
    earlyHrs: col('earlier going hrs', 'early going hrs'), earlyDays: col('early going days', 'earlier going days'),
    weeklyOff: col('weekly off'), holiday: col('holiday'),
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const code = String(r[c.code] ?? '').trim();
    if (!code) continue;
    out.push({
      code, name: String(r[c.name] ?? '').trim(),
      presentDays: Number(r[c.present]) || 0,
      absentDays: Number(r[c.absent]) || 0,
      workHrs: hhmmToHours(r[c.work]),
      otHrs: hhmmToHours(r[c.ot]),
      otDays: Number(r[c.otDays]) || 0,
      lateHrs: hhmmToHours(r[c.lateHrs]),
      lateDays: Number(r[c.lateDays]) || 0,
      earlyHrs: hhmmToHours(r[c.earlyHrs]),
      earlyDays: Number(r[c.earlyDays]) || 0,
    });
  }
  return out;
}

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const { browser, page } = await session();
    try {
      await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
      if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
      const { first, to, daysInMonth, label } = range(MONTH);
      await setField(page, '#MainContent_txtdate', fmt(first));
      await setField(page, '#MainContent_txttodate', fmt(to));
      const file = path.join(OUT_DIR, `salarydata_${label}.xls`);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 35000 }), page.click('#MainContent_Button10')]);
      await dl.saveAs(file);
      const emps = parseSummary(file);
      console.log(JSON.stringify({ month: label, from: fmt(first), to: fmt(to), daysInMonth, count: emps.length, employees: emps }, null, 2));
    } finally { await browser.close(); }
  })();
}

module.exports = { parseSummary, range, hhmmToHours };
