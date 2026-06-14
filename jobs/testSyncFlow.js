// Step-2 dry/live test of the app<->machine sync flow on a THROWAWAY test worker ONLY.
// Operates exclusively on CARD=99999001 (dept DEMO). Proves: create -> find by card ->
// push name/dept edit -> archive history -> delete. Real writes, but only on the test card.
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const CARD = process.env.CARD || '99999001';
const SHOT = (page, n) => page.screenshot({ path: path.join(OUT_DIR, `sync_${n}.png`), fullPage: true });
const log = (...a) => console.log(...a);

// Find a worker's edit-page RowId by card number on EmployeeList.aspx (read-only scan).
async function findRowIdByCard(page, card) {
  await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // the whole roster renders on one page (~94 rows) — scan it directly, no search box.
  return await page.evaluate((c) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const tr of rows) {
      if ((tr.innerText || '').includes(c)) {
        const a = tr.querySelector('a[href*="Employee.aspx?RowId="]');
        if (a) { const m = /RowId=(\d+)/.exec(a.getAttribute('href')); if (m) return m[1]; }
      }
    }
    return null;
  }, card);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    // 0) make sure it doesn't already exist from a prior run
    let rowid = await findRowIdByCard(page, CARD);
    log('pre-existing rowid for', CARD, '=>', rowid);

    // 1) CREATE the test worker
    if (!rowid) {
      await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000);
      await page.click('#MainContent_BtnAdd'); await page.waitForTimeout(1800);
      await page.fill('#MainContent_Txtempname', 'ZZ TEST');
      await page.fill('#MainContent_Txtcardno', CARD);
      await page.fill('#MainContent_Txtpaycode', CARD).catch(() => {});
      await page.selectOption('#MainContent_CboGender', { label: 'Male' }).catch(() => {});
      await page.selectOption('#MainContent_cbodeptname', { label: 'DEMO' }).catch(() => {});
      await page.selectOption('#MainContent_cboshiftname', { label: 'GEN' }).catch(() => {});
      await page.selectOption('#MainContent_cboofficetimepolicy', { label: 'GEN' }).catch(() => {});
      await SHOT(page, '1_create_filled');
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
      await page.waitForTimeout(2000);
      log('create dialogs:', JSON.stringify(dialogs));
      rowid = await findRowIdByCard(page, CARD);
    }
    log('STEP1 created. rowid =>', rowid);
    if (!rowid) throw new Error('could not find test worker after create — aborting (no delete attempted)');

    // 2) PUSH a name/dept edit (rename + move to FITTING) and SAVE
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rowid, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
    const before = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await page.locator('#MainContent_cbodeptname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
    };
    await page.fill('#MainContent_Txtempname', 'ZZ TEST EDITED');
    await page.selectOption('#MainContent_cbodeptname', { label: 'FITTING' }).catch(() => {});
    await SHOT(page, '2_edit_filled');
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
    await page.waitForTimeout(2000);
    // reopen to verify it stuck
    const rid2 = await findRowIdByCard(page, CARD);
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rid2, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
    const after = {
      name: await page.locator('#MainContent_Txtempname').inputValue(),
      dept: await page.locator('#MainContent_cbodeptname').evaluate(e => e.options[e.selectedIndex]?.text.trim()),
    };
    log('STEP2 edit  BEFORE:', JSON.stringify(before), ' AFTER:', JSON.stringify(after));

    // 3) ARCHIVE (must succeed before any delete). New worker => empty history, but proves the gate.
    const archive = { card: CARD, rowid: rid2, name: after.name, dept: after.dept, archivedAt: new Date().toISOString(), punchHistory: [], note: 'test archive (new worker, no punches)' };
    const archiveFile = path.join(OUT_DIR, `archive_${CARD}.json`);
    fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));
    const archiveOK = fs.existsSync(archiveFile) && fs.statSync(archiveFile).size > 0;
    log('STEP3 archive saved =>', archiveFile, 'ok:', archiveOK);
    if (!archiveOK) throw new Error('archive failed — DELETE ABORTED (this is the safety gate)');

    // 4) DELETE the test worker
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rid2, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
    await SHOT(page, '4_before_delete');
    const delDialogs0 = dialogs.length;
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_BtnDeleteUser')]);
    await page.waitForTimeout(2500);
    log('delete confirm dialog(s):', JSON.stringify(dialogs.slice(delDialogs0)));
    const gone = await findRowIdByCard(page, CARD);
    await SHOT(page, '5_after_delete');
    log('STEP4 delete done. card still present? rowid =>', gone, gone ? 'STILL THERE (FAIL)' : 'GONE (OK)');

    log('\nSUMMARY:',
      '\n  create:', rowid ? 'OK' : 'FAIL',
      '\n  push name/dept:', (after.name === 'ZZ TEST EDITED' && /FIT/i.test(after.dept)) ? 'OK' : 'CHECK',
      '\n  archive-before-delete gate:', archiveOK ? 'OK' : 'FAIL',
      '\n  delete:', gone ? 'FAIL' : 'OK');
  } finally { await browser.close(); }
})();
