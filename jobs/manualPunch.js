// Insert a missed punch for one employee, then reprocess that day.
//   EMP=<code>  DATE=dd/MM/yyyy  IN=HH:MM  OUT=HH:MM  REMARK="..."
//   DRY=true   -> select + fill + screenshot, do NOT insert (default safe)
//   REPROCESS=false -> skip the day reprocess after insert
// At least one of IN / OUT must be provided.
const path = require('path');
const fs = require('fs');
const { session, selectFewEmployee, setField, reprocessDay } = require('./lib/realtime');

const URL = 'https://onlinerealsoft.com/ERP_ManualEntry.aspx';   // V26 portal (was Manual_Punch.aspx)
const OUT_DIR = path.resolve(__dirname, 'downloads');
const EMP = process.env.EMP;
const DATE = process.env.DATE;
const IN = process.env.IN || '';
const OUT = process.env.OUT || '';
const REMARK = process.env.REMARK || 'manual punch (app)';
const DRY = process.env.DRY !== 'false';                 // default DRY for safety
const REPROCESS = process.env.REPROCESS !== 'false';     // default reprocess after a real insert

function bad(msg) { console.error('ERROR: ' + msg); process.exit(1); }

(async () => {
  if (!EMP || !DATE) bad('EMP and DATE are required');
  if (!IN && !OUT) bad('provide IN and/or OUT (HH:MM)');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const { browser, page } = await session();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    const who = await selectFewEmployee(page, EMP);
    await setField(page, '#TxtPunchDate', DATE);       // V26 ids (dropped #MainContent_ prefix)
    await setField(page, '#Txtdateto', DATE);          // V26: single day = same from/to
    if (IN) await setField(page, '#txttime', IN);
    if (OUT) await setField(page, '#TxtOutTime', OUT);
    await setField(page, '#txtremark', REMARK);

    console.log(`Employee: ${who}`);
    console.log(`Date ${DATE}  IN ${IN || '—'}  OUT ${OUT || '—'}  remark="${REMARK}"`);
    console.log(`Verify -> date="${await page.locator('#TxtPunchDate').inputValue()}" in="${await page.locator('#txttime').inputValue()}" out="${await page.locator('#TxtOutTime').inputValue()}"`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manualpunch_prepared.png'), fullPage: true });

    if (DRY) { console.log('=> DRY: not inserted'); return; }

    const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.click('#BtnAdd1'),    // V26: "Insert Manual Attendance" (was #MainContent_cmdsave)
    ]);
    await page.waitForTimeout(2000);
    if (dialogs.length) console.log('result: ' + dialogs.join(' | '));
    await page.screenshot({ path: path.join(OUT_DIR, 'manualpunch_inserted.png'), fullPage: true });
    console.log('=> INSERTED');

    if (REPROCESS) { await reprocessDay(page, DATE); console.log('=> reprocessed ' + DATE); }
  } finally { await browser.close(); }
})();
