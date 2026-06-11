// Onboard a new employee on the Realtime machine: name, card no, dept, shift, gender,
// and set Office-Time-Policy = shift. (Gender is set, so the save isn't blocked.)
//   NAME=  CARDNO=  DEPT=  SHIFT=GEN|10H|12H|wir  GENDER=Male|Female|Other  [PAYCODE=]
//   DRY=true (default) fills + screenshots, does NOT save.
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const { NAME, CARDNO, DEPT, SHIFT, GENDER } = process.env;
const PAYCODE = process.env.PAYCODE || CARDNO;
const DRY = process.env.DRY !== 'false';

function bad(m) { console.error('ERROR: ' + m); process.exit(1); }

(async () => {
  if (!NAME || !CARDNO || !DEPT || !SHIFT || !GENDER) bad('NAME, CARDNO, DEPT, SHIFT, GENDER required');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
    await page.click('#MainContent_BtnAdd'); await page.waitForTimeout(1800);   // -> Employee.aspx?RowId=0

    await page.fill('#MainContent_Txtempname', NAME);
    await page.fill('#MainContent_Txtcardno', CARDNO);
    await page.fill('#MainContent_Txtpaycode', PAYCODE);
    await page.selectOption('#MainContent_CboGender', { label: GENDER }).catch(() => {});
    await page.selectOption('#MainContent_cbodeptname', { label: DEPT }).catch(() => {});
    await page.selectOption('#MainContent_cboshiftname', { label: SHIFT }).catch(() => {});
    await page.selectOption('#MainContent_cboofficetimepolicy', { label: SHIFT }).catch(() => {}); // policy = shift

    const v = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      card: await page.locator('#MainContent_Txtcardno').inputValue(),
      gender: await page.locator('#MainContent_CboGender').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
      dept: await page.locator('#MainContent_cbodeptname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
      shift: await page.locator('#MainContent_cboshiftname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
      policy: await page.locator('#MainContent_cboofficetimepolicy').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
    };
    console.log('Filled:', JSON.stringify(v));
    await page.screenshot({ path: path.join(OUT_DIR, 'onboard_prepared.png'), fullPage: true });

    if (DRY) { console.log('=> DRY: not saved'); return; }
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
    await page.waitForTimeout(1500);
    if (dialogs.length) console.log('save alerts:', JSON.stringify(dialogs));
    console.log('=> SAVED (verify in Employee List)');
  } finally { await browser.close(); }
})();
