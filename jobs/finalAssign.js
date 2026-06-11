// Targeted: set Gender + Office-Time-Policy(=shift) for the 3 non-GEN employees, verify round-trip.
const { session } = require('./lib/realtime');

const TARGETS = [
  { rowid: '42',  name: 'satish guard',               shift: '12H', gender: 'Male' },
  { rowid: '14',  name: 'amarjeet wirecut tool room', shift: 'wir', gender: 'Male' },
  { rowid: '272', name: 'sandeep supervisor',         shift: '12H', gender: 'Male' },
];

const readEmp = (page) => page.evaluate(() => {
  const sel = id => { const e = document.getElementById(id); return e ? e.options[e.selectedIndex]?.text.trim() : null; };
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  return { name: val('MainContent_Txtempname'), shift: sel('MainContent_cboshiftname'),
    policy: sel('MainContent_cboofficetimepolicy'), gender: sel('MainContent_CboGender'),
    dept: sel('MainContent_cbodeptname') };
});

(async () => {
  const { browser, page } = await session();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const gotoEmp = async (id) => { for (let a = 0; a < 3; a++) { try { await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }); return; } catch (e) { if (a === 2) throw e; await page.waitForTimeout(1500); } } };
  try {
    for (const t of TARGETS) {
      dialogs.length = 0;
      await gotoEmp(t.rowid); await page.waitForTimeout(700);
      const before = await readEmp(page);
      await page.selectOption('#MainContent_CboGender', { label: t.gender }).catch(() => {});
      await page.selectOption('#MainContent_cboofficetimepolicy', { label: t.shift }).catch(() => {});
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_cmdsave')]);
      await page.waitForTimeout(1500);
      const saveDialogs = [...dialogs];
      // verify
      await gotoEmp(t.rowid); await page.waitForTimeout(700);
      const after = await readEmp(page);
      const ok = after.policy === t.shift && after.gender === t.gender && after.name === before.name && after.shift === before.shift && after.dept === before.dept;
      console.log(`#${t.rowid} ${t.name}: policy ${before.policy}→${after.policy}, gender ${before.gender}→${after.gender}  ${ok ? 'OK ✓' : 'CHECK'}`);
      if (saveDialogs.length) console.log('   save alerts:', JSON.stringify(saveDialogs));
      if (!ok) console.log('   after:', JSON.stringify(after));
    }
  } finally { await browser.close(); }
})();
