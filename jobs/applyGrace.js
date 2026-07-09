// Applies the 15-minute GRACE to the day-classification cutoffs (owner-approved 2026-07-08).
// Only touches the 4 POLICY pages, only 2 fields each: absent line 04:00->03:45 and the
// full-day line ("half day if less than") -15min per shift. Leaves everything else untouched.
// SAFE: DRY_RUN=true (default) fills + re-reads + screenshots, saves NOTHING. DRY_RUN=false clicks Save.
const fs = require('fs');
const path = require('path');
const { session } = require('./lib/realtime');
const DRY = process.env.DRY_RUN !== 'false';
const OUT = path.resolve(__dirname, 'apply_output'); fs.mkdirSync(OUT, { recursive: true });

const POLICY = 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=';
const S = '#MainContent_';
// full-day line ("Mark as Half Day if working hour Less Than") per shift, minus 15 min grace.
const PAGES = [
  { key:'policy_GEN',      url:POLICY+'2', expect:'GEN',      absent:'03:45', full:'06:45' },
  { key:'policy_10H',      url:POLICY+'3', expect:'10H',      absent:'03:45', full:'08:45' },
  { key:'policy_12H',      url:POLICY+'4', expect:'12H',      absent:'03:45', full:'10:15' },
  { key:'policy_amarjeet', url:POLICY+'5', expect:'amarjeet', absent:'03:45', full:'08:45' },
];

const readVal = (page, sel) => page.locator(sel).inputValue().catch(()=>'?');
async function setVal(page, sel, val) {
  await page.locator(sel).evaluate((n, v) => {
    if (n._flatpickr && typeof n._flatpickr.setDate === 'function') { try { n._flatpickr.setDate(v, true); } catch(e){} }
    const ro = n.hasAttribute('readonly'); if (ro) n.removeAttribute('readonly');
    n.value = v; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true}));
    if (ro) n.setAttribute('readonly','readonly');
  }, val);
}

(async () => {
  const { browser, page } = await session();
  const report = [];
  try {
    for (const P of PAGES) {
      await page.goto(P.url, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1500);
      const id = (await page.locator(S+'txtpolicyname').inputValue().catch(()=> '')).trim();
      if (id.toLowerCase() !== P.expect.toLowerCase()) { report.push(`${P.key}: ABORT — page shows "${id}" not "${P.expect}"`); continue; }
      const ops = [ [S+'txtmaxabsentsortday', P.absent], [S+'txtdurationformakingpresent', P.full] ];
      const lines = [];
      for (const [sel, to] of ops) {
        const before = await readVal(page, sel);
        await setVal(page, sel, to);
        const after = await readVal(page, sel);
        const ok = String(after).trim() === String(to).trim();
        lines.push(`${sel.replace(S,'')}: ${JSON.stringify(before)} -> ${JSON.stringify(after)} ${ok?'OK':'*** MISMATCH (wanted '+to+')'}`);
      }
      await page.screenshot({ path: path.join(OUT, `grace_${P.key}_${DRY?'dry':'saved'}.png`), fullPage:true });
      if (!DRY) { await page.click(S+'cmdsave'); await page.waitForTimeout(2500); }
      report.push(`${P.key} (${id})${DRY?' [DRY, not saved]':' [SAVED]'}\n   `+lines.join('\n   '));
    }
  } catch(e){ report.push('ERROR: '+e.message); }
  finally { await browser.close(); }
  console.log((DRY?'=== DRY RUN (nothing saved) ===':'=== SAVED ===')+'\n'+report.join('\n'));
})();
