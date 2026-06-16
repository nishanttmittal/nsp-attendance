// Monthly attendance download — works on EITHER portal (vendor flip-flops old <-> V26).
//   MONTH=0|1|2   (0=current month-to-date, 1=last month, 2=two months ago)
//   SCOPE=all | dept:<DEPARTMENT NAME> | emp:<EMP CODE>
//   REPORT=Button10|summary (default) | Button15|inout | Button8|ot | Button13|late | perfbtn|performance
//   FROM/TO=dd/MM/yyyy optional custom range. DRY=true prepares only.
const path = require('path');
const fs = require('fs');
const { session, selectFewEmployee, setField, downloadMonthly } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const MONTH = parseInt(process.env.MONTH || '0', 10);
const SCOPE = process.env.SCOPE || 'all';
const REPORT = process.env.REPORT || 'Button10';
const DRY = process.env.DRY === 'true';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
function monthRange(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
  const to = offset === 0 ? now : lastOfMonth;
  return { from: first, to, label: `${first.getFullYear()}-${pad(first.getMonth() + 1)}` };
}

// Which kind of report is REPORT? direct-download (summary/inout) reuse the dual downloadMonthly helper.
const DIRECT = { Button10: 'summary', summary: 'summary', Button15: 'inout', inout: 'inout' };
// Viewer reports → CboReportFormat option text (V26) / the old #MainContent_<id> button.
const VIEWER_FMT = { perfbtn: 'Performence', performance: 'Performence', Button8: 'OT Summary', ot: 'OT Summary', Button13: 'Late Arrival', late: 'Late Arrival' };
const VIEWER_OLD_BTN = { perfbtn: 'perfbtn', performance: 'perfbtn', Button8: 'Button8', ot: 'Button8', Button13: 'Button13', late: 'Button13' };

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  try {
    const { from, to, label } = monthRange(MONTH);
    const F = process.env.FROM || fmt(from), T = process.env.TO || fmt(to);
    const scopeTag = SCOPE.startsWith('emp:') ? 'emp-' + SCOPE.slice(4) : SCOPE.startsWith('dept:') ? 'dept-' + SCOPE.slice(5).replace(/\s+/g, '_') : 'all';

    // DIRECT reports + whole-company scope → the dual helper handles portal + dates + button.
    if (DIRECT[REPORT] && SCOPE === 'all') {
      if (DRY) { console.log(`DRY: ${label} ${F}..${T} ${DIRECT[REPORT]} all`); return; }
      const dl = await downloadMonthly(page, F, T, DIRECT[REPORT]);
      const outPath = path.join(OUT_DIR, `monthly_${label}_all.xls`);
      await dl.saveAs(outPath);
      console.log(`=> DOWNLOADED ${path.basename(outPath)} (${fs.statSync(outPath).size} bytes)`);
      return;
    }

    // Otherwise navigate the monthly page directly (detect portal for ids).
    await page.goto('https://onlinerealsoft.com/NewMonthly.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1300);
    const isOld = await page.locator('#MainContent_txtdate').count().catch(() => 0);
    if (!isOld) { await page.goto('https://onlinerealsoft.com/ERP_NewMonthly.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); }
    if (isOld && await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
    await setField(page, isOld ? '#MainContent_txtdate' : '#txtdate', F);
    await setField(page, isOld ? '#MainContent_txttodate' : '#txtdateto', T);

    if (SCOPE.startsWith('emp:')) { const sel = await selectFewEmployee(page, SCOPE.slice(4)); console.log('  picked:', sel.label, '(checked', sel.checkedCount + ')'); }
    else if (SCOPE.startsWith('dept:')) { await setField(page, isOld ? '#MainContent_TextBox1' : '#TextBox1', SCOPE.slice(5)).catch(() => {}); await page.click(isOld ? '#MainContent_Filter' : '#Filter').catch(() => {}); await page.waitForTimeout(1500); }

    console.log(`Month ${label} ${F}..${T} scope=${SCOPE} report=${REPORT} portal=${isOld ? 'old' : 'V26'}`);
    if (DRY) { console.log('=> DRY: prepared only'); return; }

    let outName, outPath;
    if (DIRECT[REPORT]) {            // direct download with a scope selected
      const btn = isOld ? (DIRECT[REPORT] === 'inout' ? '#MainContent_Button15' : '#MainContent_Button10') : (DIRECT[REPORT] === 'inout' ? '#LinkButton22' : '#LinkButton21');
      outName = `monthly_${label}_${scopeTag}.xls`; outPath = path.join(OUT_DIR, outName);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.click(btn)]);
      await dl.saveAs(outPath);
      console.log(`=> DOWNLOADED ${outName} (${fs.statSync(outPath).size} bytes)`);
      return;
    }

    // Viewer report (performance/ot/late): render then SSRS Export → PDF.
    if (isOld) { await page.click('#MainContent_' + (VIEWER_OLD_BTN[REPORT] || 'perfbtn')).catch(() => {}); }
    else {
      await page.selectOption('#CboReportFormat', { label: VIEWER_FMT[REPORT] || 'Performence' }).catch(() => {});
      await page.waitForTimeout(500);
      await page.click('#showreport').catch(() => {});
    }
    await page.waitForTimeout(2500);
    try {
      const exportBtn = page.locator('a[title="Export"]').first();
      await exportBtn.waitFor({ state: 'visible', timeout: 20000 });
      await exportBtn.click();
      const pdfLink = page.locator('a[title="PDF"]').first();
      await pdfLink.waitFor({ state: 'visible', timeout: 10000 });
      outName = `report_${REPORT}_${label}_${scopeTag}.pdf`; outPath = path.join(OUT_DIR, outName);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), pdfLink.click()]);
      await dl.saveAs(outPath);
      console.log(`=> DOWNLOADED ${outName} (${fs.statSync(outPath).size} bytes) via viewer-export`);
    } catch (e2) {
      await page.screenshot({ path: path.join(OUT_DIR, 'monthly_after_click.png'), fullPage: true }).catch(() => {});
      console.log(`=> NO DOWNLOAD (viewer-export: ${e2.message.split('\n')[0]}).`);
    }
  } finally { await browser.close(); }
})();
