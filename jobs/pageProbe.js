const { session, readGrid } = require('./lib/realtime');
(async () => {
  const { browser, page } = await session();
  try {
    for (const p of (process.env.PAGES || '').split(',')) {
      await page.goto('https://onlinerealsoft.com/' + p, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
      const info = await page.evaluate(() => ({
        url: location.href, title: document.title,
        controls: Array.from(document.querySelectorAll('input,select,button,a[id]')).filter(e => e.id && !/^__|MainHeader|checkbox-input/.test(e.id)).map(e => e.id + ':' + (e.tagName === 'SELECT' ? '[' + Array.from(e.options).map(o => o.text.trim()).slice(0, 6).join('|') + ']' : (e.value || e.innerText || '').replace(/\s+/g, ' ').slice(0, 30))),
        text: document.body.innerText.replace(/\s+/g, ' ').slice(180, 900),
      }));
      const grid = await readGrid(page).catch(() => []);
      console.log('=== ' + p + '\n' + JSON.stringify(info, null, 1) + '\nGRID rows ' + (grid.length ? grid.length - 1 : 0) + ' header ' + JSON.stringify(grid[0] || []) + '\n' + JSON.stringify(grid.slice(1, 4)));
    }
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
