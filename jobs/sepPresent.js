// Pull 01/09/2026 → today in/out from the portal; print per-worker Sept present days.
const XLSX = require('/home/nishel/attendance-app/jobs/node_modules/xlsx');
const { session, downloadMonthly } = require('/home/nishel/attendance-app/jobs/lib/realtime');
const { db } = require('/home/nishel/attendance-app/jobs/lib/firestore');
const clean = s => { s = String(s).trim(); return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : null; };
(async () => {
  const { browser, page } = await session();
  let byCode = {};
  try {
    const dl = await downloadMonthly(page, '01/09/2026', '10/09/2026', 'inout');
    const tmp = '/tmp/claude-1000/-home-nishel/e12d7dcd-9e4f-47c0-bddd-513328324a25/scratchpad/sep_inout.xls';
    await dl.saveAs(tmp);
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(tmp).Sheets['Sheet1'], { header: 1, blankrows: false }).slice(1);
    for (const r of rows) { const code = String(r[0]).trim(); if (!code) continue; const dd = String(r[1]).trim().slice(0,2); const i = clean(r[2]), o = clean(r[3]); if (i || o) (byCode[code] = byCode[code] || {})[dd] = 1; }
  } finally { await browser.close(); }
  const roster = (await db().collection('att_meta').doc('roster').get()).data().employees;
  const out = roster.map(e => ({ code: e.code, name: e.name, dept: e.dept, days: Object.keys(byCode[e.code] || {}).length, last: Object.keys(byCode[e.code] || {}).sort().slice(-1)[0] || '-' }));
  require('fs').writeFileSync('/tmp/claude-1000/-home-nishel/e12d7dcd-9e4f-47c0-bddd-513328324a25/scratchpad/sepPresent.json', JSON.stringify(out, null, 1));
  console.log('rows', out.length, 'punch codes', Object.keys(byCode).length);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
