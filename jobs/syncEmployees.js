// Upserts the machine's employee list (code, name, dept) into att_salary/{code} so they
// appear in the PWA Salary/Staff tabs. Merge-writes: never overwrites salary/shift the admin set.
// Shift defaults to GEN only for brand-new docs (admin corrects the few non-GEN ones).
const { session, readGrid } = require('./lib/realtime');
const { db } = require('./lib/firestore');

const col = (h, ...names) => { const l = h.map(x => x.toLowerCase()); for (const n of names) { const i = l.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };

(async () => {
  const { browser, page } = await session();
  try {
    // old EmployeeList.aspx deleted with the old portal (Aug 2026) — V26 list only now
    await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const grid = await readGrid(page);
    const h = grid[0];
    if (!h) throw new Error('ERP_EmployeeList.aspx rendered no table — portal did not answer; retry later.');
    const ci = col(h, 'empcode', 'emp code', 'code'), ni = col(h, 'empname', 'emp name', 'name'), di = col(h, 'dept_name', 'dept', 'department');
    const fdb = db();
    let batch = fdb.batch(), n = 0, total = 0;
    const roster = [];
    for (const r of grid.slice(1)) {
      const code = (ci >= 0 ? r[ci] : '').trim();
      if (!code) continue;
      const name = (ni >= 0 ? r[ni] : '').trim();
      const dept = (di >= 0 ? r[di] : '').trim().toUpperCase();
      const ref = fdb.collection('att_salary').doc(code);
      const snap = await ref.get();
      const cur = snap.exists ? snap.data() : {};
      const patch = { code };
      // respect owner edits: don't overwrite a name/dept the admin changed in the app
      if (!cur.nameLocked) patch.name = name;
      if (!cur.deptLocked) patch.dept = dept;
      if (!snap.exists) patch.shift = 'GEN';        // default only for new docs
      batch.set(ref, patch, { merge: true });
      roster.push({ code, name: cur.nameLocked ? cur.name : name, dept: cur.deptLocked ? cur.dept : dept, shift: cur.shift || 'GEN' });
      if (++n >= 300) { await batch.commit(); total += n; batch = fdb.batch(); n = 0; }
    }
    if (n) { await batch.commit(); total += n; }
    // salary-free roster for manager-accessible pickers (att_meta/roster, readable by any signed-in user)
    await fdb.collection('att_meta').doc('roster').set({ employees: roster, updatedAt: new Date().toISOString() });
    console.log(`synced ${total} employees into att_salary + att_meta/roster`);
  } finally { await browser.close(); }
})();
