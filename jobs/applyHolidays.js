// Holiday edits (rulebook 2026-07-06): ADD Dussehra 20/10/2026; EDIT Vishwakarma date 17/09 -> 09/11/2026.
// SAFE: DRY_RUN=true (default) fills forms + reports, saves nothing. DRY_RUN=false clicks Save.
// Idempotent: skips Dussehra if 20/10/2026 already present. Identity guard on the Vishwakarma edit.
const { session } = require('./lib/realtime');
const DRY = process.env.DRY_RUN !== 'false';
const ADD  = 'https://onlinerealsoft.com/Holiday.aspx?RowId=0';
const VISH = 'https://onlinerealsoft.com/Holiday.aspx?RowId=13';
const LIST = 'https://onlinerealsoft.com/HolidayList.aspx';
const S = '#MainContent_';

async function setDate(page, val) {
  await page.locator(S+'txtholidate').evaluate((n, v) => {
    if (n._flatpickr && n._flatpickr.setDate) { try { n._flatpickr.setDate(v, true); } catch(e){} }
    const ro = n.hasAttribute('readonly'); if (ro) n.removeAttribute('readonly');
    n.value = v; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); if (n.blur) n.blur();
    if (ro) n.setAttribute('readonly','readonly');
  }, val);
  await page.keyboard.press('Escape').catch(()=>{});
}

(async () => {
  const { browser, page } = await session();
  const rep = [];
  try {
    await page.goto(LIST, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1500);
    const listText = await page.evaluate(()=>document.body.innerText);
    const needDussehra = !listText.includes('20/10/2026');
    rep.push(`Dussehra 20/10/2026 already present? ${!needDussehra}`);

    // 1) ADD Dussehra
    if (needDussehra) {
      await page.goto(ADD, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1000);
      await page.fill(S+'txtholidayname', 'Dussehra');
      await setDate(page, '20/10/2026');
      const n = await page.locator(S+'txtholidayname').inputValue();
      const d = await page.locator(S+'txtholidate').inputValue();
      rep.push(`ADD Dussehra: form name="${n}" date="${d}"`);
      if (!DRY) { await Promise.all([page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}), page.click(S+'cmdShowReport')]); await page.waitForTimeout(1500); rep.push('  -> SAVED'); }
    }

    // 2) EDIT Vishwakarma date (RowId=13) with identity guard
    await page.goto(VISH, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1000);
    const vn = await page.locator(S+'txtholidayname').inputValue().catch(()=>'');
    const vd = await page.locator(S+'txtholidate').inputValue().catch(()=>'');
    rep.push(`EDIT target (RowId=13): name="${vn}" date="${vd}"`);
    if (!/vishwakarma/i.test(vn)) { rep.push('  *** ABORT: RowId=13 is not Vishwakarma — no change'); }
    else {
      await setDate(page, '09/11/2026');
      const nvd = await page.locator(S+'txtholidate').inputValue();
      rep.push(`  date staged -> "${nvd}"`);
      if (!DRY) { await Promise.all([page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}), page.click(S+'cmdShowReport')]); await page.waitForTimeout(1500); rep.push('  -> SAVED'); }
    }

    // 3) verify (live only)
    if (!DRY) {
      await page.goto(LIST, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1500);
      const t = await page.evaluate(()=>document.body.innerText);
      rep.push('', `VERIFY  Dussehra 20/10/2026 present: ${t.includes('20/10/2026')}`,
        `        Vishwakarma 09/11/2026 present: ${t.includes('09/11/2026')}`,
        `        old 17/09/2026 gone: ${!t.includes('17/09/2026')}`);
    }
  } catch(e){ rep.push('ERROR: '+e.message); }
  finally { await browser.close(); }
  console.log((DRY?'=== DRY (nothing saved) ===':'=== LIVE ===')+'\n'+rep.join('\n'));
})();
