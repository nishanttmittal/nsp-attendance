// Monthly attendance download from the V26 portal (ERP_NewMonthly.aspx).
//   MONTH=0|1|2   (0=current month-to-date, 1=last month, 2=two months ago)
//   SCOPE=all | dept:<DEPARTMENT NAME> | emp:<EMP CODE>
//   REPORT=Button10|summary (default) | Button15|inout | Button8|ot | Button13|late | perfbtn|performance
//   FROM/TO=dd/MM/yyyy optional custom range. DRY=true prepares only.
const path = require('path');
const fs = require('fs');
const { session, selectFewEmployee, setField } = require('./lib/realtime');

const URL = 'https://onlinerealsoft.com/ERP_NewMonthly.aspx';   // V26 (was NewMonthly.aspx)
const OUT_DIR = path.resolve(__dirname, 'downloads');
const MONTH = parseInt(process.env.MONTH || '0', 10);
const SCOPE = process.env.SCOPE || 'all';
const REPORT = process.env.REPORT || 'Button10';
const DRY = process.env.DRY === 'true';

// Direct-download reports → their V26 LinkButton id.
const LINK = { Button10: 'LinkButton21', summary: 'LinkButton21', Button15: 'LinkButton22', inout: 'LinkButton22',
  Btn_MonthlyMusterBookReport: 'LinkButton17', muster: 'LinkButton17', Btn_MonthlyInOutReport: 'LinkButton27' };
// Viewer reports → the CboReportFormat option text (rendered via "Show Report", then SSRS export).
const VIEWER = { perfbtn: 'Performence', performance: 'Performence', Button8: 'OT Summary', ot: 'OT Summary',
  Button13: 'Late Arrival', late: 'Late Arrival' };

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
function monthRange(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
  const to = offset === 0 ? now : lastOfMonth;
  return { from: first, to, label: `${first.getFullYear()}-${pad(first.getMonth() + 1)}` };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800);
    const { from, to, label } = monthRange(MONTH);
    await setField(page, '#txtdate', process.env.FROM || fmt(from));     // V26 ids
    await setField(page, '#txtdateto', process.env.TO || fmt(to));

    let scopeTag = 'all';
    if (SCOPE.startsWith('emp:')) {
      const sel = await selectFewEmployee(page, SCOPE.slice(4));         // V26 LstEmployee picker
      console.log('  picked employee:', sel.label, '(checked:', sel.checkedCount + ')'); scopeTag = 'emp-' + SCOPE.slice(4);
    } else if (SCOPE.startsWith('dept:')) {
      // best-effort: filter the list by department name, then Apply Filter
      const dept = SCOPE.slice(5);
      await setField(page, '#TextBox1', dept).catch(() => {});
      await page.click('#Filter').catch(() => {});
      await page.waitForTimeout(1500);
      scopeTag = 'dept-' + dept.replace(/\s+/g, '_');
    }

    console.log(`Month ${label}  range ${process.env.FROM || fmt(from)}..${process.env.TO || fmt(to)}  scope=${SCOPE}  report=${REPORT}`);
    if (DRY) { console.log('=> DRY: prepared only'); return; }

    let outName = `monthly_${label}_${scopeTag}.xls`;
    let outPath = path.join(OUT_DIR, outName);

    if (LINK[REPORT]) {
      // direct file download
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.click('#' + LINK[REPORT])]);
      await dl.saveAs(outPath);
      console.log(`=> DOWNLOADED ${outName} (${fs.statSync(outPath).size} bytes) suggested="${dl.suggestedFilename()}"`);
      return;
    }

    // viewer report: pick the format, render, then export to PDF
    const fmtName = VIEWER[REPORT] || 'Performence';
    await page.selectOption('#CboReportFormat', { label: fmtName }).catch(async () => {
      await page.selectOption('#CboReportFormat', { value: fmtName }).catch(() => {});
    });
    await page.waitForTimeout(500);
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}), page.click('#showreport')]);
    await page.waitForTimeout(2500);
    try {
      const exportBtn = page.locator('a[title="Export"]').first();
      await exportBtn.waitFor({ state: 'visible', timeout: 20000 });
      await exportBtn.click();
      const pdfLink = page.locator('a[title="PDF"]').first();
      await pdfLink.waitFor({ state: 'visible', timeout: 10000 });
      outName = `report_${REPORT}_${label}_${scopeTag}.pdf`;
      outPath = path.join(OUT_DIR, outName);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), pdfLink.click()]);
      await dl.saveAs(outPath);
      console.log(`=> DOWNLOADED ${outName} (${fs.statSync(outPath).size} bytes) via viewer-export`);
    } catch (e2) {
      await page.screenshot({ path: path.join(OUT_DIR, 'monthly_after_click.png'), fullPage: true }).catch(() => {});
      console.log(`=> NO DOWNLOAD (viewer-export: ${e2.message.split('\n')[0]}). Screenshot saved.`);
    }
  } finally { await browser.close(); }
})();
