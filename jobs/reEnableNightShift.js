// URGENT REVERSAL: re-enable cboisnightshift = "Yes" on the 4 shifts (GEN/10H/12H/wir). ~15 workers
// punch out ~01:30 AM regularly (verified in att_punches July); night-shift ON is what pairs those
// past-midnight punches so their OT counts. Changes ONLY that field; verifies nothing else drifts.
const { session } = require('./lib/realtime');
const SHIFTS = [{ key: 'GEN', rowid: 2 }, { key: '10H', rowid: 3 }, { key: '12H', rowid: 4 }, { key: 'wir', rowid: 5 }];
const FIELDS = ['txtsftstarttime', 'txtsiftendtime', 'txtsiftduration', 'cboisnightshift', 'txtchekmin', 'txtmaxearly', 'txtmaxrate', 'chk2', 'cboFWOff', 'DropDownList1'];
const readAll = (page) => page.evaluate((FIELDS) => {
  const o = {}; for (const id of FIELDS) { const n = document.getElementById('MainContent_' + id); o[id] = !n ? '<m>' : n.tagName === 'SELECT' ? ((n.options[n.selectedIndex] || {}).text || '').trim() : (n.type === 'checkbox' ? String(n.checked) : n.value.trim()); } return o;
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
      if (before.cboisnightshift === 'Yes') { console.log(`[${s.key}] already Yes — skip`); continue; }
      await page.selectOption('#MainContent_cboisnightshift', { label: 'Yes' }).catch(() => {});
      await page.waitForTimeout(400);
      await killModal(page);
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
      await page.waitForTimeout(2000);
      await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
      const after = await readAll(page);
      const drift = FIELDS.filter(f => f !== 'cboisnightshift' && String(before[f]) !== String(after[f]));
      if (after.cboisnightshift !== 'Yes') console.log(`[${s.key}] ❌ NOT set to Yes`);
      else if (drift.length) console.log(`[${s.key}] ⚠️ other fields moved: ${drift.map(f => `${f}:${before[f]}→${after[f]}`).join(', ')}`);
      else console.log(`[${s.key}] ✓ night=Yes restored, nothing else changed`);
    }
    if (dialogs.length) console.log('dialogs:', JSON.stringify(dialogs));
  } finally { await browser.close(); }
})();
