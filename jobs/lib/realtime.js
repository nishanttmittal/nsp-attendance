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
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.click('a[href="#corporate"]');
  await page.waitForSelector('#TextBox1', { state: 'visible' });
  await page.fill('#TextBox1', s.corporateId);
  await page.fill('#TextBox2', s.username);
  await page.fill('#TextBox3', s.password);
  await Promise.all([
    page.waitForURL('**/Welcome.aspx*', { timeout: 40000 }),
    page.click('#Button1'),
  ]);
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

// Pick "Few Employee" then tick the employee whose label contains the code.
// (employee radio id is unprefixed `optFewEmployee`; checkboxes are styled -> DOM click)
async function selectFewEmployee(page, code) {
  await page.locator('#optFewEmployee').evaluate(r => { if (!r.checked) r.click(); });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const res = await page.evaluate((c) => {
    const boxes = Array.from(document.querySelectorAll('input[id^="chkemployeelist_"]'));
    const labelOf = cb => {
      const l = document.querySelector(`label[for="${cb.id}"]`);
      if (l) return l.innerText.trim();
      return cb.parentElement ? cb.parentElement.innerText.trim() : '';
    };
    const target = boxes.find(cb => labelOf(cb).includes(c));
    if (!target) return { ok: false, count: boxes.length };
    if (!target.checked) target.click();
    return { ok: true, label: labelOf(target) };
  }, code);
  if (!res.ok) throw new Error(`Employee ${code} not found among ${res.count}`);
  return res.label;
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

// Reprocess one day for all employees (recomputes attendance under current rules).
async function reprocessDay(page, ddmmyyyy) {
  await page.goto('https://onlinerealsoft.com/ManualProcess.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await setField(page, '#MainContent_txtdate', ddmmyyyy);
  await setField(page, '#MainContent_txttodate', ddmmyyyy);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
    page.click('#MainContent_cmdShowReport'),
  ]);
  await page.waitForTimeout(2500);
}

module.exports = { SITE_URL, loadSecrets, launch, login, session, readGrid, selectFewEmployee, setField, reprocessDay };
