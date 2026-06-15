// Flag the bogus IN/OUT punches created by the mass-insert bug (2026-06-14): download the
// CURRENT May in-out from the machine and diff it against the CLEAN pre-corruption baseline
// (downloads/inout_2026-05.xls, scraped 2026-06-13). Any day an employee is now "present"
// but was absent in the clean baseline = a bogus punch → flag it. Writes a report to Desktop.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { session, setField } = require('./lib/realtime');

const CLEAN = path.resolve(__dirname, 'downloads/inout_2026-05.xls');   // June-13 clean baseline
const NOWFILE = path.resolve(__dirname, 'downloads/inout_2026-05_now.xls');
const OUT_XLSX = '/mnt/c/Users/lenovo/Desktop/may bogus punches.xlsx';
const isNA = s => !/\d/.test(String(s));
const toYMD = s => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s)) || /(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if (!m) return ''; return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };

function parseInout(file) {
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
  const map = {}; // code|ymd -> {in,out,present,name}
  for (const r of rows) {
    const code = String(r[0] || '').trim(); const ymd = toYMD(r[1]); if (!code || !ymd) continue;
    const inT = String(r[2] || '').trim(), outT = String(r[3] || '').trim();
    map[code + '|' + ymd] = { code, ymd, in: inT, out: outT, present: !(isNA(inT) && isNA(outT)) };
  }
  return map;
}

(async () => {
  // 1. download current May in-out (corrupted)
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/ERP_NewMonthly.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    await setField(page, '#txtdate', '01/05/2026');
    await setField(page, '#txtdateto', '31/05/2026');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#LinkButton22')]);
    await dl.saveAs(NOWFILE);
  } finally { await browser.close(); }

  // 2. diff
  const clean = parseInout(CLEAN);
  const now = parseInout(NOWFILE);
  const sal = {}; // names
  try { (await require('./lib/firestore').db().collection('att_salary').get()).forEach(d => { sal[d.id] = d.data().name || d.id; }); } catch {}

  const bogus = [];   // present NOW but absent in clean baseline = bogus added punch
  for (const key of Object.keys(now)) {
    const n = now[key]; if (!n.present) continue;
    const c = clean[key];
    if (!c || !c.present) bogus.push({ code: n.code, name: sal[n.code] || '', date: n.ymd, in: n.in, out: n.out });
  }
  bogus.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  // per-employee + per-date summaries
  const byEmp = {}, byDate = {};
  bogus.forEach(b => { byEmp[b.code] = (byEmp[b.code] || 0) + 1; byDate[b.date] = (byDate[b.date] || 0) + 1; });

  console.log(`BOGUS punches flagged: ${bogus.length}  (present now, absent in clean baseline)`);
  console.log(`Affected employees: ${Object.keys(byEmp).length} | affected dates: ${Object.keys(byDate).length}`);
  console.log('Per date:', JSON.stringify(byDate));

  // 3. write report to Desktop
  const aoa = [['Emp Code', 'Name', 'Date', 'Bogus IN', 'Bogus OUT']];
  bogus.forEach(b => aoa.push([b.code, b.name, b.date, b.in, b.out]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Bogus Punches');
  try { XLSX.writeFile(wb, OUT_XLSX); console.log('Report saved → ' + OUT_XLSX); }
  catch (e) { const alt = path.resolve(__dirname, 'downloads/may_bogus_punches.xlsx'); XLSX.writeFile(wb, alt); console.log('Report saved → ' + alt); }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
