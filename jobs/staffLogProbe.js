const { session, readGrid } = require('./lib/realtime');
const WANT = (process.env.CODES || '').split(',');
(async () => {
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/ERP_StaffLogReportWithPhoto.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
    for (const d of (process.env.DATES || '').split(',')) {
      await page.fill('#txtdate', d);
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.locator('#txtdate').dispatchEvent('change')]);
      await page.waitForTimeout(3500);
      const g = await readGrid(page).catch(() => []);
      const rows = g.slice(1); const hits = rows.filter(r => WANT.includes(r[2]));
      const now = await page.evaluate(() => document.getElementById('txtdate')?.value);
      console.log(d, '-> field', now, '| rows', rows.length, 'codes', new Set(rows.map(r => r[2])).size, 'date', rows[0]?.[5], '| hits:', JSON.stringify(hits.map(r => [r[2], r[5], r[6]])));
    }
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
