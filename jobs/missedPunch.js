// Missed-punch alert. Computed from the present list's In/Out (clean), not the
// messy ReportViewer. MODE=morning flags missing IN-punch; MODE=evening flags missing OUT-punch.
// Scheduled by GH Actions: morning run after grace, evening run after the latest shift ends.
const path = require('path');
const XLSX = require('xlsx');
const { session, downloadMonthly } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');
const { db } = require('./lib/firestore');

const MODE = (process.env.MODE || 'evening').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

// EVENING: punched in, no out (today, after shift). Computed from the present list.
function composeEvening(list) {
  const body = list.length ? list.map(r => `  • ${r.name} (${r.dept})  in ${r.inT || '—'} / out —`).join('\n') : '  • none 🎉';
  return `🌙 <b>Evening missed punch</b> (punched in, never punched OUT)\n${body}\n\n<i>Fix via the app's manual-punch entry.</i>`;
}

// MORNING (runs next day): employees who missed a punch YESTERDAY (single-punch). From the
// In-Out excel via downloadMonthly (works on either portal) — the old Missing-Punch report page
// (NewMonthly.aspx #Button6) was deleted with the old portal in Aug 2026, and the V26 version
// renders in a paginated ReportViewer that can't be text-scraped. Same single-punch rule as
// missedPunchScan.js: exactly one of First-In / Last-Out is NA.
async function yesterdayMisses(page) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  const d = fmtDate(y);
  const file = path.join(__dirname, 'downloads', 'inout_yesterday.xls');
  const dl = await downloadMonthly(page, d, d, 'inout');
  await dl.saveAs(file);
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).slice(1);
  const sal = {}; (await db().collection('att_salary').get()).forEach(s => { sal[s.id] = s.data(); });
  const isNA = v => !/\d/.test(String(v));
  const seen = new Set(); const out = [];
  for (const r of rows) {
    const code = String(r[0] || '').trim();
    if (!code || seen.has(code)) continue;
    if (isNA(r[2]) !== isNA(r[3])) {   // exactly one punch yesterday
      seen.add(code);
      out.push({ code, name: (sal[code] || {}).name || code, dept: (sal[code] || {}).dept || '' });
    }
  }
  return { date: d, list: out };
}

if (require.main === module) {
  (async () => {
    const { browser, page } = await session();
    try {
      if (MODE === 'morning') {
        const { date, list } = await yesterdayMisses(page);
        const body = list.length ? list.map(r => `  • ${r.name} (${r.dept})`).join('\n') : '  • none 🎉';
        await sendTelegram(`⏰ <b>Missed punch — ${date}</b> (single punch yesterday; review & correct)\n${body}\n\n<i>Fix via the app's manual-punch entry.</i>`);
        console.error(`[morning] yesterday ${date}: ${list.length} missed`);
      } else {
        const s = await gatherState(page);
        const list = (s.presentRows || []).filter(r => (r.inT && r.inT.trim()) && !(r.outT && r.outT.trim()));
        await sendTelegram(composeEvening(list));
        console.error(`[evening] flagged ${list.length} of ${(s.presentRows || []).length} present`);
      }
    } finally { await browser.close(); }
  })();
}

module.exports = { composeEvening };
