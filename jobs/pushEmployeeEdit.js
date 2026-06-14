// Push a name/dept correction made in the app to the Realtime machine, for ONE worker.
//   CARD=<emp code>   NAME=<new name>   DEPT=<new dept label>   (NAME and/or DEPT, at least one)
//   DRY=true (default) fills + screenshots, does NOT save.
// Uses the per-employee Employee.aspx form (Txtempname / cbodeptname + cmdsave) — NEVER the
// destructive batch "Update Employee Master" tool. Gender is already set on existing workers.
const path = require('path');
const fs = require('fs');
const { session, findEmployeeRowId } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const { CARD, NAME, DEPT } = process.env;
const DRY = process.env.DRY !== 'false';

function bad(m) { console.error('ERROR: ' + m); process.exit(1); }

(async () => {
  if (!CARD) bad('CARD required');
  if (!NAME && !DEPT) bad('NAME and/or DEPT required');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    const rowid = await findEmployeeRowId(page, CARD);
    if (!rowid) bad(`worker ${CARD} not found on machine`);
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rowid, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const before = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await page.locator('#MainContent_cbodeptname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
    };
    if (NAME) await page.fill('#MainContent_Txtempname', NAME);
    if (DEPT) await page.selectOption('#MainContent_cbodeptname', { label: DEPT }).catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, `pushedit_${CARD}.png`), fullPage: true });
    console.log('BEFORE:', JSON.stringify(before), ' TARGET name=', NAME || '(unchanged)', 'dept=', DEPT || '(unchanged)');
    if (DRY) { console.log('=> DRY: not saved'); return; }
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
    await page.waitForTimeout(2000);
    // reopen + verify
    const rid2 = await findEmployeeRowId(page, CARD);
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rid2, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const after = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await page.locator('#MainContent_cbodeptname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
    };
    const ok = (!NAME || after.name.trim() === NAME.trim()) && (!DEPT || new RegExp(DEPT, 'i').test(after.dept));
    console.log('AFTER:', JSON.stringify(after), ' verified:', ok ? 'OK' : 'MISMATCH');
    if (dialogs.length) console.log('dialogs:', JSON.stringify(dialogs));
    if (!ok) process.exit(2);
    console.log('=> PUSHED');
  } finally { await browser.close(); }
})();
