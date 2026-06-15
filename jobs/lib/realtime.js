// Shared Realtime Biometrics access: bakes in the WSL/Ubuntu-26.04 browser env
// (so callers don't need an env prefix), launches Chromium, and logs in.
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

// --- WSL browser env (Ubuntu 26.04 unsupported by PW 1.60) — LOCAL ONLY ---
// On GitHub Actions (a normal Ubuntu runner) the nativelibs dir doesn't exist and Playwright's
// own browser works, so we skip these overrides there.
const NATIVE_LIBS = path.resolve(__dirname, 'nativelibs');
if (fs.existsSync(NATIVE_LIBS)) {
  process.env.LD_LIBRARY_PATH = [NATIVE_LIBS, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE || 'ubuntu24.04-x64';
}

const SITE_URL = 'https://onlinerealsoft.com/Default.aspx';
// Portal redesign (2026-06-14): login moved to ErpLogin.aspx with a "Corporate ID" tab; the
// corporate fields (TextBox1/2/3) are the same, and it lands on Home.aspx (was Welcome.aspx).
const LOGIN_URL = 'https://onlinerealsoft.com/ErpLogin.aspx';
const SECRETS_FILE = path.resolve(__dirname, '..', 'secrets.json');

function loadSecrets() {
  // env (GitHub Actions secrets) takes precedence; falls back to local secrets.json
  if (process.env.REALTIME_CORP && process.env.REALTIME_USER && process.env.REALTIME_PASS) {
    return { corporateId: process.env.REALTIME_CORP, username: process.env.REALTIME_USER, password: process.env.REALTIME_PASS };
  }
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
}

async function launch() {
  return chromium.launch({ headless: true });
}

async function login(page, s = loadSecrets()) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  // new portal: a "Corporate ID" tab reveals the corporate-login fields. Fall back to the old
  // "#corporate" anchor if we ever hit the previous page again.
  const tab = page.locator('li.nav-item', { hasText: 'Corporate ID' }).first();
  if (await tab.count().catch(() => 0)) await tab.click().catch(() => {});
  else await page.click('a[href="#corporate"]').catch(() => {});
  await page.waitForSelector('#TextBox1', { state: 'visible', timeout: 15000 });
  await page.fill('#TextBox1', s.corporateId);
  await page.fill('#TextBox2', s.username);
  await page.fill('#TextBox3', s.password);
  await Promise.all([
    // lands on Home.aspx now (was Welcome.aspx) — just wait until we leave the login page
    page.waitForURL((u) => !/ErpLogin|Default\.aspx/i.test(u.toString()), { timeout: 40000 }).catch(() => {}),
    page.click('#Button1'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

// Open a logged-in page; returns { browser, context, page }.
async function session() {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await context.newPage();
  await login(page);
  return { browser, context, page };
}

// Read a grid table from the current page into array-of-row-arrays.
async function readGrid(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('table tr'))
      .map(tr => Array.from(tr.querySelectorAll('th,td')).map(c => c.innerText.replace(/\s+/g, ' ').trim()))
      .filter(r => r.some(c => c.length > 0))
  );
}

// V26 portal: the employee list is `LstEmployee_N` checkboxes; each row's text reads
// "name (code)". The list DEFAULTS TO ALL CHECKED — so to target ONE employee we MUST uncheck
// every box first, then check only the target. (The 2026-06-14 mass-insert bug was caused by
// not unchecking the rest.) Returns { label, checkedCount }; callers MUST verify checkedCount===1
// before any write (insert). Was: optFewEmployee radio + chkemployeelist on the old portal.
async function selectFewEmployee(page, code) {
  await page.waitForSelector('input[id^="LstEmployee_"]', { timeout: 30000 }).catch(() => {});
  const res = await page.evaluate((c) => {
    const boxes = Array.from(document.querySelectorAll('input[id^="LstEmployee_"]'));
    const rowText = cb => { const r = cb.closest('tr') || cb.parentElement; return (r && r.innerText ? r.innerText : '').replace(/\s+/g, ' ').trim(); };
    // 1) uncheck ALL (synthetic 'click' fires handlers WITHOUT toggling .checked, so set then fire change)
    boxes.forEach(cb => { if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('click', { bubbles: true })); cb.dispatchEvent(new Event('change', { bubbles: true })); } });
    // 2) check ONLY the target
    const target = boxes.find(cb => rowText(cb).includes(c));
    if (!target) return { ok: false, count: boxes.length };
    target.checked = true; target.dispatchEvent(new Event('click', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
    const checkedCount = boxes.filter(b => b.checked).length;
    return { ok: true, label: rowText(target), checkedCount };
  }, code);
  if (!res.ok) throw new Error(`Employee ${code} not found among ${res.count}`);
  return res;   // { label, checkedCount }
}

// Set a date/time text field by value + events (handles flatpickr/datepicker fields).
async function setField(page, sel, value) {
  await page.locator(sel).evaluate((n, v) => {
    n.value = v;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
    n.blur();
  }, value);
}

// Reprocess a date range for all employees (recomputes attendance under current rules).
async function reprocessRange(page, fromDdmmyyyy, toDdmmyyyy) {
  await page.goto('https://onlinerealsoft.com/ERP_ManualProcess.aspx', { waitUntil: 'domcontentloaded' });   // V26 portal
  await page.waitForTimeout(1500);
  await setField(page, '#txtdate', fromDdmmyyyy);      // V26: was #MainContent_txtdate
  await setField(page, '#txtdateto', toDdmmyyyy);      // V26: was #MainContent_txttodate
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}),
    page.click('#cmdShowReport'),                      // V26: "Process Data" (was #MainContent_cmdShowReport)
  ]);
  await page.waitForTimeout(3000);
}
const reprocessDay = (page, ddmmyyyy) => reprocessRange(page, ddmmyyyy, ddmmyyyy);

// Find a worker's Employee.aspx edit RowId by card number. The whole roster renders on one
// EmployeeList.aspx page (no pagination) — scan the row whose text holds the card, grab its
// Employee.aspx?RowId link. Returns the RowId string, or null if not found. Read-only.
async function findEmployeeRowId(page, card) {
  await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  return await page.evaluate((c) => {
    for (const tr of document.querySelectorAll('tr')) {
      if ((tr.innerText || '').includes(c)) {
        const a = tr.querySelector('a[href*="Employee.aspx?RowId="]');
        if (a) { const m = /RowId=(\d+)/.exec(a.getAttribute('href')); if (m) return m[1]; }
      }
    }
    return null;
  }, String(card));
}

module.exports = { SITE_URL, loadSecrets, launch, login, session, readGrid, selectFewEmployee, setField, reprocessDay, reprocessRange, findEmployeeRowId };
