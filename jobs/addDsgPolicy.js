// Create the DSG employee policy on the Realtime portal.
//
// SAFE BY DEFAULT: DRY_RUN=true (default) opens the Add form, fills every field, RE-READS them,
// screenshots, and SAVES NOTHING. DRY_RUN=false clicks Save, then re-opens the policy from the list
// and verifies each field actually persisted.
//   DRY_RUN=true  node addDsgPolicy.js     # rehearse (default)
//   DRY_RUN=false node addDsgPolicy.js     # actually create it
//
// WHY: verified 2026-07-30 that NO DSG policy exists (4 policies only: GEN/10H/12H/amarjeet; the
// list has no pagination and RowIds 6/7/8 are empty). The designer is therefore classified by some
// other shift's policy. Values below are derived from the formula every existing policy obeys:
//   full-day line = shift span − 1:30 − 0:15 grace
//   GEN 8:30→6:45 · 10H 10:30→8:45 · 12H 12:00→10:15 · wir 10:30→8:45   (all verified)
//   DSG span 10:00 → 08:15
// Creating a policy changes NOBODY until a worker is assigned to it — assignment is deliberately NOT
// done here.
const path = require('path');
const { session } = require('./lib/realtime');

const S = '#MainContent_';
const DRY = process.env.DRY_RUN !== 'false';
const OUT = path.join(__dirname, 'apply_output');

// field -> value. Matches the existing policies exactly except the three that track the shift length.
const FIELDS = {
  txtpolicyname: 'DSG',
  txtdurationformakingpresent: '08:15',   // ⭐ full-day line (span 10:00 − 1:30 − 0:15 grace)
  txtmaxworkinghour: '08:15',
  txtmaxworkinghourhalf: '08:14',
  txtmaxabsentsortday: '03:45',           // absent line — same on all policies
  txtlatearrival: '00:15',
  txtearlydeparture: '00:05',
  IgnoreOTSetting: '00:20',
};
// dropdowns: label text to select
const SELECTS = {
  cbosinglepunchonly: 'Fix Time Out',
  cboRequiredpunchinday: 'Multipunch',
  // ALL eight deduction dropdowns OFF — switched off 2026-07-06 so lateness is not docked twice
  // (it is already cut from OT). If any of these is a percentage, the worker is penalised twice.
  cbolateded1: 'None', cbolateded2: 'None', cbolateded3: 'None', cbolateded4: 'None',
  cboEarlyded1: 'None', cboEarlyded2: 'None', cboEarlyded3: 'None', cboEarlyded4: 'None',
  Cbonooflate: '4',
};
const CHECKS = { chkroundclock: true, chkLateactive: false };   // 3 of 4 policies have Round Clock ON

