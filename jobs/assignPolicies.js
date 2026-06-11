// Sets each employee's Office Time Policy = their Shift (GEN/10H/12H/wir).
// PILOT=true (default): change only the FIRST mismatched employee, then verify the whole
// record round-tripped unchanged. PILOT=false: process everyone needing a change.
const { session } = require('./lib/realtime');

const PILOT = process.env.PILOT !== 'false';
const VALID = ['GEN', '10H', '12H', 'wir'];

const readEmp = (page) => page.evaluate(() => {
  const sel = id => { const e = document.getElementById(id); return e ? e.options[e.selectedIndex]?.text.trim() : null; };
  const val = id => { const e = document.getElementById(id); return e ? e.value : null; };
  return {
    name: val('MainContent_Txtempname') || '',
    code: val('MainContent_Txtpaycode') || '',
    dept: sel('MainContent_cbodeptname'), shift: sel('MainContent_cboshiftname'),
    policy: sel('MainContent_cboofficetimepolicy'),
  };
});

(async () => {
  const { browser, page } = await session();
  const log = [];
  try {
    // distinct employee RowIds
    await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const rowIds = await page.evaluate(() => [...new Set(
      Array.from(document.querySelectorAll('a'))
        .map(a => (a.getAttribute('href') || '').match(/Employee\.aspx\?RowId=(\d+)/i))
        .filter(Boolean).map(m => m[1]))]);
    log.push(`employees: ${rowIds.length}`);

    const gotoEmp = async (id) => {
      for (let a = 0; a < 3; a++) {
        try { await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }); return true; }
        catch (e) { if (a === 2) throw e; await page.waitForTimeout(1500); }
      }
    };

    let changed = 0, scanned = 0, errors = 0;
    const changes = [];
    for (const id of rowIds) {
     try {
      await gotoEmp(id);
      await page.waitForTimeout(700);
      const before = await readEmp(page);
      scanned++;
      if (!VALID.includes(before.shift) || before.policy === before.shift) continue; // already correct or unknown shift

      await page.selectOption('#MainContent_cboofficetimepolicy', { label: before.shift }).catch(() => {});
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
        page.click('#MainContent_cmdsave'),
      ]);
      await page.waitForTimeout(1200);

      // verify round-trip
      await gotoEmp(id);
      await page.waitForTimeout(700);
      const after = await readEmp(page);
      const ok = after.policy === before.shift && after.name === before.name && after.shift === before.shift && after.dept === before.dept;
      changed++;
      changes.push(`#${id} ${before.name} [${before.shift}] policy ${before.policy}→${after.policy}  ${ok ? 'OK' : 'CHECK: name/dept/shift changed!'}`);
      log.push('  ' + changes[changes.length - 1]);

      if (PILOT) { log.push('PILOT: stopped after first change.'); break; }
     } catch (e) { errors++; log.push(`  #${id} ERROR: ${e.message.split('\n')[0]}`); }
    }
    log.push('', `scanned ${scanned}, changed ${changed}, errors ${errors}`);
  } catch (e) { log.push('ERROR: ' + e.message); }
  finally { await browser.close(); }
  console.log(log.join('\n'));
})();
