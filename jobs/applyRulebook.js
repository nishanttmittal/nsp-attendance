// Applies the 2026-07-06 PAYROLL RULEBOOK changes to the live Realtime portal.
// SAFE: DRY_RUN=true (default) fills fields + screenshots + RE-READS actual value, saves NOTHING.
// DRY_RUN=false clicks Save (cmdsave) per page. Per-page identity guard aborts on mismatch.
const fs = require('fs');
const path = require('path');
const { session } = require('./lib/realtime');
const DRY = process.env.DRY_RUN !== 'false';
const OUT = path.resolve(__dirname, 'apply_output'); fs.mkdirSync(OUT, { recursive: true });

const SHIFT = 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=';
const POLICY = 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=';
const S = '#MainContent_';
const PAGES = [
  { key:'shift_GEN', url:SHIFT+'2', idSel:S+'txtSftCode', expect:'GEN', ops:[
    [S+'chk2','select','None'], [S+'txtnoofweek','text','4'] ]},
  { key:'shift_10H', url:SHIFT+'3', idSel:S+'txtSftCode', expect:'10H', ops:[
    [S+'chk2','select','None'], [S+'txtnoofweek','text','4'], [S+'txtmaxrate','text','06:00'] ]},
  { key:'shift_12H', url:SHIFT+'4', idSel:S+'txtSftCode', expect:'12H', ops:[
    [S+'chk2','select','None'], [S+'txtnoofweek','text','4'], [S+'txtmaxrate','text','06:00'] ]},
  { key:'shift_wir', url:SHIFT+'5', idSel:S+'txtSftCode', expect:'wir', ops:[
    [S+'chk2','select','None'], [S+'txtnoofweek','text','4'], [S+'txtmaxrate','text','06:00'] ]},
  { key:'policy_GEN', url:POLICY+'2', idSel:S+'txtpolicyname', expect:'GEN', ops:[
    [S+'txtmaxabsentsortday','time','04:00'], [S+'txtdurationformakingpresent','time','07:00'],
    [S+'cbolateded3','select','None'], [S+'cbolateded4','select','None'] ]},
  { key:'policy_10H', url:POLICY+'3', idSel:S+'txtpolicyname', expect:'10H', ops:[
    [S+'txtmaxabsentsortday','time','04:00'], [S+'txtdurationformakingpresent','time','09:00'],
    [S+'cbolateded3','select','None'], [S+'cbolateded4','select','None'] ]},
  { key:'policy_12H', url:POLICY+'4', idSel:S+'txtpolicyname', expect:'12H', ops:[
    [S+'txtmaxabsentsortday','time','04:00'], [S+'txtdurationformakingpresent','time','10:30'],
    [S+'cbolateded3','select','None'], [S+'cbolateded4','select','None'] ]},
  { key:'policy_amarjeet', url:POLICY+'5', idSel:S+'txtpolicyname', expect:'amarjeet', ops:[
    [S+'txtmaxabsentsortday','time','04:00'], [S+'txtdurationformakingpresent','time','09:00'],
    [S+'cbolateded3','select','None'], [S+'cbolateded4','select','None'] ]},
];

const readVal = (page, sel, type) => type==='select'
  ? page.locator(sel).evaluate(n=> (n.options[n.selectedIndex]||{}).text||'').catch(()=>'?')
  : page.locator(sel).inputValue().catch(()=>'?');

async function setVal(page, sel, type, val) {
  if (type==='select') { await page.selectOption(sel,{ label:val }); return; }
  // text / readonly flatpickr time input: set the value the form actually submits
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
      const id = (await page.locator(P.idSel).inputValue().catch(()=> '')).trim();
      if (id.toLowerCase() !== P.expect.toLowerCase()) { report.push(`${P.key}: ABORT — page shows "${id}" not "${P.expect}"`); continue; }
      const lines = [];
      for (const [sel,type,to] of P.ops) {
        const before = await readVal(page, sel, type);
        await setVal(page, sel, type, to);
        const after = await readVal(page, sel, type);
        const ok = String(after).trim() === String(to).trim();
        lines.push(`${sel.replace(S,'')}: ${JSON.stringify(before)} -> ${JSON.stringify(after)} ${ok?'OK':'*** MISMATCH (wanted '+to+')'}`);
      }
      await page.screenshot({ path: path.join(OUT, `${P.key}_${DRY?'dry':'saved'}.png`), fullPage:true });
      if (!DRY) { await page.click(S+'cmdsave'); await page.waitForTimeout(2500); }
      report.push(`${P.key} (${id})${DRY?' [DRY, not saved]':' [SAVED]'}\n   `+lines.join('\n   '));
    }
  } catch(e){ report.push('ERROR: '+e.message); }
  finally { await browser.close(); }
  console.log((DRY?'=== DRY RUN (nothing saved) ===':'=== SAVED ===')+'\n'+report.join('\n'));
})();
