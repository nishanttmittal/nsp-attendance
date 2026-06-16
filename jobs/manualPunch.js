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
    // dual-portal: OLD Manual_Punch.aspx (#MainContent_ + #cmdsave) or V26 ERP_ManualEntry (# + #BtnAdd1)
    await page.goto('https://onlinerealsoft.com/Manual_Punch.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const isOld = await page.locator('#MainContent_TxtPunchDate').count().catch(() => 0);
    if (!isOld) { await page.goto('https://onlinerealsoft.com/ERP_ManualEntry.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800); }
    const P = isOld ? '#MainContent_' : '#';
    const insertBtn = isOld ? '#MainContent_cmdsave' : '#BtnAdd1';

    const sel = await selectFewEmployee(page, EMP);
    if (sel.checkedCount !== 1) bad(`SAFETY ABORT: ${sel.checkedCount} employees selected (expected 1) — NOT inserting`);
    const who = sel.label;
    await setField(page, P + 'TxtPunchDate', DATE);
    if (!isOld) await setField(page, '#Txtdateto', DATE);   // V26 also has a to-date (single day = same)
    if (IN) await setField(page, P + 'txttime', IN);
    if (OUT) await setField(page, P + 'TxtOutTime', OUT);
    await setField(page, P + 'txtremark', REMARK);

    console.log(`Employee: ${who} (portal: ${isOld ? 'old' : 'V26'}, checked: ${sel.checkedCount})`);
    console.log(`Date ${DATE}  IN ${IN || '—'}  OUT ${OUT || '—'}  remark="${REMARK}"`);
    console.log(`Verify -> date="${await page.locator(P + 'TxtPunchDate').inputValue()}" in="${await page.locator(P + 'txttime').inputValue()}" out="${await page.locator(P + 'TxtOutTime').inputValue()}"`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manualpunch_prepared.png'), fullPage: true });

    if (DRY) { console.log('=> DRY: not inserted'); return; }

    const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.click(insertBtn),
    ]);
    await page.waitForTimeout(2000);
    const dialogText = dialogs.join(' | ');
    if (dialogs.length) console.log('result: ' + dialogText.slice(0, 200));
    // SAFETY: a mass-insert dialog lists many "Biometric ID" entries — catch any regression
    const idCount = (dialogText.match(/Biometric ID/g) || []).length;
    if (idCount > 2) throw new Error(`SAFETY: insert appears to have affected ${idCount} employees (mass-insert) — aborting before reprocess`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manualpunch_inserted.png'), fullPage: true });
    console.log('=> INSERTED');

    if (REPROCESS) { await reprocessDay(page, DATE); console.log('=> reprocessed ' + DATE); }
  } finally { await browser.close(); }
})();
