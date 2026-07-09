// Publishes RAW daily in/out punches to Firestore (att_punches) so the WEB APP's own attendance
// engine can compute present/half/absent itself — no dependency on the portal's classification.
// Punches are immutable facts (unlike computed status), so this is safe to refresh any time.
//   MONTHS=0,1  (0=current to-date, 1=last month)   node publishPunches.js
const XLSX = require('xlsx');
const { session, downloadMonthly } = require('./lib/realtime');
const { db } = require('./lib/firestore');

const MONTHS = (process.env.MONTHS || '0,1').split(',').map(s => parseInt(s, 10));
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const clean = s => { s = String(s).trim(); return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : null; };

function range(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const to = offset === 0 ? yesterday : lastOfMonth;
  return { first, to, label: `${first.getFullYear()}-${pad(first.getMonth() + 1)}` };
}

async function pullInOut(page, from, to) {
  const dl = await downloadMonthly(page, from, to, 'inout');
  const tmp = require('path').join(require('os').tmpdir(), `punches_${Date.now()}.xls`);
  await dl.saveAs(tmp);
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(tmp).Sheets['Sheet1'], { header: 1, blankrows: false }).slice(1);
  require('fs').unlinkSync(tmp);
  const byCode = {};
  for (const r of rows) {
    const code = String(r[0]).trim(); if (!code) continue;
    const dd = String(r[1]).trim().slice(0, 2);              // day-of-month
    const i = clean(r[2]), o = clean(r[3]);
    (byCode[code] = byCode[code] || {})[dd] = { i, o };
  }
  return byCode;
}

(async () => {
  const { browser, page } = await session();
  try {
    for (const offset of MONTHS) {
      const { first, to, label } = range(offset);
      const byCode = await pullInOut(page, fmt(first), fmt(to));
      let batch = db().batch(), n = 0, written = 0;
      for (const code of Object.keys(byCode)) {
        const ref = db().collection('att_punches').doc(code);
        batch.set(ref, { months: { [label]: byCode[code] }, updatedAt: new Date().toISOString() }, { merge: true });
        if (++n >= 400) { await batch.commit(); written += n; batch = db().batch(); n = 0; }
      }
      if (n) { await batch.commit(); written += n; }
      console.log(`att_punches ${label}: published raw in/out for ${written} employees`);
    }
  } finally { await browser.close(); }
})();
