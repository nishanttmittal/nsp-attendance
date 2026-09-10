const { session } = require('./lib/realtime');
(async () => {
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/Home.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => (a.innerText.replace(/\s+/g,' ').trim() + ' → ' + a.getAttribute('href'))).filter(t => /aspx/i.test(t)));
    console.log([...new Set(links)].join('\n'));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
