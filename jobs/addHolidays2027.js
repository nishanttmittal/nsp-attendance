// Add the owner-approved 2027 holiday list (15-11-2026) to the Realtime V26 portal (ERP_HolidayList).
// DRY=true (default) fills the form, saves nothing. DRY=false saves. ONLY=26/01/2027 to do one.
// Idempotent: skips any date already on the list. Full Day, Include WeakOff unchecked, all employees (portal default).
const { session } = require('./lib/realtime');
const DRY = process.env.DRY !== 'false';
const LIST = 'https://onlinerealsoft.com/ERP_HolidayList.aspx';
const ALL = [['Republic Day','26/01/2027'],['Holi','22/03/2027'],['Independence Day','15/08/2027'],['Raksha Bandhan','17/08/2027'],
  ['Gandhi Jayanti','02/10/2027'],['Dussehra','09/10/2027'],['Diwali','29/10/2027'],['Vishwakarma Day','30/10/2027'],['Bhai Dooj','31/10/2027']];
const H = process.env.ONLY ? ALL.filter(h => h[1] === process.env.ONLY) : ALL;
async function listText(page){ await page.goto(LIST,{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2000); return page.evaluate(()=>document.body.innerText); }
(async () => {
  const { browser, page } = await session(); const rep = [];
  page.on('dialog', d => d.accept());
  try {
    for (const [name, date] of H) {
      const t = await listText(page);
      if (t.includes(date)) { rep.push(`SKIP ${name} ${date} (already on list)`); continue; }
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}), page.click('#BtnAddNew')]); await page.waitForTimeout(2000);
      await page.fill('#txtholidayname', name);
      await page.locator('#txtholidate').evaluate((n, v) => {
        if (n._flatpickr && n._flatpickr.setDate) { try { n._flatpickr.setDate(v, true, 'd/m/Y'); } catch(e){} }
        n.value = v; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true}));
      }, date);
      await page.keyboard.press('Escape').catch(()=>{});
      await page.selectOption('#txtholidaydesc', { label: 'Full Day' });
      if (await page.isChecked('#chkadjust')) await page.uncheck('#chkadjust');
      const chk = await page.evaluate(()=>[...document.querySelectorAll('input[id^=LstEmployee_]')].filter(x=>x.checked).length);
      const n = await page.inputValue('#txtholidayname'), d = await page.inputValue('#txtholidate');
      rep.push(`${DRY?'DRY ':''}${name}: form name="${n}" date="${d}" employees=${chk}`);
      if (d !== date || n !== name || chk < 70) { rep.push('  *** ABORT: form mismatch, nothing saved'); break; }
      if (!DRY) { await Promise.all([page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}), page.click('#btnSaveHoliday')]); await page.waitForTimeout(2500); rep.push('  -> SAVED'); }
    }
    if (!DRY) { const t = await listText(page); rep.push('', 'VERIFY:'); for (const [name, date] of H) rep.push(`  ${date} ${name}: ${t.includes(date) ? 'present' : 'MISSING'}`);
      const m = t.match(/Total Records:\s*\d+/); rep.push('  '+(m?m[0]:'')); }
  } catch(e) { rep.push('ERROR: '+e.message); } finally { await browser.close(); }
  console.log(rep.join('\n'));
})();
