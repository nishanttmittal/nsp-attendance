// READ-ONLY recon of the Realtime employee Edit/Delete UI. NO saves, NO deletes, NO clicks
// on anything destructive. Dumps control ids on EmployeeList.aspx + one employee Edit page,
// looks for name/dept fields, a delete control, and any resign/DOJ/leaving-date field.
//   Optional: ROWID=<n> to open a specific employee edit page (default = first row's edit link).
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');

const dumpControls = async (page, tag) => {
  return await page.evaluate((t) => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      value: (el.value || el.getAttribute('value') || '').slice(0, 40),
      text: (el.innerText || el.textContent || '').trim().slice(0, 40),
      href: el.getAttribute('href') || '',
    });
    const want = /del|remove|resign|leav|reliev|doj|join|name|dept|depart|card|save|update|exit/i;
    const els = Array.from(document.querySelectorAll('input,select,a,button,textarea'));
    const hits = els.map(pick).filter(c =>
      want.test(c.id) || want.test(c.name) || want.test(c.text) || want.test(c.value) || want.test(c.href));
    return { tag: t, url: location.href, title: document.title, count: els.length, hits };
  }, tag);
};

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  try {
    // 1) Employee list page
    await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const list = await dumpControls(page, 'EmployeeList');
    await page.screenshot({ path: path.join(OUT_DIR, 'recon_list.png'), fullPage: true });
    console.log('=== LIST PAGE ===');
    console.log(JSON.stringify(list, null, 1));

    // find an edit link into Employee.aspx (read-only navigation)
    const rowid = process.env.ROWID;
    let editHref = null;
    if (rowid) editHref = `Employee.aspx?RowId=${rowid}`;
    else {
      editHref = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href*="Employee.aspx"]'))
          .find(x => /RowId=\d+/.test(x.getAttribute('href')) && !/RowId=0\b/.test(x.getAttribute('href')));
        return a ? a.getAttribute('href') : null;
      });
    }
    console.log('\nedit link chosen:', editHref);

    if (editHref) {
      const url = editHref.startsWith('http') ? editHref : 'https://onlinerealsoft.com/' + editHref.replace(/^\//, '');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const edit = await dumpControls(page, 'EmployeeEdit');
      await page.screenshot({ path: path.join(OUT_DIR, 'recon_edit.png'), fullPage: true });
      console.log('\n=== EDIT PAGE ===');
      console.log(JSON.stringify(edit, null, 1));
    } else {
      console.log('No edit link found on the list page — grid may use postback buttons; see recon_list.png.');
    }
  } finally { await browser.close(); }
})();
