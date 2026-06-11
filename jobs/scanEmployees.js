// Read-only scan: every employee's shift / gender / policy. Outputs JSON so we know
// who needs a policy change (shift in 10H/12H/wir & policy=GEN) and whose gender is unset.
const fs = require('fs');
const { session } = require('./lib/realtime');

const readEmp = (page) => page.evaluate(() => {
  const sel = id => { const e = document.getElementById(id); return e ? e.options[e.selectedIndex]?.text.trim() : null; };
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  return {
    name: val('MainContent_Txtempname'), code: val('MainContent_Txtcardno'),
    shift: sel('MainContent_cboshiftname'), policy: sel('MainContent_cboofficetimepolicy'),
    gender: sel('MainContent_CboGender'),
  };
});

(async () => {
  const { browser, page } = await session();
  const gotoEmp = async (id) => { for (let a = 0; a < 3; a++) { try { await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }); return; } catch (e) { if (a === 2) throw e; await page.waitForTimeout(1500); } } };
  const out = [];
  try {
    await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const rowIds = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('a')).map(a => (a.getAttribute('href') || '').match(/Employee\.aspx\?RowId=(\d+)/i)).filter(Boolean).map(m => m[1]))]);
    for (const id of rowIds) {
      try { await gotoEmp(id); await page.waitForTimeout(500); out.push({ rowid: id, ...(await readEmp(page)) }); }
      catch (e) { out.push({ rowid: id, error: e.message.split('\n')[0] }); }
    }
  } finally { await browser.close(); }
  fs.writeFileSync('/tmp/employees.json', JSON.stringify(out, null, 2));
  const genderUnset = g => !g || /select/i.test(g);
  const need = out.filter(e => ['10H', '12H', 'wir'].includes(e.shift) && e.policy !== e.shift);
  const needGender = need.filter(e => genderUnset(e.gender));
  console.log(`total ${out.length}`);
  console.log(`need policy change (10H/12H/wir, policy=GEN): ${need.length}`);
  console.log(`  of those, gender unset: ${needGender.length}; gender already set: ${need.length - needGender.length}`);
  const byShift = {}; need.forEach(e => byShift[e.shift] = (byShift[e.shift] || 0) + 1);
  console.log('  by shift:', JSON.stringify(byShift));
})();
