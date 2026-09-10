// Read raw device punches per day from ERP_StaffLogReportWithPhoto for CODES; DATES=MM/DD/YYYY,...; writes OUT json
const { session, readGrid } = require('./lib/realtime');
const fs = require('fs');
const WANT = (process.env.CODES || '').split(',');
(async () => {
  const { browser, page } = await session();
  const out = {};
  try {
    await page.goto('https://onlinerealsoft.com/ERP_StaffLogReportWithPhoto.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
    for (const d of (process.env.DATES || '').split(',')) {
      let rows = [];
      for (let t = 0; t < 4 && !rows.length; t++) {
        if (t) { await page.goto('https://onlinerealsoft.com/ERP_StaffLogReportWithPhoto.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000); }
        await page.fill('#txtdate', d);
        await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.locator('#txtdate').dispatchEvent('change')]);
        await page.waitForTimeout(4000);
        const g = await readGrid(page).catch(() => []); rows = g.slice(1).filter(r => r[5]);
        const shown = rows[0]?.[5]; const want = d.split('/'); const wantDmy = `${want[1]}/${want[0]}/${want[2]}`;
        if (rows.length && shown !== wantDmy) { console.log(d, 'grid shows', shown, '≠', wantDmy, '— retry'); rows = []; }
      }
      const hits = rows.filter(r => WANT.includes('ALL') || WANT.includes(r[2]));
      for (const r of hits) { (out[r[2]] = out[r[2]] || {}); (out[r[2]][r[5]] = out[r[2]][r[5]] || []).push(r[6]); }
      console.log(d, 'rows', rows.length, 'codes', new Set(rows.map(r => r[2])).size, 'hits', hits.length);
    }
  } finally { await browser.close(); }
  for (const c of Object.keys(out)) for (const d of Object.keys(out[c])) out[c][d].sort();
  fs.writeFileSync(process.env.OUT || '/dev/stdout', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
