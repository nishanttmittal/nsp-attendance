// Compares the April Excel's PRESENT days + OT against the machine's actual April monthly
// summary (downloads/salarydata_2026-04.xls). Matches Excel names → machine codes via the
// same fuzzy matcher + the owner-confirmed overrides.
const path = require('path');
const XLSX = require('xlsx');
const { parseSummary } = require('./salaryData');
const { runMatch } = require('./importSalaryMatch');

const OVERRIDE = { // excel name (lowercased) -> machine code
  'rakhtiv ansari ahjaj': '00000293', 'nand kishor': '00000099', 'lovekush press': '00000128',
  'kindal': '00000105', 'avnish july': '00000110', 'sonu july': '00000018',
};

(async () => {
  const file = '/mnt/c/Users/lenovo/Desktop/salary april 2026.xlsx';
  const { confident, people } = await runMatch(file);
  const map = {}; // excel name -> code
  confident.forEach(p => { map[p.name.toLowerCase()] = p.best.code; });
  Object.assign(map, OVERRIDE);

  // machine April: code -> {name, presentDays, absentDays, otHrs}
  const machine = Object.fromEntries(parseSummary(path.resolve(__dirname, 'downloads', 'salarydata_2026-04.xls')).map(e => [e.code, e]));

  // excel: name -> {days, ot}
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const excel = {};
  for (const r of rows.slice(1)) { const n = String(r[0] || '').trim(); if (n) excel[n.toLowerCase()] = { name: n, days: Number(r[1]), ot: Number(r[2]) || 0 }; }

  let okDays = 0, okOt = 0, n = 0; const diffs = [];
  for (const p of people) {
    const code = map[p.name.toLowerCase()]; if (!code) continue;
    const m = machine[code]; if (!m) continue;
    n++;
    const exDays = excel[p.name.toLowerCase()].days, exOt = excel[p.name.toLowerCase()].ot;
    const mDays = m.presentDays, mOt = Math.round(m.otHrs);
    const dDays = +(exDays - mDays).toFixed(1), dOt = exOt - mOt;
    if (Math.abs(dDays) <= 1.5) okDays++; if (Math.abs(dOt) <= 2) okOt++;
    diffs.push({ name: p.name, code, exDays, mDays, dDays, exOt, mOt, dOt });
  }

  console.log(`Matched ${n} staff to the machine's April record.\n`);
  console.log(`PRESENT days within ±1.5: ${okDays}/${n}   |   OT within ±2h: ${okOt}/${n}\n`);
  console.log('name'.padEnd(22) + 'excelDays  machDays  Δ    excelOT  machOT  Δ');
  diffs.sort((a, b) => (Math.abs(b.dDays) + Math.abs(b.dOt) / 10) - (Math.abs(a.dDays) + Math.abs(a.dOt) / 10));
  for (const d of diffs)
    console.log(`${d.name.slice(0, 21).padEnd(22)}${String(d.exDays).padStart(6)}${String(d.mDays).padStart(10)}${String(d.dDays).padStart(6)}${String(d.exOt).padStart(9)}${String(d.mOt).padStart(8)}${String(d.dOt).padStart(5)}`);
})().catch(e => { console.error(e); process.exit(1); });
