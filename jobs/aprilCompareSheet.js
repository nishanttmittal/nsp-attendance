// Builds the owner's side-by-side April sheet: Excel-paid vs app-engine per person,
// with difference + plain-language reason. Output: Desktop "april salary comparison.xlsx".
const path = require('path');
const XLSX = require('xlsx');
const { parseSummary } = require('./salaryData');
const { runMatch } = require('./importSalaryMatch');
const { computePay } = require('./salaryCalc');

const OVERRIDE = { 'rakhtiv ansari ahjaj': '00000293', 'nand kishor': '00000099', 'lovekush press': '00000128', 'kindal': '00000105', 'avnish july': '00000110', 'sonu july': '00000018' };
const NIGHT = new Set(['00000061', '00000255', '00000003']);
const APRIL = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: new Date('2026-04-01'), toDate: new Date('2026-04-30') };
const r0 = n => Math.round(n);
const DESKTOP = '/mnt/c/Users/lenovo/Desktop';

(async () => {
  const file = path.join(DESKTOP, 'salary april 2026.xlsx');
  const { confident } = await runMatch(file);
  const map = {}; confident.forEach(p => { map[p.name.toLowerCase()] = p.best.code; });
  Object.assign(map, OVERRIDE);

  const machine = Object.fromEntries(parseSummary(path.resolve(__dirname, 'downloads', 'salarydata_2026-04.xls')).map(e => [e.code, e]));
  // owner rule: missed-punch (single punch) day = full worked day
  const inout = XLSX.utils.sheet_to_json(XLSX.readFile(path.resolve(__dirname, 'downloads', 'inout_2026-04.xls')).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
  const single = {};
  for (const r of inout) { const c = String(r[0] || '').trim(); if (!c) continue; const iNA = !/\d/.test(String(r[2])), oNA = !/\d/.test(String(r[3])); if (iNA !== oNA) single[c] = (single[c] || 0) + 1; }
  for (const c in machine) { const n = Math.min(single[c] || 0, machine[c].absentDays); if (n) { machine[c].presentDays = Math.min(26, machine[c].presentDays + n); machine[c].absentDays = Math.max(0, machine[c].absentDays - n); } }

  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets[XLSX.readFile(file).SheetNames[0]], { header: 1, defval: '' });
  const out = []; let totPaid = 0, totEng = 0;
  for (const r of rows.slice(1)) {
    const name = String(r[0] || '').trim();
    const exDays = Number(r[1]), exOt = Number(r[2]) || 0, theirGross = Number(r[4]), rate = Number(r[5]);
    if (!name || !rate || !theirGross) continue;
    const code = map[name.toLowerCase()];
    const m = code && machine[code];
    if (!m) {
      out.push({ name, rate, exDays, exOt, paid: r0(theirGross), engDays: '', engOt: '', engine: '', diff: '', reason: 'not on machine in April (manual/app-only)' });
      totPaid += theirGross; continue;
    }
    const perDay = rate / 30;
    const pay = computePay({ emp: { type: 'monthly', amount: rate, shift: 'GEN' }, att: m, ...APRIL, advances: [], advanceBalanceIn: 0, advanceRecover: 0, latePenaltyDays: 0, weeklyOffDockDays: 0 });
    const engDays = 30 - m.absentDays + (m.absentDays === 0 ? 1 : 0);
    const diff = r0(pay.net - theirGross);
    const daysM = perDay * (engDays - exDays), otM = (pay.otHrsNet - exOt) * (perDay / 8);
    let reason;
    if (NIGHT.has(code)) reason = 'night worker — April machine data broken (fixed from May)';
    else if (m.presentDays === 0 && pay.net === 0) reason = 'no April punches on machine (paid manually)';
    else if (Math.abs(diff) <= 300) reason = '✓ match';
    else if (diff > 0) reason = 'Excel paid LESS than machine days (worker was short-paid)';
    else if (Math.abs(daysM) >= Math.abs(otM)) reason = 'machine cut days under old April rules; Excel paid full';
    else reason = 'net-OT rule: OT minus late hours (your rule); Excel paid raw OT';
    totPaid += theirGross; totEng += pay.net;
    out.push({ name, rate, exDays, exOt, paid: r0(theirGross), engDays, engOt: r0(pay.otHrsNet), engine: r0(pay.net), diff, reason });
  }
  out.sort((a, b) => (Math.abs(b.diff || 0)) - (Math.abs(a.diff || 0)));

  const aoa = [
    ['APRIL 2026 — paid (your Excel) vs app engine (final rules, missed punch = full day)'],
    [],
    ['Name', 'Rate ₹/mo', 'Days (Excel)', 'OT (Excel)', 'PAID ₹', 'Days (App)', 'Net OT (App)', 'APP ₹', 'Difference ₹', 'Reason'],
    ...out.map(o => [o.name, o.rate, o.exDays, o.exOt, o.paid, o.engDays, o.engOt, o.engine, o.diff, o.reason]),
    [],
    ['TOTAL', '', '', '', r0(totPaid), '', '', r0(totEng), r0(totEng - totPaid), ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 52 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'April compare');
  const dest = path.join(DESKTOP, 'april salary comparison.xlsx');
  XLSX.writeFile(wb, dest);
  console.log('written:', dest, `(${out.length} rows)`);

  // chat table
  console.log('\nname'.padEnd(25) + 'paid₹   app₹   diff₹  reason');
  out.forEach(o => console.log(o.name.slice(0, 23).padEnd(24) + String(o.paid).padStart(7) + String(o.engine).padStart(8) + String(o.diff).padStart(8) + '  ' + o.reason));
  console.log('TOTAL'.padEnd(24) + String(r0(totPaid)).padStart(7) + String(r0(totEng)).padStart(8) + String(r0(totEng - totPaid)).padStart(8));
})().catch(e => { console.error(e); process.exit(1); });
