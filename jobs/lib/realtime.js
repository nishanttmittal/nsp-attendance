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

// The portal's account-renewal nag (<div id="accexp" class="modal fade show">, appeared
// ~2026-07-22) covers EVERY page and intercepts all clicks — it silently broke every portal
// job for 3 days (att_attendance froze at 21 Jul, salaries stopped accruing on screen).
// Remove exactly THIS modal (never other dialogs) as soon as it appears, and keep removing
// it after ASP.NET postbacks re-insert it. Registered as an init script so every navigation
// of the page is covered, whichever job is running.
function zapRenewalModal() {
  const zap = () => {
    const m = document.getElementById('accexp');
    if (!m) return;
    m.remove();
    document.querySelectorAll('.modal-backdrop').forEach(e => e.remove());
    if (document.body) { document.body.classList.remove('modal-open'); document.body.style.overflow = ''; }
  };
  zap();
  setInterval(zap, 400);
  document.addEventListener('DOMContentLoaded', zap);
}

async function login(page, s = loadSecrets()) {
  await page.addInitScript(zapRenewalModal);   // renewal-nag killer rides along on every page load
  // The vendor flip-flops between the OLD portal (Default.aspx + a[href="#corporate"] →
  // Welcome.aspx) and the V26 portal (ErpLogin.aspx + a "Corporate ID" nav-tab → Home.aspx).
  // Both use the same TextBox1/2/3 + Button1. Detect whichever is live so we survive the flips.
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });   // SITE_URL = Default.aspx
  await page.waitForTimeout(1000);
  if (await page.locator('a[href="#corporate"]').count().catch(() => 0)) {
    await page.click('a[href="#corporate"]').catch(() => {});      // OLD portal
  } else {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});   // V26 portal
    await page.waitForTimeout(800);
    const tab = page.locator('li.nav-item', { hasText: 'Corporate ID' }).first();
    if (await tab.count().catch(() => 0)) await tab.click().catch(() => {});
  }
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
  const isV26 = await page.locator('input[id^="LstEmployee_"]').count().catch(() => 0);
  if (isV26) {
    // V26: the LstEmployee list DEFAULTS ALL-CHECKED → uncheck everything, then check only the target.
    const res = await page.evaluate((c) => {
      const boxes = Array.from(document.querySelectorAll('input[id^="LstEmployee_"]'));
      const rowText = cb => { const r = cb.closest('tr') || cb.parentElement; return (r && r.innerText ? r.innerText : '').replace(/\s+/g, ' ').trim(); };
      boxes.forEach(cb => { if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('click', { bubbles: true })); cb.dispatchEvent(new Event('change', { bubbles: true })); } });
      const target = boxes.find(cb => rowText(cb).includes(c));
      if (!target) return { ok: false, count: boxes.length };
      target.checked = true; target.dispatchEvent(new Event('click', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, label: rowText(target), checkedCount: boxes.filter(b => b.checked).length };
    }, code);
    if (!res.ok) throw new Error(`Employee ${code} not found among ${res.count}`);
    return res;
  }
  // OLD portal: "Few Employee" radio (AutoPostBack loads the checkbox list), then tick the one whose label has the code.
  const clickRadio = () => page.locator('#optFewEmployee').evaluate(r => { if (!r.checked) r.click(); }).catch(() => {});
  const waitList = () => page.waitForSelector('input[id^="chkemployeelist_"]', { timeout: 30000 }).then(() => true).catch(() => false);
  await clickRadio();
  if (!(await waitList())) { await clickRadio(); await waitList(); }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  const res = await page.evaluate((c) => {
    const boxes = Array.from(document.querySelectorAll('input[id^="chkemployeelist_"]'));
    const labelOf = cb => { const l = document.querySelector(`label[for="${cb.id}"]`); return (l ? l.innerText : (cb.parentElement ? cb.parentElement.innerText : '')).trim(); };
    const target = boxes.find(cb => labelOf(cb).includes(c));
    if (!target) return { ok: false, count: boxes.length };
    if (!target.checked) target.click();
    return { ok: true, label: labelOf(target), checkedCount: boxes.filter(b => b.checked).length };
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

// Reprocess a date range for all employees (recomputes attendance). Works on EITHER portal.
async function reprocessRange(page, fromDdmmyyyy, toDdmmyyyy) {
  await page.goto('https://onlinerealsoft.com/ManualProcess.aspx', { waitUntil: 'domcontentloaded' });   // OLD portal
  await page.waitForTimeout(1300);
  const isOld = await page.locator('#MainContent_txtdate').count().catch(() => 0);
  if (!isOld) { await page.goto('https://onlinerealsoft.com/ERP_ManualProcess.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); }
  const dFrom = isOld ? '#MainContent_txtdate' : '#txtdate';
  const dTo = isOld ? '#MainContent_txttodate' : '#txtdateto';
  const btn = isOld ? '#MainContent_cmdShowReport' : '#cmdShowReport';   // "Process Data"
  await setField(page, dFrom, fromDdmmyyyy);
  await setField(page, dTo, toDdmmyyyy);
  await Promise.all([page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}), page.click(btn)]);
  await page.waitForTimeout(3000);
}
const reprocessDay = (page, ddmmyyyy) => reprocessRange(page, ddmmyyyy, ddmmyyyy);

// Download a monthly report, working on EITHER portal (the vendor flip-flops old<->V26).
// kind: 'summary' (Monthly Summary In Excel) | 'inout' (In_OUT IN .Excel Format).
// Detects which portal is live, sets the dates, clicks the right control, returns the Download.
async function downloadMonthly(page, fromDdmmyyyy, toDdmmyyyy, kind = 'summary') {
  await page.goto('https://onlinerealsoft.com/NewMonthly.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1300);
  const isOld = await page.locator('#MainContent_txtdate').count().catch(() => 0);
  let dFrom, dTo, btn;
  if (isOld) {                                   // OLD portal
    if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
    dFrom = '#MainContent_txtdate'; dTo = '#MainContent_txttodate';
    btn = kind === 'inout' ? '#MainContent_Button15' : '#MainContent_Button10';
  } else {                                       // V26 portal
    await page.goto('https://onlinerealsoft.com/ERP_NewMonthly.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    dFrom = '#txtdate'; dTo = '#txtdateto';
    btn = kind === 'inout' ? '#LinkButton22' : '#LinkButton21';
  }
  await setField(page, dFrom, fromDdmmyyyy);
  await setField(page, dTo, toDdmmyyyy);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(btn)]);
  return dl;
}

// Find a worker's Employee.aspx edit RowId by card number. The whole roster renders on one
// EmployeeList.aspx page (no pagination) — scan the row whose text holds the card, grab its
// Employee.aspx?RowId link. Returns the RowId string, or null if not found. Read-only.
// Returns the portal RowId for a card number, or null if that worker genuinely is not listed.
// THROWS if the list did not render — those are different facts and callers acted on them as if
// they were the same. On 2026-08-02 EmployeeList.aspx returned ZERO rows for several minutes and
// pushEmployeeEdit reported "worker 00000051 not found on machine", which reads as "this person
// isn't on the biometric machine" when the truth was "the portal did not answer". Same fixed-sleep
// fragility that let the settings guard capture an empty page over its own baseline.
async function findEmployeeRowId(page, card) {
  await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'networkidle', timeout: 120000 });
  await page.locator('a[href*="Employee.aspx?RowId="]').first()
    .waitFor({ state: 'attached', timeout: 45000 }).catch(() => {});
  const listed = await page.locator('a[href*="Employee.aspx?RowId="]').count();
  if (!listed) throw new Error('EmployeeList.aspx rendered NO employee rows — the portal did not answer. This is NOT "worker not found"; retry rather than concluding anything about this worker.');
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

module.exports = { SITE_URL, loadSecrets, launch, login, session, readGrid, selectFewEmployee, setField, reprocessDay, reprocessRange, findEmployeeRowId, downloadMonthly };
