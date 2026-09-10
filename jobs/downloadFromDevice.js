// ERP_AttendanceLog.aspx: pull raw logs from the device into the portal for FROM..TO (dd/mm/yyyy).
const { session } = require('./lib/realtime');
const { FROM, TO } = process.env;
(async () => {
  if (!FROM || !TO) throw new Error('FROM TO required');
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    await page.goto('https://onlinerealsoft.com/ERP_AttendanceLog.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    await page.evaluate(([f, t]) => { for (const [id, v] of [['txtdate', f], ['txttodate', t]]) { const el = document.getElementById(id); if (el._flatpickr) el._flatpickr.setDate(v, true, 'd/m/Y'); el.value = v; ['input', 'change', 'blur'].forEach(x => el.dispatchEvent(new Event(x, { bubbles: true }))); }
      const dl = document.getElementById('Device_List'); Array.from(dl.options).forEach(o => o.selected = true); dl.dispatchEvent(new Event('change', { bubbles: true })); }, [FROM, TO]);
    const v = await page.evaluate(() => ({ from: document.getElementById('txtdate').value, to: document.getElementById('txttodate').value, dev: Array.from(document.getElementById('Device_List').selectedOptions).map(o => o.text) }));
    console.log('set:', JSON.stringify(v));
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}), page.click('#Button3')]);
    await page.waitForTimeout(5000);
    console.log('url:', page.url(), 'dialogs:', JSON.stringify(dialogs));
    console.log('text:', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(180, 700))));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
