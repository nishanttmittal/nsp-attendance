// Upserts the machine's employee list (code, name, dept) into att_salary/{code} so they
// appear in the PWA Salary/Staff tabs. Merge-writes: never overwrites salary/shift the admin set.
// Shift defaults to GEN only for brand-new docs (admin corrects the few non-GEN ones).
const { session, readGrid } = require('./lib/realtime');
const { db } = require('./lib/firestore');

const col = (h, ...names) => { const l = h.map(x => x.toLowerCase()); for (const n of names) { const i = l.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };

(async () => {
  const { browser, page } = await session();
  try {
    await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const grid = await readGrid(page);
    const h = grid[0];
    const ci = col(h, 'empcode', 'emp code', 'code'), ni = col(h, 'empname', 'emp name', 'name'), di = col(h, 'dept_name', 'dept', 'department');
    const fdb = db();
    let batch = fdb.batch(), n = 0, total = 0;
    for (const r of grid.slice(1)) {
      const code = (ci >= 0 ? r[ci] : '').trim();
      if (!code) continue;
      const ref = fdb.collection('att_salary').doc(code);
      const snap = await ref.get();
      const patch = { code, name: (ni >= 0 ? r[ni] : '').trim(), dept: (di >= 0 ? r[di] : '').trim().toUpperCase() };
      if (!snap.exists) patch.shift = 'GEN';        // default only for new docs
      batch.set(ref, patch, { merge: true });
      if (++n >= 300) { await batch.commit(); total += n; batch = fdb.batch(); n = 0; }
    }
    if (n) { await batch.commit(); total += n; }
    console.log(`synced ${total} employees into att_salary`);
  } finally { await browser.close(); }
})();
