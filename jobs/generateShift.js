// ERP_GenrateShift.aspx: generate the monthly shift roster for SELECTED employees only (never "Reset").
//   CODES=a,b MONTH=dd/mm/yyyy (any day of the month) DRY=true|false
const { session } = require('./lib/realtime');
const CODES = (process.env.CODES || '').split(',').filter(Boolean);
const MONTH = process.env.MONTH; const DRY = process.env.DRY !== 'false';
(async () => {
  if (!CODES.length || !MONTH) throw new Error('CODES MONTH required');
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    await page.goto('https://onlinerealsoft.com/ERP_GenrateShift.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    await page.evaluate(() => { document.querySelectorAll('.modal.show,.modal.fade,.modal-backdrop').forEach(e => e.remove()); document.body.classList.remove('modal-open'); });
    await page.evaluate((v) => { const el = document.getElementById('TxtfromDate'); if (el._flatpickr) el._flatpickr.setDate(v, true, 'd/m/Y'); el.value = v; ['input','change','blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true }))); }, MONTH);
    await page.waitForTimeout(1500);
    const sel = await page.evaluate((codes) => {
      const boxes = Array.from(document.querySelectorAll('input[type=checkbox][id^="LstEmployee_"]'));
      const master = document.getElementById('employee-checkbox'); if (master) master.checked = false;
      let picked = [], wasChecked = 0;
      for (const b of boxes) { if (b.checked) wasChecked++; const label = (b.parentElement?.innerText || b.nextSibling?.textContent || '').replace(/\s+/g, ' ').trim(); const m = label.match(/\((\d{8})\)/); const code = m ? m[1] : null; b.checked = codes.includes(code); if (b.checked) picked.push(label); }
      return { total: boxes.length, wasChecked, picked, checked: boxes.filter(b => b.checked).length, date: document.getElementById('TxtfromDate').value, deptChecked: Array.from(document.querySelectorAll('input[type=checkbox][id^="LstDepartment_"]')).filter(b => b.checked).length };
    }, CODES);
    console.log(JSON.stringify(sel));
    if (sel.checked !== CODES.length || sel.picked.length !== CODES.length) throw new Error('selection mismatch');
    if (DRY) { console.log('DRY — not generating'); return; }
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}), page.click('#cmdShowReport')]);
    await page.waitForTimeout(4000);
    console.log('url', page.url(), 'dialogs', JSON.stringify(dialogs), 'text', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(180, 420))));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
