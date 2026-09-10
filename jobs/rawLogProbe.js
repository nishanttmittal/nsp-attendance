// Probe ERP_AttendanceLog.aspx: list its controls, then try to fetch raw logs for a date range.
const { session, readGrid } = require('./lib/realtime');
const fs = require('fs');
(async () => {
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/ERP_AttendanceLog.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    const info = await page.evaluate(() => ({
      url: location.href, title: document.title,
      inputs: Array.from(document.querySelectorAll('input,select,button,a[id]')).filter(e => e.id && !/^__/.test(e.id) && !/MainHeader/.test(e.id)).map(e => ({ id: e.id, tag: e.tagName, type: e.type, value: (e.value || e.innerText || '').slice(0, 40), opts: e.tagName === 'SELECT' ? Array.from(e.options).map(o => o.text.trim()).slice(0, 8) : undefined })),
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
    }));
    console.log(JSON.stringify(info, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
