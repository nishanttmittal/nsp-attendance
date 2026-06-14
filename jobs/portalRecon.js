// Full read-only recon of the redesigned Realtime portal (one login, all pages our automation
// uses). Dumps nav menu + each page's key controls to downloads/portal_recon.txt. No writes.
const { session } = require('./lib/realtime');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, 'downloads/portal_recon.txt');
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

const TARGETS = [
  'ERP_ManualEntry.aspx', 'ERP_BulkManualPunch.aspx', 'ERP_ManualProcess.aspx',
  'ERP_NewMonthly.aspx', 'ERP_Monthly.aspx', 'Erp_DailyReport.aspx',
  'ERP_DailyAbsent.aspx', 'ERP_DailyPresent.aspx', 'ERP_DailyLate.aspx', 'ERP_AttendanceLog.aspx',
  'ERP_EmployeeList.aspx', 'ERP_Employee.aspx', 'ERP_ChangeShift.aspx', 'ERP_GenrateShift.aspx',
  'ERP_SalaryProcess.aspx', 'ERP_SalaryReport.aspx', 'ERP_ApprovePunch.aspx', 'ERP_ApproveManualPunch.aspx',
  'Home.aspx',
];

async function dump(page, url) {
  const r = await page.goto('https://onlinerealsoft.com/' + url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(1800);
  const status = r ? r.status() : 'ERR';
  if (status === 404 || /resource cannot be found/i.test(await page.title().catch(() => ''))) {
    log(`\n### ${url}  → HTTP ${status} (NOT FOUND)`);
    return;
  }
  const info = await page.evaluate(() => {
    const vis = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0; };
    const texts = Array.from(document.querySelectorAll('input')).filter(i => ['text', 'password', 'tel', 'date', ''].includes(i.type))
      .map(i => `${i.id || i.name}${i.placeholder ? '(' + i.placeholder + ')' : ''}${vis(i) ? '' : '[hidden]'}`);
    const checks = Array.from(document.querySelectorAll('input[type=checkbox]'));
    const chkPattern = checks.length ? checks.slice(0, 2).map(c => c.id || c.name).join(',') + (checks.length > 2 ? ` …(${checks.length} total)` : '') : '';
    const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(r => r.id || r.name);
    const selects = Array.from(document.querySelectorAll('select')).map(s => `${s.id || s.name}(${s.options.length})`);
    const buttons = Array.from(document.querySelectorAll('input[type=submit],input[type=button],button')).filter(vis).map(b => `${b.id || '·'}="${(b.value || b.innerText || '').trim().slice(0, 18)}"`);
    const otp = /send otp|verify otp/i.test(document.body.innerText);
    return { title: document.title, texts, chkPattern, radios, selects, buttons, otp };
  });
  log(`\n### ${url}  → HTTP ${status}  | ${info.title}${info.otp ? '  ⚠️OTP-text-present' : ''}`);
  if (info.texts.length) log('  text/date inputs: ' + info.texts.join(', '));
  if (info.selects.length) log('  selects: ' + info.selects.join(', '));
  if (info.radios.length) log('  radios: ' + info.radios.join(', '));
  if (info.chkPattern) log('  checkboxes: ' + info.chkPattern);
  if (info.buttons.length) log('  buttons: ' + info.buttons.join('  '));
}

(async () => {
  const { browser, page } = await session();
  try {
    // full nav menu (label → href)
    await page.goto('https://onlinerealsoft.com/Home.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const nav = await page.evaluate(() => {
      const seen = new Set(); const out = [];
      for (const a of document.querySelectorAll('a')) {
        const href = (a.getAttribute('href') || '').trim(); const t = (a.innerText || a.title || '').trim();
        if (!/\.aspx/i.test(href) || seen.has(href)) continue; seen.add(href);
        out.push(`${(t || '·').slice(0, 30).padEnd(30)} → ${href.slice(0, 45)}`);
      }
      return out;
    });
    log('===== NAV MENU (' + nav.length + ') =====');
    nav.forEach(l => log('  ' + l));

    log('\n===== PAGE CONTROLS =====');
    for (const u of TARGETS) { try { await dump(page, u); } catch (e) { log(`\n### ${u} → recon error: ${e.message.split('\n')[0]}`); } }
  } finally {
    await browser.close();
    fs.writeFileSync(OUT, lines.join('\n'));
    console.log('\n\nSAVED → ' + OUT);
  }
})();
