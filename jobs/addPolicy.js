// Create an office-time POLICY on the Realtime portal — generic version.
//
//   POLICY=LOD node jobs/addPolicy.js              # rehearse (DRY_RUN defaults to true)
//   POLICY=LOD DRY_RUN=false node jobs/addPolicy.js   # actually create it
//
// SAFE BY DEFAULT: DRY_RUN=true opens the Add form, fills every field, RE-READS them, screenshots,
// and SAVES NOTHING. DRY_RUN=false clicks Save, then RE-OPENS the saved policy by its RowId and
// re-reads every field, exiting non-zero if anything drifted or could not be verified.
//
// WHY GENERIC: this replaces addDsgPolicy.js, which was a one-policy script. A second near-copy for
// LOD would be the same duplication that caused six of eight Codex findings in the payroll engines.
//
// THE HOUSE FORMULA — verified against all five existing policies on 2026-08-01:
//     full-day line = shift span − 1:30 lunch − 0:15 grace   (i.e. span − 1:45)
//   GEN  span 08:30 → 06:45      10H span 10:30 → 08:45      12H span 12:00 → 10:15
//   wir  span 10:30 → 08:45      DSG span 10:00 → 08:15      LOD span 11:30 → 09:45
// Every other field is identical across policies except chkroundclock (false on GEN only).
//
// Creating a policy changes NOBODY until a worker is assigned to it. Assignment is deliberately NOT
// done here — use pushEmployeeEdit.js with an explicit PE_POLICY.
const path = require('path');
const { session } = require('./lib/realtime');

const S = '#MainContent_';
const DRY = process.env.DRY_RUN !== 'false';
const OUT = path.join(__dirname, 'apply_output');
const NAME = (process.env.POLICY || '').trim();

// full-day line per policy. Add a row here rather than writing another script.
const LINE = { LOD: '09:45', DSG: '08:15', GEN: '06:45', '10H': '08:45', '12H': '10:15', wir: '08:45' };
// Round Clock is ON everywhere except GEN (checked against the live baseline).
const ROUND_CLOCK = { GEN: false };

if (!NAME) { console.error('ERROR: set POLICY=<name>, e.g. POLICY=LOD'); process.exit(1); }
if (!LINE[NAME]) { console.error(`ERROR: no full-day line known for "${NAME}". Add it to LINE using span − 1:45 — do not guess.`); process.exit(1); }

const full = LINE[NAME];
const minusOneMinute = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m - 1;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};

const FIELDS = {
  txtpolicyname: NAME,
  txtdurationformakingpresent: full,          // ⭐ the full-day line
  txtmaxworkinghour: full,
  txtmaxworkinghourhalf: minusOneMinute(full),
  txtmaxabsentsortday: '03:45',               // absent line — identical on all policies
  txtlatearrival: '00:15',
  txtearlydeparture: '00:05',
  IgnoreOTSetting: '00:20',
  // late/early bands: irrelevant while every deduction dropdown is None, but matched to the house
  // pattern (GEN/10H/12H/wir all use 00:30) so the settings guard sees no odd outlier.
  txtlate1: '00:30', txtlate2: '00:30', txtlate3: '00:30', txtlate4: '00:30',
  txtEalry1: '00:30', txtEalry2: '00:30', txtEalry3: '00:30', txtEalry4: '00:30',
};
const SELECTS = {
  cbosinglepunchonly: 'Fix Time Out',
  cboRequiredpunchinday: 'Multipunch',
  // ALL eight deduction dropdowns OFF — lateness is already cut from OT; a percentage here would
  // penalise the worker twice (switched off 2026-07-06).
  cbolateded1: 'None', cbolateded2: 'None', cbolateded3: 'None', cbolateded4: 'None',
  cboEarlyded1: 'None', cboEarlyded2: 'None', cboEarlyded3: 'None', cboEarlyded4: 'None',
  Cbonooflate: '4',
};
const CHECKS = { chkroundclock: ROUND_CLOCK[NAME] !== false, chkLateactive: false };