async function setText(page, id, val) {
  const sel = S + id;
  if (!(await page.locator(sel).count())) return '(field missing)';
  // some time inputs are readonly flatpickr — strip it first, as applyGrace does
  await page.locator(sel).evaluate((n, v) => {
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
      const o = [...n.options].find(x => x.text.trim() === l);
      if (o) { n.value = o.value; n.dispatchEvent(new Event('change', { bubbles: true })); }
    }, label).catch(() => {});
  });
  return page.locator(sel).evaluate(n => (n.options[n.selectedIndex] || {}).text || '').catch(() => '?');
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
  const { browser, page } = await session();
  try {
    // 1. GUARD: refuse if a DSG policy already exists — never create a duplicate.
    await page.goto('https://onlinerealsoft.com/EmployeePolicyList.aspx', { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(1500);
    const listed = (await page.locator('table tr').allInnerTexts().catch(() => []))
      .map(t => t.replace(/\s+/g, ' ').trim());
    console.log('Existing policies:');
    listed.filter(Boolean).forEach(t => console.log('   ' + t));
    if (listed.some(t => /^DSG\b/i.test(t))) {
      throw new Error('A DSG policy ALREADY EXISTS — refusing to create a duplicate.');
    }

    // 2. open a blank policy form by clicking Add on the list.
    // NOTE the capital A: the POLICY list uses #MainContent_BtnAdd, the SHIFT list uses
    // #MainContent_Btnadd. Navigating to EmployeePolicy.aspx without a RowId does NOT open a blank
    // form — it renders no fields at all (discovered 2026-07-30, caught by this script's own guard).
    await page.locator(S + 'BtnAdd').click({ timeout: 30000 });
    await page.waitForTimeout(2500);
    if (!(await page.locator(S + 'txtpolicyname').count())) {
      throw new Error('Add-policy form did not open (txtpolicyname absent) — aborting, nothing changed.');
    }

    // 3. fill + immediately re-read every field
    console.log('\nfield'.padEnd(32) + 'wanted'.padEnd(16) + 'reads back as');
    console.log('-'.repeat(70));
    const bad = [];
    for (const [id, v] of Object.entries(FIELDS)) {
      const got = await setText(page, id, v);
      console.log(id.padEnd(32) + String(v).padEnd(16) + got);
      if (String(got).trim() !== v) bad.push(`${id}: wanted "${v}" got "${got}"`);
    }
    for (const [id, v] of Object.entries(SELECTS)) {
      const got = await setSelect(page, id, v);
      console.log(id.padEnd(32) + String(v).padEnd(16) + got);
      if (String(got).trim() !== v) bad.push(`${id}: wanted "${v}" got "${got}"`);
    }
    for (const [id, v] of Object.entries(CHECKS)) {
      const got = await setCheck(page, id, v);
      console.log(id.padEnd(32) + String(v).padEnd(16) + got);
      if (String(got) !== String(v)) bad.push(`${id}: wanted ${v} got ${got}`);
    }
    // NB: this is the form BEFORE Save — named accordingly (it used to be called "…_saved.png",
    // which read as proof of what was stored; the post-save screenshot below is that proof).
    await page.screenshot({ path: path.join(OUT, `dsg_policy_${DRY ? 'dry' : 'prefill'}.png`), fullPage: true }).catch(() => {});

    if (bad.length) {
      console.log('\n⚠️  fields that did not take:');
      bad.forEach(b => console.log('   ' + b));
    }

    if (DRY) {
      console.log('\nDRY RUN — nothing saved. Re-run with DRY_RUN=false to create it.');
      return;
    }
    if (bad.length) throw new Error('REFUSING TO SAVE — some fields did not take (see above).');

    // 4. save
    // The Save control is #MainContent_cmdsave (discovered 2026-07-30). NOT btnSave — and note the
    // page also has a top-level #save which is the OTP "VERIFY OTP" button, so never match on id=save.
    await page.locator(S + 'cmdsave').click({ timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('\nSaved. Verifying from the list…');

    // 5. VERIFY: re-open the list, find the DSG row, OPEN IT, and re-read every field.
    // Until 2026-07-31 this only checked that a DSG row appeared in the list and then reported
    // success — the header claimed every field was verified, which was untrue (Codex round 3).
    // Presence in the list proves the policy was created; it proves nothing about its times.
    await page.goto('https://onlinerealsoft.com/EmployeePolicyList.aspx', { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(1500);
    const rowInfo = await page.locator('table tr').evaluateAll(rows => rows.map((r) => {
      const a = r.querySelector('a[href*="RowId="]');
      const m = a ? String(a.getAttribute('href') || '').match(/RowId=(\d+)/) : null;
      return { text: (r.innerText || '').replace(/\s+/g, ' ').trim(), rowId: m ? m[1] : null };
    }));
    console.log('  policy list now: ' + rowInfo.map(r => r.text).filter(Boolean).join('  |  '));
    const dsgRow = rowInfo.find(r => /^DSG\b/i.test(r.text));
    if (!dsgRow) throw new Error('🚨 SAVED BUT NOT IN THE LIST — treat as NOT created.');
    console.log('  ✅ DSG present: "' + dsgRow.text + '"');

    if (!dsgRow.rowId) {
      console.log('\n⚠️  Could NOT resolve the DSG RowId from the list (the row may use a postback link).');
      console.log('    The policy EXISTS, but its saved field values were NOT verified. Open it by hand.');
      process.exit(2);
    }
    await page.goto('https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=' + dsgRow.rowId, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(2000);
    if (!(await page.locator(S + 'txtpolicyname').count())) {
      console.log('\n⚠️  Re-opened RowId=' + dsgRow.rowId + ' but the form did not render — values NOT verified.');
      process.exit(2);
    }
    console.log('\nRe-read from the SAVED policy (RowId=' + dsgRow.rowId + '):');
    console.log('field'.padEnd(32) + 'wanted'.padEnd(16) + 'saved as');
    console.log('-'.repeat(70));
    const drift = [];
    const cmp = (id, want, got, eq) => {
      console.log(id.padEnd(32) + String(want).padEnd(16) + got);
      if (!eq) drift.push(`${id}: wanted "${want}" saved as "${got}"`);
    };
    for (const [id, v] of Object.entries(FIELDS)) {
      const got = await page.locator(S + id).inputValue().catch(() => '(missing)');
      cmp(id, v, got, String(got).trim() === v);
    }
    for (const [id, v] of Object.entries(SELECTS)) {
      const got = await page.locator(S + id).evaluate(n => (n.options[n.selectedIndex] || {}).text || '').catch(() => '(missing)');
      cmp(id, v, got, String(got).trim() === v);
    }
    for (const [id, v] of Object.entries(CHECKS)) {
      const got = await page.locator(S + id).isChecked().catch(() => '(missing)');
      cmp(id, v, got, String(got) === String(v));
    }
    if (drift.length) {
      console.log('\n🚨 SAVED VALUES DO NOT MATCH — the policy exists but is WRONG. Fix it on the portal:');
      drift.forEach(d => console.log('   ' + d));
      process.exit(3);
    }
    await page.screenshot({ path: path.join(OUT, 'dsg_policy_saved.png'), fullPage: true }).catch(() => {});
    console.log('\n  ✅ every field verified against the saved policy (screenshot: dsg_policy_saved.png).');
  } finally { await browser.close(); }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
