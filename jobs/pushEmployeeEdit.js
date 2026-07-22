// Push a worker's profile (name / dept / shift / gender) from the app to the Realtime machine,
// for ONE worker, via the per-employee Employee.aspx form (NEVER the destructive batch
// "Update Employee Master" tool).
//   PE_CARD=<emp code>  [PE_NAME=]  [PE_DEPT=]  [PE_SHIFT=]  [PE_GENDER=Male|Female|Other]  [PE_POLICY=]
//   At least one of PE_NAME/PE_DEPT/PE_SHIFT/PE_GENDER is required.
//   DRY=true (default) fills + screenshots, does NOT save.
//   NB: inputs are PE_-prefixed on purpose — a bare `NAME` collides with an ambient shell/OS env
//   var (e.g. the Windows hostname on WSL) and would silently overwrite the worker's real name.
//
// Two portal traps this guards against (both bit us before):
//   1. The save SILENTLY REVERTS unless Gender is set — so we confirm a gender is present, and
//      if GENDER is passed we set it.
//   2. Dropdown option labels differ in case/spelling from what the app stores (e.g. app "FRAME"
//      vs portal "Frame"). We match options CASE-INSENSITIVELY, use the portal's exact label,
//      then RE-READ after save and FAIL LOUDLY (exit 2) if any requested field didn't stick.
const path = require('path');
const fs = require('fs');
const { session, findEmployeeRowId } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const CARD = process.env.PE_CARD || '';
const NAME = process.env.PE_NAME || '';
const DEPT = process.env.PE_DEPT || '';
const SHIFT = process.env.PE_SHIFT || '';
const GENDER = process.env.PE_GENDER || '';
let POLICY = process.env.PE_POLICY || '';
const DRY = process.env.DRY !== 'false';

function bad(m) { console.error('ERROR: ' + m); process.exit(1); }

// Shifts that have a matching office-time policy on the portal. Others (wir/DSG/LOD) use GEN —
// that's how the live LOADING/LOD daily-wagers are already configured.
const POLICY_FOR_SHIFT = { GEN: 'GEN', '10H': '10H', '12H': '12H' };

// Find the option whose text matches `wanted` case-insensitively and select it by its EXACT
// portal label (so ASP.NET postbacks still fire via Playwright's selectOption).
async function pick(page, sel, wanted) {
  const opts = await page.locator(sel + ' option').evaluateAll(os => os.map(o => o.text.trim()));
  const exact = opts.find(o => o.toLowerCase() === String(wanted).trim().toLowerCase());
  if (!exact) return { ok: false, have: opts };
  await page.selectOption(sel, { label: exact });
  await page.waitForTimeout(400); // let any autopostback settle
  return { ok: true, text: exact };
}
const readSel = (page, sel) => page.locator(sel).evaluate(e => e.options[e.selectedIndex]?.text.trim() || '');
const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// Remove the "Renew Your Cloud Services" modal that intercepts the Save click.
const killModal = (page) => page.evaluate(() => {
  document.querySelectorAll('.modal.show,.modal.fade,.modal-backdrop').forEach(e => e.remove());
  document.body.classList.remove('modal-open');
}).catch(() => {});

(async () => {
  if (!CARD) bad('CARD required');
  if (!NAME && !DEPT && !SHIFT && !GENDER) bad('at least one of NAME/DEPT/SHIFT/GENDER required');
  if (SHIFT && !POLICY) POLICY = POLICY_FOR_SHIFT[SHIFT.trim().toUpperCase()] || 'GEN';
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
      dept: await readSel(page, '#MainContent_cbodeptname'),
      shift: await readSel(page, '#MainContent_cboshiftname'),
      gender: await readSel(page, '#MainContent_CboGender'),
      policy: await readSel(page, '#MainContent_cboofficetimepolicy'),
    };

    const warn = [];
    if (NAME) await page.fill('#MainContent_Txtempname', NAME);
    if (DEPT) { const r = await pick(page, '#MainContent_cbodeptname', DEPT); if (!r.ok) warn.push(`DEPT "${DEPT}" not an option (have: ${r.have.join(', ')})`); }
    if (SHIFT) {
      const r = await pick(page, '#MainContent_cboshiftname', SHIFT); if (!r.ok) warn.push(`SHIFT "${SHIFT}" not an option (have: ${r.have.join(', ')})`);
      const p = await pick(page, '#MainContent_cboofficetimepolicy', POLICY); if (!p.ok) warn.push(`POLICY "${POLICY}" not an option (have: ${p.have.join(', ')})`);
    }
    // Gender: set if passed; ALWAYS ensure one is set or the save reverts silently.
    if (GENDER) { const r = await pick(page, '#MainContent_CboGender', GENDER); if (!r.ok) warn.push(`GENDER "${GENDER}" not an option (have: ${r.have.join(', ')})`); }
    const genderNow = await readSel(page, '#MainContent_CboGender');
    if (!genderNow || /select gender/i.test(genderNow)) bad(`Gender is blank for ${CARD} — the portal would silently discard this save. Pass GENDER=Male|Female|Other.`);

    if (warn.length) console.log('WARN:', JSON.stringify(warn));
    console.log('BEFORE:', JSON.stringify(before));
    console.log('TARGET:', JSON.stringify({ name: NAME || '(unchanged)', dept: DEPT || '(unchanged)', shift: SHIFT || '(unchanged)', gender: GENDER || genderNow, policy: SHIFT ? POLICY : '(unchanged)' }));
    await page.screenshot({ path: path.join(OUT_DIR, `pushedit_${CARD}.png`), fullPage: true });
    if (DRY) { console.log('=> DRY: not saved'); return; }
    if (warn.length) bad('refusing to save with unmatched fields (see WARN) — fix the label and retry');

    await killModal(page);
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
    await page.waitForTimeout(2000);

    // Re-open and VERIFY every requested field stuck.
    const rid2 = await findEmployeeRowId(page, CARD);
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rid2, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const after = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await readSel(page, '#MainContent_cbodeptname'),
      shift: await readSel(page, '#MainContent_cboshiftname'),
      gender: await readSel(page, '#MainContent_CboGender'),
      policy: await readSel(page, '#MainContent_cboofficetimepolicy'),
    };
    const mism = [];
    if (NAME && after.name.trim() !== NAME.trim()) mism.push(`name: got "${after.name}" want "${NAME}"`);
    if (DEPT && !eqCI(after.dept, DEPT)) mism.push(`dept: got "${after.dept}" want "${DEPT}"`);
    if (SHIFT && !eqCI(after.shift, SHIFT)) mism.push(`shift: got "${after.shift}" want "${SHIFT}"`);
    if (GENDER && !eqCI(after.gender, GENDER)) mism.push(`gender: got "${after.gender}" want "${GENDER}"`);
    console.log('AFTER:', JSON.stringify(after));
    if (dialogs.length) console.log('dialogs:', JSON.stringify(dialogs));
    if (mism.length) { console.error('VERIFY FAILED:', JSON.stringify(mism)); process.exit(2); }
    console.log('=> PUSHED + VERIFIED');
  } finally { await browser.close(); }
})();
