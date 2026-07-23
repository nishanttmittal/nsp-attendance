// Restore cboisnightshift = "No" on the 4 shift pages (GEN/10H/12H/wir), changing ONLY that field.
// Reads every watched shift field before+after and flags if anything OTHER than night-shift drifts on
// save (SiftDetails saves can silently reset break/time fields — we verify they didn't).
//   DRY_RUN=true (default) reads + would-set, saves NOTHING.  DRY_RUN=false saves + verifies.
const { session } = require('./lib/realtime');
const SHIFTS = [{ key: 'GEN', rowid: 2 }, { key: '10H', rowid: 3 }, { key: '12H', rowid: 4 }, { key: 'wir', rowid: 5 }];
const FIELDS = ['txtsftstarttime', 'txtsiftendtime', 'txtsiftduration', 'cboisnightshift', 'txtchekmin', 'txtmaxearly', 'txtmaxrate', 'chk2', 'cboFWOff', 'DropDownList1'];
const DRY = process.env.DRY_RUN !== 'false';
const readAll = (page) => page.evaluate((FIELDS) => {
  const o = {};
  for (const id of FIELDS) { const n = document.getElementById('MainContent_' + id); o[id] = !n ? '<missing>' : n.tagName === 'SELECT' ? ((n.options[n.selectedIndex] || {}).text || '').trim() : (n.type === 'checkbox' ? String(n.checked) : n.value.trim()); }
  return o;
}, FIELDS);
const killModal = (page) => page.evaluate(() => { document.querySelectorAll('.modal.show,.modal.fade,.modal-backdrop').forEach(e => e.remove()); document.body.classList.remove('modal-open'); }).catch(() => {});
(async () => {
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    for (const s of SHIFTS) {
      const url = 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=' + s.rowid;
      await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
      const before = await readAll(page);
      console.log(`\n[${s.key}] BEFORE: ${JSON.stringify(before)}`);
      if (before.cboisnightshift === 'No') { console.log('  already No — skipping'); continue; }
      await page.selectOption('#MainContent_cboisnightshift', { label: 'No' }).catch(() => {});
      await page.waitForTimeout(400);
      if (DRY) { console.log('  DRY: would set night=No, NOT saved'); continue; }
      await killModal(page);
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
      await page.waitForTimeout(2000);
      await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
      const after = await readAll(page);
      const drift = FIELDS.filter(f => f !== 'cboisnightshift' && String(before[f]) !== String(after[f]));
      console.log(`[${s.key}] AFTER : ${JSON.stringify(after)}`);
      if (after.cboisnightshift !== 'No') console.log('  ❌ night NOT set to No — FAILED');
      else if (drift.length) console.log('  ⚠️ OTHER fields changed: ' + drift.map(f => `${f}: ${before[f]}→${after[f]}`).join(', '));
      else console.log('  ✓ night=No, nothing else changed');
    }
    if (dialogs.length) console.log('\ndialogs:', JSON.stringify(dialogs));
  } finally { await browser.close(); }
})();
