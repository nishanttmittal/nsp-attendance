// Weekly-off audit (owner rule 2026-06-14): a Saturday WORKED in a week that didn't earn the
// weekly-off (< 4 present days that week) is paid as OT only — the day stays absent. This job
// reads the daily in-out report (pulled from the Sunday BEFORE the 1st, so boundary weeks are
// whole) and writes att_attendance/{code}.months[mk].unpaidWorkedSat. The salary engine then
// deducts those days from base pay (OT is untouched).
//   MONTH=0 (current, default) | 1 | 2   — same offset convention as salaryData/missedPunchScan
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { session, setField, downloadMonthly } = require('./lib/realtime');
const { range } = require('./salaryData');
const { db } = require('./lib/firestore');

const QUALIFY = 4;                 // present working-days needed in a week to earn that Saturday
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const isNA = s => !/\d/.test(String(s));
const toYMD = s => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s)) || /(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if (!m) return ''; return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };
const dow = ymd => new Date(ymd + 'T00:00:00').getDay();              // 0=Sun..6=Sat
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const saturdayOf = ymd => addDays(ymd, 6 - dow(ymd));                  // week = Sun..Sat → its ending Saturday

// Pure: count per employee the worked-but-unearned Saturdays that fall in `label` (YYYY-MM).
function computeUnpaid(rows, label) {
  const byEmp = {};
  for (const r of rows) {
    const code = String(r[0] || '').trim(); if (!code) continue;
    const ymd = toYMD(r[1]); if (!ymd) continue;
    const present = !(isNA(r[2]) && isNA(r[3]));                       // any punch = present that day
    (byEmp[code] || (byEmp[code] = {}))[ymd] = present;
  }
  const out = {};
  for (const [code, days] of Object.entries(byEmp)) {
    const weekPresent = {}, satWorked = {};
    for (const [ymd, present] of Object.entries(days)) {
      const wk = saturdayOf(ymd);
      if (dow(ymd) === 6) satWorked[wk] = present;                     // the Saturday itself
      else weekPresent[wk] = (weekPresent[wk] || 0) + (present ? 1 : 0);
    }
    let unpaid = 0;
    for (const [sat, worked] of Object.entries(satWorked)) {
      if (!sat.startsWith(label)) continue;                           // only Saturdays inside the target month
      if (worked && (weekPresent[sat] || 0) < QUALIFY) unpaid++;      // worked + unearned week → OT only
    }
    if (unpaid > 0) out[code] = unpaid;
  }
  return out;
}

async function audit(offset = 0) {
  const { first, to, label } = range(offset);
  // extend the start back to the Sunday on/before the 1st so the first Saturday's week is whole
  const from = new Date(first); from.setDate(from.getDate() - from.getDay()); // getDay 0=Sun
  const { browser, page } = await session();
  try {
    const file = path.join(__dirname, 'downloads', `inout_audit_${label}.xls`);
    let dl;
    try { dl = await downloadMonthly(page, fmt(from), fmt(to), 'inout'); }   // works on either portal
    catch (e) {
      await page.screenshot({ path: path.join(__dirname, 'downloads', `audit_fail_${label}.png`), fullPage: true }).catch(() => {});
      throw new Error('in-out download did not start: ' + e.message);
    }
    await dl.saveAs(file);
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
    const unpaid = computeUnpaid(rows, label);

    // write months[label].unpaidWorkedSat for EVERY employee (0 clears any stale value)
    const all = await db().collection('att_attendance').get();
    let batch = db().batch(), n = 0, flagged = 0;
    all.forEach(d => {
      const v = unpaid[d.id] || 0; if (v) flagged++;
      batch.set(d.ref, { months: { [label]: { unpaidWorkedSat: v } } }, { merge: true });
      if (++n >= 400) { batch.commit(); batch = db().batch(); n = 0; }
    });
    if (n) await batch.commit();
    console.log(`weekly-off audit ${label}: ${flagged} employee(s) with an unearned worked Saturday`, JSON.stringify(unpaid));
    return { label, unpaid, flagged };
  } finally { await browser.close(); }
}

module.exports = { computeUnpaid, audit, saturdayOf };
if (require.main === module) audit(parseInt(process.env.MONTH || '0', 10)).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