async function setText(page, id, val) {
  const sel = S + id;
  if (!(await page.locator(sel).count())) return '(field missing)';
  await page.locator(sel).evaluate((n, v) => {      // some time inputs are readonly flatpickr
    n.removeAttribute('readonly');
    n.value = v;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
  }, val).catch(() => {});
  return page.locator(sel).inputValue().catch(() => '?');
}
async function setSelect(page, id, label) {
  const sel = S + id;
  if (!(await page.locator(sel).count())) return '(field missing)';
  await page.selectOption(sel, { label }).catch(async () => {
    await page.locator(sel).evaluate((n, l) => {
      const o = [...n.options].find((x) => x.text.trim() === l);
      if (o) { n.value = o.value; n.dispatchEvent(new Event('change', { bubbles: true })); }
    }, label).catch(() => {});
  });
  return page.locator(sel).evaluate((n) => (n.options[n.selectedIndex] || {}).text || '').catch(() => '?');
}
async function setCheck(page, id, want) {
  const sel = S + id;
  if (!(await page.locator(sel).count())) return '(field missing)';
  const is = await page.locator(sel).isChecked().catch(() => null);
  if (is !== want) await page.locator(sel).setChecked(want).catch(() => {});
  return String(await page.locator(sel).isChecked().catch(() => '?'));
}

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  console.log(`Policy "${NAME}" — full-day line ${full} (half ${FIELDS.txtmaxworkinghourhalf}), Round Clock ${CHECKS.chkroundclock}`);
  const { browser, page } = await session();
  try {
    // 1. GUARD: never create a duplicate.
    await page.goto('https://onlinerealsoft.com/EmployeePolicyList.aspx', { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(1500);
    const listed = (await page.locator('table tr').allInnerTexts().catch(() => []))
      .map((t) => t.replace(/\s+/g, ' ').trim());
    console.log('\nExisting policies:');
    listed.filter(Boolean).forEach((t) => console.log('   ' + t));
    if (listed.some((t) => new RegExp('^' + NAME + '\\b', 'i').test(t)))
      throw new Error(`A "${NAME}" policy ALREADY EXISTS — refusing to create a duplicate.`);

    // 2. open a blank form. NOTE the capital A: the POLICY list uses #MainContent_BtnAdd, the SHIFT
    // list uses #MainContent_Btnadd. Navigating to EmployeePolicy.aspx with no RowId renders nothing.
    await page.locator(S + 'BtnAdd').click({ timeout: 30000 });
    await page.waitForTimeout(2500);
    if (!(await page.locator(S + 'txtpolicyname').count()))
      throw new Error('Add-policy form did not open (txtpolicyname absent) — aborting, nothing changed.');

    // 3. fill + immediately re-read every field
    console.log('\nfield'.padEnd(32) + 'wanted'.padEnd(16) + 'reads back as');
    console.log('-'.repeat(70));
    const bad = [];
    const step = async (id, v, fn, eq) => {
      const got = await fn();
      console.log(id.padEnd(32) + String(v).padEnd(16) + got);
      if (!eq(got)) bad.push(`${id}: wanted "${v}" got "${got}"`);
    };
    for (const [id, v] of Object.entries(FIELDS)) await step(id, v, () => setText(page, id, v), (g) => String(g).trim() === v);
    for (const [id, v] of Object.entries(SELECTS)) await step(id, v, () => setSelect(page, id, v), (g) => String(g).trim() === v);
    for (const [id, v] of Object.entries(CHECKS)) await step(id, v, () => setCheck(page, id, v), (g) => String(g) === String(v));
    await page.screenshot({ path: path.join(OUT, `policy_${NAME}_${DRY ? 'dry' : 'prefill'}.png`), fullPage: true }).catch(() => {});

    if (bad.length) { console.log('\n⚠️  fields that did not take:'); bad.forEach((b) => console.log('   ' + b)); }
    if (DRY) { console.log('\nDRY RUN — nothing saved. Re-run with DRY_RUN=false to create it.'); return; }
    if (bad.length) throw new Error('REFUSING TO SAVE — some fields did not take (see above).');

    // 4. save. Save is #MainContent_cmdsave — NOT btnSave, and never match id=save (that is the OTP
    // "VERIFY OTP" button).
    await page.locator(S + 'cmdsave').click({ timeout: 30000 });
    await page.waitForTimeout(3000);

    // 5. VERIFY by RE-OPENING the saved row — presence in the list proves creation, not correctness.
    await page.goto('https://onlinerealsoft.com/EmployeePolicyList.aspx', { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator('table tr').evaluateAll((rs) => rs.map((r) => {
      const a = r.querySelector('a[href*="RowId="]');
      const m = a ? String(a.getAttribute('href') || '').match(/RowId=(\d+)/) : null;
      return { text: (r.innerText || '').replace(/\s+/g, ' ').trim(), rowId: m ? m[1] : null };
    }));
    console.log('\n  policy list now: ' + rows.map((r) => r.text).filter(Boolean).join('  |  '));
    const row = rows.find((r) => new RegExp('^' + NAME + '\\b', 'i').test(r.text));
    if (!row) throw new Error('🚨 SAVED BUT NOT IN THE LIST — treat as NOT created.');
    console.log(`  ✅ ${NAME} present: "${row.text}"`);
    if (!row.rowId) { console.log('\n⚠️  Could not resolve its RowId — policy EXISTS but its values were NOT verified. Open it by hand.'); process.exit(2); }

    await page.goto('https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=' + row.rowId, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(2000);
    if (!(await page.locator(S + 'txtpolicyname').count())) { console.log(`\n⚠️  Re-opened RowId=${row.rowId} but the form did not render — values NOT verified.`); process.exit(2); }

    console.log(`\nRe-read from the SAVED policy (RowId=${row.rowId}):`);
    console.log('field'.padEnd(32) + 'wanted'.padEnd(16) + 'saved as');
    console.log('-'.repeat(70));
    const drift = [];
    const cmp = (id, want, got, eq) => { console.log(id.padEnd(32) + String(want).padEnd(16) + got); if (!eq) drift.push(`${id}: wanted "${want}" saved as "${got}"`); };
    for (const [id, v] of Object.entries(FIELDS)) { const g = await page.locator(S + id).inputValue().catch(() => '(missing)'); cmp(id, v, g, String(g).trim() === v); }
    for (const [id, v] of Object.entries(SELECTS)) { const g = await page.locator(S + id).evaluate((n) => (n.options[n.selectedIndex] || {}).text || '').catch(() => '(missing)'); cmp(id, v, g, String(g).trim() === v); }
    for (const [id, v] of Object.entries(CHECKS)) { const g = await page.locator(S + id).isChecked().catch(() => '(missing)'); cmp(id, v, g, String(g) === String(v)); }
    if (drift.length) { console.log('\n🚨 SAVED VALUES DO NOT MATCH — the policy exists but is WRONG. Fix it on the portal:'); drift.forEach((d) => console.log('   ' + d)); process.exit(3); }
    await page.screenshot({ path: path.join(OUT, `policy_${NAME}_saved.png`), fullPage: true }).catch(() => {});
    console.log(`\n  ✅ every field verified against the saved policy (screenshot: policy_${NAME}_saved.png).`);
    console.log(`  ℹ️  This changes NOBODY until a worker is assigned. Assign with:`);
    console.log(`      PE_CARD=<code> PE_SHIFT=${NAME} PE_POLICY=${NAME} DRY=false node jobs/pushEmployeeEdit.js`);
  } finally { await browser.close(); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
