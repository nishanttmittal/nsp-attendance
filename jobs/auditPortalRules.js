// READ-ONLY audit: compare live Realtime portal rule settings to the owner's RULEBOOK (+15-min grace).
// Flags any MISMATCH. Saves nothing. (Owner ask 2026-07-09.)
const { session } = require('./lib/realtime');
const S = '#MainContent_';
const SHIFT = 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=';
const POLICY = 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=';

// expected values per the rulebook + grace
const PAGES = [
  { key:'shift_GEN', url:SHIFT+'2', id:S+'txtSftCode', expect:'GEN', fields:[
    [S+'chk2','sel','None','single-punch = full'], [S+'txtnoofweek','val','4','presents for weekly-off'], [S+'txtmaxrate','val','08:30','max OT'] ]},
  { key:'shift_10H', url:SHIFT+'3', id:S+'txtSftCode', expect:'10H', fields:[
    [S+'chk2','sel','None','single-punch = full'], [S+'txtnoofweek','val','4','presents for weekly-off'], [S+'txtmaxrate','val','06:00','max OT'] ]},
  { key:'shift_12H', url:SHIFT+'4', id:S+'txtSftCode', expect:'12H', fields:[
    [S+'chk2','sel','None','single-punch = full'], [S+'txtnoofweek','val','4','presents for weekly-off'], [S+'txtmaxrate','val','06:00','max OT'] ]},
  { key:'shift_wir', url:SHIFT+'5', id:S+'txtSftCode', expect:'wir', fields:[
    [S+'chk2','sel','None','single-punch = full'], [S+'txtnoofweek','val','4','presents for weekly-off'], [S+'txtmaxrate','val','06:00','max OT'] ]},
  { key:'policy_GEN', url:POLICY+'2', id:S+'txtpolicyname', expect:'GEN', fields:[
    [S+'txtmaxabsentsortday','val','03:45','absent line (grace)'], [S+'txtdurationformakingpresent','val','06:45','full-day line (grace)'],
    [S+'cbosinglepunchonly','sel','Fix Time Out','single-punch policy'], [S+'cbolateded1','sel','None','late1 %'], [S+'cbolateded2','sel','None','late2 %'], [S+'cbolateded3','sel','None','late3 %'], [S+'cbolateded4','sel','None','late4 %'] ]},
  { key:'policy_10H', url:POLICY+'3', id:S+'txtpolicyname', expect:'10H', fields:[
    [S+'txtmaxabsentsortday','val','03:45','absent line (grace)'], [S+'txtdurationformakingpresent','val','08:45','full-day line (grace)'],
    [S+'cbosinglepunchonly','sel','Fix Time Out','single-punch policy'], [S+'cbolateded3','sel','None','late3 %'], [S+'cbolateded4','sel','None','late4 %'] ]},
  { key:'policy_12H', url:POLICY+'4', id:S+'txtpolicyname', expect:'12H', fields:[
    [S+'txtmaxabsentsortday','val','03:45','absent line (grace)'], [S+'txtdurationformakingpresent','val','10:15','full-day line (grace)'],
    [S+'cbosinglepunchonly','sel','Fix Time Out','single-punch policy'], [S+'cbolateded3','sel','None','late3 %'], [S+'cbolateded4','sel','None','late4 %'] ]},
  { key:'policy_amarjeet', url:POLICY+'5', id:S+'txtpolicyname', expect:'amarjeet', fields:[
    [S+'txtmaxabsentsortday','val','03:45','absent line (grace)'], [S+'txtdurationformakingpresent','val','08:45','full-day line (grace)'],
    [S+'cbosinglepunchonly','sel','Fix Time Out','single-punch policy'], [S+'cbolateded3','sel','None','late3 %'], [S+'cbolateded4','sel','None','late4 %'] ]},
];

const read = (page, sel, type) => type==='sel'
  ? page.locator(sel).evaluate(n => (n.options[n.selectedIndex]||{}).text||'').catch(()=>'(field missing)')
  : page.locator(sel).inputValue().catch(()=>'(field missing)');

(async () => {
  const { browser, page } = await session();
  const out = []; let mismatches = 0;
  try {
    for (const P of PAGES) {
      await page.goto(P.url, { waitUntil:'domcontentloaded' }); await page.waitForTimeout(1400);
      const id = (await page.locator(P.id).inputValue().catch(()=> '')).trim();
      if (id.toLowerCase() !== P.expect.toLowerCase()) { out.push(`\n${P.key}: *** ABORT — page shows "${id}" not "${P.expect}"`); mismatches++; continue; }
      out.push(`\n${P.key} (${id}):`);
      for (const [sel, type, want, label] of P.fields) {
        const got = String(await read(page, sel, type)).trim();
        const ok = got === want;
        if (!ok) mismatches++;
        out.push(`   ${ok?'OK ':'>>>'} ${label}: got ${JSON.stringify(got)} ${ok?'':'  EXPECTED '+JSON.stringify(want)}`);
      }
    }
  } catch(e){ out.push('ERROR: '+e.message); }
  finally { await browser.close(); }
  console.log('=== PORTAL RULE AUDIT vs RULEBOOK ===' + out.join('\n'));
  console.log(`\n${mismatches===0 ? 'RESULT: ALL MATCH — portal is consistent with the rulebook.' : 'RESULT: '+mismatches+' MISMATCH(ES) FLAGGED above.'}`);
})();
