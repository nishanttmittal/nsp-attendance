// PHASE 1 (shadow mode): app-side attendance engine. Computes present/half/absent/weekly-off
// from RAW in/out punches — the rules live HERE, not in the flaky portal. Compares to the portal
// summary for the month to prove it reproduces (differences should be explainable by grace).
// READ-ONLY. Usage: MONTH=0|1 GRACE=on|off node shadowCalc.js
const XLSX = require('xlsx');
const emp = require('/tmp/emp_full.json');

const MONTH = parseInt(process.env.MONTH || '0', 10);
const GRACE = (process.env.GRACE || 'off') === 'on';           // 15-min grace
const FILE = MONTH === 0 ? 'downloads/monthly_2026-07_all.xls' : 'downloads/monthly_2026-06_all.xls';
const YM = MONTH === 0 ? [2026, 6] : [2026, 5];                 // month index (0-based)

// Shift cutoffs (hours). full line -15min when grace on. absent line 4:00 -> 3:45 when grace on.
const FULLCUT = { GEN: 7, '10H': 9, '12H': 10.5, wir: 9 };
const absLine = GRACE ? 3.75 : 4;
const fullLine = (shift) => (FULLCUT[shift] || 7) - (GRACE ? 0.25 : 0);
const WEEKLY_OFF_NEEDS = 4;                                     // present days in the week to earn Saturday

const H = s => { s = String(s).trim(); if (!/^\d/.test(s)) return null; const [a, b] = s.split(':').map(Number); return a + (b || 0) / 60; };

// worked span; if out is before in, the shift crossed midnight -> add 24h (night workers)
function workedHours(inH, outH) { let w = outH - inH; if (w < 0) w += 24; return w; }

// classify ONE weekday from its punches -> 'full' | 'half' | 'absent'  (Saturdays handled separately)
function classifyWeekday(shift, inH, outH) {
  if (inH == null && outH == null) return 'absent';
  if (inH != null && outH == null) return 'full';              // single punch = full
  const worked = workedHours(inH, outH);
  if (worked < absLine) return 'absent';
  if (worked < fullLine(shift)) return 'half';
  return 'full';
}

// build per-worker per-day map from BOTH month reports (so first-week earning can see prior month)
function loadDays() {
  const byCode = {};
  for (const f of ['downloads/monthly_2026-06_all.xls', 'downloads/monthly_2026-07_all.xls']) {
    let rows; try { rows = XLSX.utils.sheet_to_json(XLSX.readFile(f).Sheets['Sheet1'], { header: 1, blankrows: false }).slice(1); } catch (e) { continue; }
    for (const r of rows) {
      const code = String(r[0]).trim(); if (!code) continue;
      const d = String(r[1]).trim();                            // dd-mm-yyyy
      const day = new Date(d.split('-').reverse().join('-'));
      (byCode[code] = byCode[code] || []).push({ day, dow: day.getDay(), inH: H(r[2]), outH: H(r[3]) });
    }
  }
  return byCode;
}

// compute month totals for one worker within [start,to]; weekly-off earning uses the FULL week (all data)
function computeWorker(shift, allDays, start, to) {
  let present = 0, absent = 0, weeklyOff = 0, weeklyOffPresent = 0, half = 0;
  const inWin = d => d.day >= start && d.day <= to;
  // group ALL days by week (Sun-start) so earning sees cross-month weeks
  const weeks = {};
  for (const d of allDays) (weeks[weekKey(d.day)] = weeks[weekKey(d.day)] || []).push(d);
  for (const wk of Object.keys(weeks)) {
    const list = weeks[wk];
    let wdPresent = 0;                                          // full-week weekday presence (for earning)
    for (const d of list) {
      if (d.dow === 6) continue;
      const c = classifyWeekday(shift, d.inH, d.outH);
      if (c === 'full') wdPresent += 1; else if (c === 'half') wdPresent += 0.5;
    }
    const earned = wdPresent >= WEEKLY_OFF_NEEDS;
    for (const d of list) {
      if (!inWin(d)) continue;                                  // only COUNT days inside the pay window
      if (d.dow === 6) {
        if (d.inH != null) weeklyOffPresent += 1;               // worked Saturday -> OT, not a day
        else if (earned) weeklyOff += 1;                        // earned rest day (paid)
        else absent += 1;                                       // unearned Saturday -> absent
      } else {
        const c = classifyWeekday(shift, d.inH, d.outH);
        if (c === 'full') present += 1;
        else if (c === 'half') { present += 0.5; absent += 0.5; half += 1; }
        else absent += 1;
      }
    }
  }
  return { present: r2(present), absent: r2(absent), weeklyOff, weeklyOffPresent, half };
}

function weekKey(date) { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); }
const r2 = n => Math.round(n * 100) / 100;

// ---- run + reconcile against portal summary ----
(async () => {
  const days = loadDays();
  // portal summary for the same month (pre-pulled json)
  const portalDoc = MONTH === 0 ? require('/tmp/jul_pre.json') : require('/tmp/jun_now.json');
  const portal = portalDoc.employees;
  const pOf = c => portal.find(e => e.code === c) || {};
  const parse = s => new Date(String(s).split('/').reverse().join('-'));   // dd/mm/yyyy -> Date
  const start = parse(portalDoc.from), to = parse(portalDoc.to);

  let match = 0, diff = 0; const diffs = [];
  for (const code of Object.keys(days)) {
    const e = emp[code]; if (!e || !e.shift) continue;
    const app = computeWorker(e.shift, days[code], start, to);
    const p = pOf(code);
    if (p.presentDays == null) continue;
    const dP = Math.abs(app.present - (p.presentDays || 0));
    const dA = Math.abs(app.absent - (p.absentDays || 0));
    if (dP < 0.01 && dA < 0.01) match++;
    else { diff++; diffs.push({ code, name: (e.name || '').slice(0, 16), app, portal: { present: p.presentDays, absent: p.absentDays, weeklyOff: p.weeklyOff, weeklyOffPresent: p.weeklyOffPresent } }); }
  }
  console.log(`SHADOW ENGINE — month ${YM[0]}-${String(YM[1] + 1).padStart(2, '0')}  grace=${GRACE ? 'ON' : 'OFF'}`);
  console.log(`MATCH portal present+absent: ${match}   DIFFER: ${diff}\n`);
  console.log('Differences (app vs portal):');
  for (const d of diffs.slice(0, 25))
    console.log(`  ${d.code} ${d.name.padEnd(17)} app[P ${d.app.present} A ${d.app.absent} WO ${d.app.weeklyOff} WOP ${d.app.weeklyOffPresent}]  portal[P ${d.portal.present} A ${d.portal.absent} WO ${d.portal.weeklyOff} WOP ${d.portal.weeklyOffPresent}]`);
  if (diffs.length > 25) console.log(`  ... +${diffs.length - 25} more`);
})();
