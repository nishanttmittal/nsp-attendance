// VERIFY (read-only, no writes): reconstruct each Saturday's "earned weekly-off" from the
// May daily in-out report and check it reproduces the machine's weeklyOff / weeklyOffPresent.
// Then list employees with an UNQUALIFIED-but-WORKED Saturday (owner rule: OT only, day absent).
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { parseSummary } = require('./salaryData');

const INOUT = path.resolve(__dirname, 'downloads/inout_2026-05.xls');
const SUMMARY = ['downloads/may_final_rules.xls', 'downloads/final_may_summary.xls'].map(f => path.resolve(__dirname, f)).find(fs.existsSync);
const QUALIFY = 4; // present working-days needed in a week to earn that Saturday

const isNA = s => !/\d/.test(String(s));
const toYMD = s => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s)) || /(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if (!m) return ''; return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };
const dow = ymd => new Date(ymd + 'T00:00:00').getDay(); // 0=Sun..6=Sat
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const saturdayOf = ymd => addDays(ymd, (6 - dow(ymd)));   // week = Sun..Sat → the Saturday that ends it

// per employee: day -> present?(any punch)
const rows = XLSX.utils.sheet_to_json(XLSX.readFile(INOUT).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
const byEmp = {};
for (const r of rows) {
  const code = String(r[0] || '').trim(); if (!code) continue;
  const ymd = toYMD(r[1]); if (!ymd) continue;
  const present = !(isNA(r[2]) && isNA(r[3]));   // at least one punch = present that day
  (byEmp[code] || (byEmp[code] = {}))[ymd] = present;
}

// machine summary
const summary = {}; parseSummary(SUMMARY).forEach(e => { summary[e.code] = e; });

let okWO = 0, okWOP = 0, total = 0;
const unpaidCases = [];
for (const [code, days] of Object.entries(byEmp)) {
  // group present working-days per week + which Saturdays were worked
  const weeks = {}; const satWorked = {};
  for (const [ymd, present] of Object.entries(days)) {
    const wk = saturdayOf(ymd);
    if (dow(ymd) === 6) { satWorked[wk] = present; }     // the Saturday itself
    else { weeks[wk] = (weeks[wk] || 0) + (present ? 1 : 0); } // Sun-Fri working days present
  }
  // only score Saturdays that fall IN May (the report month)
  const mySats = Object.keys(satWorked).filter(s => s.startsWith('2026-05'));
  let myWO = 0, myWOP = 0, myUnpaid = 0;
  for (const sat of mySats) {
    const presentInWeek = weeks[sat] || 0;
    const qualified = presentInWeek >= QUALIFY;
    const worked = !!satWorked[sat];
    if (worked) { myWOP++; if (!qualified) { myUnpaid++; } }
    else if (qualified) { myWO++; }                       // earned + rested = paid weekly-off
    // unqualified + not worked = absent (machine already counts it)
  }
  const s = summary[code]; if (!s) continue;
  total++;
  if (myWO === Math.round(s.weeklyOff)) okWO++;
  if (myWOP === Math.round(s.weeklyOffPresent)) okWOP++;
  if (myUnpaid > 0) unpaidCases.push({ code, name: (s.name || '').slice(0, 18), absent: s.absentDays, mWO: s.weeklyOff, mWOP: s.weeklyOffPresent, myWO, myWOP, myUnpaid });
}
console.log(`Matched machine weeklyOff for ${okWO}/${total} employees; weeklyOffPresent for ${okWOP}/${total}.`);
console.log(`\nEmployees with an UNQUALIFIED + WORKED Saturday (owner rule: OT only, keep absent): ${unpaidCases.length}`);
unpaidCases.sort((a, b) => b.myUnpaid - a.myUnpaid).slice(0, 25)
  .forEach(c => console.log(`  ${c.code} | ${c.name.padEnd(18)} | absent ${c.absent} | machine WO${c.mWO}/WOP${c.mWOP} | mine WO${c.myWO}/WOP${c.myWOP} | unpaidWorkedSat=${c.myUnpaid}`));
