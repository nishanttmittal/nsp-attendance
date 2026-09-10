// Read all form fields of ERP_Employee.aspx for a RowId (base64) — probe/verify helper. ROWID=0 → Add page.
const { session, readGrid } = require('./lib/realtime');
const KEEP = ['Txtempname','Txtcardno','Txtpaycode','CboGender','cbocompnayname','cbobranchname','cbodeptname','cbodesignation','cboofficetimepolicy','TxtDOJ','txtshiftstartdate','cboshifttype','cboshiftname','cboFWOff','cboSWOtype','cboSWOff','cbohalfdayshift','chkActiveFlag','cboWeekZone','txtDateofBirth','Txtvaliditystart','Txtvalidityend'];
(async () => {
  const { browser, page } = await session();
  try {
    const rowid = process.env.ROWID || '0';
    const enc = encodeURIComponent(Buffer.from(String(rowid)).toString('base64'));
    await page.goto('https://onlinerealsoft.com/ERP_Employee.aspx?RowId=' + enc, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const out = await page.evaluate((keep) => {
      const r = { url: location.href, title: document.title, bodyStart: document.body.innerText.slice(0, 120).replace(/\s+/g,' ') };
      for (const id of keep) { const el = document.getElementById(id); if (!el) { r[id] = '(missing)'; continue; }
        if (el.tagName === 'SELECT') r[id] = { sel: el.options[el.selectedIndex]?.text.trim(), opts: Array.from(el.options).map(o => o.text.trim()).slice(0, 15) };
        else if (el.type === 'checkbox') r[id] = el.checked; else r[id] = el.value; }
      return r;
    }, KEEP);
    console.log(JSON.stringify(out, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
