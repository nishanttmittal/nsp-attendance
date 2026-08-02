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

// Shifts that have a matching office-time policy on the portal.
// DSG added 2026-07-30 — the DSG policy now EXISTS (RowId 6, full-day line 08:15). Without this the
// map would silently push a DSG worker back onto the GEN policy on any future run.
// LOD added 2026-08-01: the LOD policy now EXISTS (RowId 7, full-day line 09:45) and all 4 LOD daily
// wagers were moved onto it — they had been sitting on GEN (line 06:45), which is why the portal
// reported 13-20 h of phantom OT for them off an 8.5 h basis.
// wir -> 'amarjeet' added the same day, and this one is VERIFIED, not inferred: the only wir worker
// (00000074) reads back {"shift":"wir","policy":"amarjeet"} from the portal, and the policy is
// RowId 5 — the same row settingsGuard watches as policy_wir. A comment used to claim this while
// wir was absent from the map, so wir workers would have been pushed onto GEN.
// An unmapped shift still REFUSES rather than defaulting to GEN — the silent-default failure that
// caused the manual-worker OT bug. (`pick()` also refuses to save an option the portal doesn't have.)
const POLICY_FOR_SHIFT = { GEN: 'GEN', '10H': '10H', '12H': '12H', DSG: 'DSG', LOD: 'LOD', WIR: 'amarjeet' };

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
  if (SHIFT && !POLICY) {
    POLICY = POLICY_FOR_SHIFT[SHIFT.trim().toUpperCase()];
    if (!POLICY) bad(`No office-time policy is mapped for shift "${SHIFT}". Refusing to guess — defaulting to GEN would silently change when this worker counts as late. Pass PE_POLICY=<exact portal policy name>, or add "${SHIFT.trim().toUpperCase()}" to POLICY_FOR_SHIFT once the right policy is confirmed on the portal.`);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    const rowid = await findEmployeeRowId(page, CARD);
    if (!rowid) bad(`worker ${CARD} not found on machine`);
    const editUrl = 'https://onlinerealsoft.com/Employee.aspx?RowId=' + rowid;
    const readAll = async () => ({
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await readSel(page, '#MainContent_cbodeptname'),
      shift: await readSel(page, '#MainContent_cboshiftname'),
      gender: await readSel(page, '#MainContent_CboGender'),
      policy: await readSel(page, '#MainContent_cboofficetimepolicy'),
    });
    // Navigate to the edit form and fill every requested field. Returns the pre-fill snapshot,
    // any unmatched-label warnings, and the gender now selected.
    async function loadAndFill() {
      await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const before = await readAll();
      const warn = [];
      if (NAME) await page.fill('#MainContent_Txtempname', NAME);
      if (DEPT) { const r = await pick(page, '#MainContent_cbodeptname', DEPT); if (!r.ok) warn.push(`DEPT "${DEPT}" not an option (have: ${r.have.join(', ')})`); }
      if (SHIFT) {
        const r = await pick(page, '#MainContent_cboshiftname', SHIFT); if (!r.ok) warn.push(`SHIFT "${SHIFT}" not an option (have: ${r.have.join(', ')})`);
        const p = await pick(page, '#MainContent_cboofficetimepolicy', POLICY); if (!p.ok) warn.push(`POLICY "${POLICY}" not an option (have: ${p.have.join(', ')})`);
      }
      if (GENDER) { const r = await pick(page, '#MainContent_CboGender', GENDER); if (!r.ok) warn.push(`GENDER "${GENDER}" not an option (have: ${r.have.join(', ')})`); }
      const genderNow = await readSel(page, '#MainContent_CboGender');
      return { before, warn, genderNow };
    }
    // Click Save (killing the renewal modal that can intercept it) then re-open + read what persisted.
    async function saveThenRead() {
      await killModal(page);
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
      await page.waitForTimeout(2000);
      const rid2 = await findEmployeeRowId(page, CARD);
      await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rid2, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      return readAll();
    }
    const mismatches = (a) => {
      const m = [];
      if (NAME && a.name.trim() !== NAME.trim()) m.push(`name: got "${a.name}" want "${NAME}"`);
      if (DEPT && !eqCI(a.dept, DEPT)) m.push(`dept: got "${a.dept}" want "${DEPT}"`);
      if (SHIFT && !eqCI(a.shift, SHIFT)) m.push(`shift: got "${a.shift}" want "${SHIFT}"`);
      // The office-time POLICY decides when a worker is marked late — it is half of what this script
      // sets, and it was NOT verified until 2026-07-31. Without it the script could print
      // "PUSHED + VERIFIED" when the shift saved but the policy silently reverted.
      if (SHIFT && POLICY && !eqCI(a.policy, POLICY)) m.push(`policy: got "${a.policy}" want "${POLICY}"`);
      if (GENDER && !eqCI(a.gender, GENDER)) m.push(`gender: got "${a.gender}" want "${GENDER}"`);
      return m;
    };

    // The "Renew Your Cloud Services" modal can swallow the first Save on a cold run (it failed all 3
    // declare pushes on 2026-07-22, yet succeeded on a clean re-run) — so re-fill + re-save once.
    const MAX = 2;
    let lastMism = null;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      const { before, warn, genderNow } = await loadAndFill();
      if (!genderNow || /select gender/i.test(genderNow)) bad(`Gender is blank for ${CARD} — the portal would silently discard this save. Pass GENDER=Male|Female|Other.`);
      if (attempt === 1) {
        if (warn.length) console.log('WARN:', JSON.stringify(warn));
        console.log('BEFORE:', JSON.stringify(before));
        console.log('TARGET:', JSON.stringify({ name: NAME || '(unchanged)', dept: DEPT || '(unchanged)', shift: SHIFT || '(unchanged)', gender: GENDER || genderNow, policy: SHIFT ? POLICY : '(unchanged)' }));
        await page.screenshot({ path: path.join(OUT_DIR, `pushedit_${CARD}.png`), fullPage: true });
        if (DRY) { console.log('=> DRY: not saved'); return; }
        if (warn.length) bad('refusing to save with unmatched fields (see WARN) — fix the label and retry');
      }
      const after = await saveThenRead();
      const mism = mismatches(after);
      if (!mism.length) {
        console.log('AFTER:', JSON.stringify(after));
        if (dialogs.length) console.log('dialogs:', JSON.stringify(dialogs));
        console.log(`=> PUSHED + VERIFIED${attempt > 1 ? ` (took ${attempt} tries)` : ''}`);
        return;
      }
      lastMism = mism;
      console.log(`attempt ${attempt}/${MAX} did not persist: ${JSON.stringify(mism)}`);
    }
    console.error('VERIFY FAILED:', JSON.stringify(lastMism));
    process.exit(2);
  } finally { await browser.close(); }
})();
