// END-TO-END April verification before the owner pays salaries with the app:
//   machine April summary (salarydata_2026-04.xls, untouched/clean) → app payroll engine
//   → compare per-person GROSS vs what was actually paid (Desktop/salary april 2026.xlsx).
// Uses the Excel's own RATE column (so rate edits since April don't pollute the test).
const path = require('path');
const XLSX = require('xlsx');
const { parseSummary } = require('./salaryData');
const { runMatch } = require('./importSalaryMatch');
const { computePay } = require('./salaryCalc');
const { db } = require('./lib/firestore');

const OVERRIDE = { // excel name (lowercased) -> machine code (owner-confirmed)
  'rakhtiv ansari ahjaj': '00000293', 'nand kishor': '00000099', 'lovekush press': '00000128',
  'kindal': '00000105', 'avnish july': '00000110', 'sonu july': '00000018',
};
const APRIL = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: new Date('2026-04-01'), toDate: new Date('2026-04-30') };
const r0 = n => Math.round(n);

(async () => {
  const file = '/mnt/c/Users/lenovo/Desktop/salary april 2026.xlsx';
  const { confident } = await runMatch(file);
  const map = {}; confident.forEach(p => { map[p.name.toLowerCase()] = p.best.code; });
  Object.assign(map, OVERRIDE);

  const machine = Object.fromEntries(parseSummary(path.resolve(__dirname, 'downloads', 'salarydata_2026-04.xls')).map(e => [e.code, e]));

  // CREDIT_MISSED=1: owner rule — a missed-punch (single-punch) day counts as a FULL worked
  // day (machine marked it absent). Credit those days back before computing pay.
  if (process.env.CREDIT_MISSED === '1') {
    const inout = XLSX.utils.sheet_to_json(XLSX.readFile(path.resolve(__dirname, 'downloads', 'inout_2026-04.xls')).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
    const single = {};
    for (const r of inout) {
      const code = String(r[0] || '').trim(); if (!code) continue;
      const inNA = !/\d/.test(String(r[2])), outNA = !/\d/.test(String(r[3]));
      if (inNA !== outNA) single[code] = (single[code] || 0) + 1;
    }
    for (const code in machine) {
      const n = Math.min(single[code] || 0, machine[code].absentDays); // can't credit more than absences
      if (!n) continue;
      machine[code].presentDays = Math.min(26, machine[code].presentDays + n); // 26 working days in April
      machine[code].absentDays = Math.max(0, machine[code].absentDays - n);
      machine[code]._credited = n;
    }
    console.log('missed-punch credit applied:', Object.entries(machine).filter(([, m]) => m._credited).map(([c, m]) => `${c}+${m._credited}`).join(' '));
  }
  const shifts = {}; (await db().collection('att_salary').get()).forEach(d => { shifts[d.id] = d.data().shift || 'GEN'; });

  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets[XLSX.readFile(file).SheetNames[0]], { header: 1, defval: '' });
  const out = []; let matched = 0, exact = 0, close = 0; let totTheirs = 0, totMine = 0;
  for (const r of rows.slice(1)) {
    const name = String(r[0] || '').trim();
    const exDays = Number(r[1]), exOt = Number(r[2]) || 0, theirGross = Number(r[4]), rate = Number(r[5]);
    if (!name || !rate || !theirGross) continue;
    const code = map[name.toLowerCase()];
    const m = code && machine[code];
    if (!m) { out.push({ name, theirGross: r0(theirGross), note: 'no machine record' }); continue; }
    matched++;
    const emp = { type: 'monthly', amount: rate, shift: shifts[code] || 'GEN' };
    const pay = computePay({ emp, att: m, ...APRIL, advances: [], advanceBalanceIn: 0, advanceRecover: 0, latePenaltyDays: 0, weeklyOffDockDays: 0 });
    const myGross = pay.net; // no deductions passed → net == gross (base+OT+bonus)
    const diff = r0(myGross - theirGross);
    totTheirs += theirGross; totMine += myGross;
    if (Math.abs(diff) <= 10) exact++; else if (Math.abs(diff) <= 300) close++;
    out.push({
      name, code, rate, shift: emp.shift,
      exDays, mPresent: m.presentDays, exOt, mNetOt: pay.otHrsNet,
      theirGross: r0(theirGross), myGross: r0(myGross), diff,
    });
  }

  console.log(`April end-to-end: machine data -> app engine vs paid Excel`);
  console.log(`Matched ${matched} staff. Exact (±₹10): ${exact} · Close (±₹300): ${close} · Bigger gap: ${matched - exact - close}`);
  console.log(`TOTAL paid (Excel): ₹${r0(totTheirs).toLocaleString('en-IN')}   TOTAL engine: ₹${r0(totMine).toLocaleString('en-IN')}   gap ₹${r0(totMine - totTheirs).toLocaleString('en-IN')}\n`);
  console.log('name'.padEnd(24) + 'shift  exDays mDays  exOT mNetOT   paid₹   engine₹   diff₹');
  out.filter(o => o.code).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).forEach(o => {
    console.log(o.name.slice(0, 23).padEnd(24) + String(o.shift).padEnd(7) + String(o.exDays).padStart(5) + String(o.mPresent).padStart(6)
      + String(o.exOt).padStart(7) + String(o.mNetOt).padStart(7) + String(o.theirGross).padStart(9) + String(o.myGross).padStart(10) + String(o.diff).padStart(8));
  });
  const un = out.filter(o => !o.code);
  if (un.length) console.log('\nIn Excel but not matched to machine: ' + un.map(o => o.name).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
