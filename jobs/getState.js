// Pulls the live floor state from Realtime: present count (+ per-dept), the day's
// late-comers, and the 17:45 meal headcount (still punched-in, excluding WELDING).
// Prints JSON to stdout; later this feeds Supabase daily_stats + Telegram.
const { session, readGrid } = require('./lib/realtime');

const MEAL_EXCLUDE_DEPT = 'WELDING'; // welders excluded from the food headcount

function colIndex(header, ...names) {
  const lower = header.map(h => h.toLowerCase());
  for (const n of names) {
    const i = lower.findIndex(h => h.includes(n));
    if (i !== -1) return i;
  }
  return -1;
}

async function dashboardCounts(page) {
  await page.goto('https://onlinerealsoft.com/Welcome.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const num = (label) => {
      const el = Array.from(document.querySelectorAll('*')).find(e =>
        e.children.length === 0 && e.innerText && e.innerText.trim() === label);
      // walk up to the card and find a number
      let node = el;
      for (let i = 0; node && i < 5; i++) { node = node.parentElement;
        const m = node && node.innerText.match(/\b(\d{1,4})\b/); if (m) return parseInt(m[1], 10); }
      return null;
    };
    return {
      totalEmployees: num('Total Employees'),
      totalPresent: num('Total Present'),
      totalAbsent: num('Total Absent Employees'),
      totalLate: num('Total Late Employees'),
    };
  });
}

// code -> { name, dept } from the employee master (DailyPresentEmployee lacks Department)
async function employeeMaster(page) {
  await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const grid = await readGrid(page);
  const map = {};
  if (grid.length < 2) return map;
  const h = grid[0];
  const ci = colIndex(h, 'empcode', 'emp code', 'code'), ni = colIndex(h, 'empname', 'emp name', 'name'),
        di = colIndex(h, 'dept_name', 'dept', 'department');
  for (const r of grid.slice(1)) {
    const code = ci >= 0 ? r[ci] : '';
    if (code) map[code] = { name: ni >= 0 ? r[ni] : '', dept: (di >= 0 ? r[di] : '').toUpperCase() };
  }
  return map;
}

async function presentList(page) {
  await page.goto('https://onlinerealsoft.com/DailyPresentEmployee.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const grid = await readGrid(page);
  if (grid.length < 2) return { rows: [], header: [] };
  const header = grid[0];
  const di = colIndex(header, 'department', 'dept');
  const ii = colIndex(header, 'in time', 'in-time', 'intime');
  const oi = colIndex(header, 'out-time', 'out time', 'outtime');
  const ni = colIndex(header, 'employee name', 'name');
  const ci = colIndex(header, 'employee code', 'empcode', 'code');
  const rows = grid.slice(1).map(r => ({
    code: ci >= 0 ? r[ci] : '', name: ni >= 0 ? r[ni] : '',
    dept: di >= 0 ? r[di] : '', inT: ii >= 0 ? r[ii] : '', outT: oi >= 0 ? r[oi] : '',
  })).filter(r => r.code || r.name);
  return { rows, header };
}

async function absentList(page) {
  await page.goto('https://onlinerealsoft.com/DailyAbsentEmployee.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const grid = await readGrid(page);
  if (grid.length < 2) return [];
  const h = grid[0];
  const ci = colIndex(h, 'employee code', 'code'), ni = colIndex(h, 'name'), di = colIndex(h, 'department', 'dept');
  return grid.slice(1).map(r => ({ code: ci >= 0 ? r[ci] : '', name: ni >= 0 ? r[ni] : '', dept: di >= 0 ? r[di] : '' }))
    .filter(r => r.code || r.name);
}

async function lateList(page) {
  await page.goto('https://onlinerealsoft.com/DailyLateEmployee.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const grid = await readGrid(page);
  if (grid.length < 2) return [];
  const h = grid[0];
  const ci = colIndex(h, 'employee code', 'code'), ni = colIndex(h, 'name'),
        di = colIndex(h, 'department', 'dept'), ii = colIndex(h, 'in time', 'in-time'),
        si = colIndex(h, 'status');
  return grid.slice(1).map(r => ({
    code: ci >= 0 ? r[ci] : '', name: ni >= 0 ? r[ni] : '',
    dept: di >= 0 ? r[di] : '', inT: ii >= 0 ? r[ii] : '', status: si >= 0 ? r[si] : '',
  })).filter(r => r.code || r.name);
}

// Gather the full live floor state on an already-logged-in page.
async function gatherState(page) {
  const counts = await dashboardCounts(page);
  const master = await employeeMaster(page);
  const present = await presentList(page);
  const late = await lateList(page);
  const absent = await absentList(page);

  for (const r of present.rows) r.dept = (master[r.code] && master[r.code].dept) || r.dept || '';

  const perDept = {};
  for (const r of present.rows) perDept[r.dept || '—'] = (perDept[r.dept || '—'] || 0) + 1;

  // Department attendance ratio = present / total (total = headcount per dept from master)
  const deptTotals = {};
  for (const e of Object.values(master)) deptTotals[e.dept || '—'] = (deptTotals[e.dept || '—'] || 0) + 1;
  const deptRatio = {};
  for (const d of new Set([...Object.keys(deptTotals), ...Object.keys(perDept)])) {
    const present = perDept[d] || 0, total = deptTotals[d] || 0;
    deptRatio[d] = { present, total, pct: total ? Math.round((present / total) * 100) : 0 };
  }

  // dinner headcount = present staff who stayed past 17:30 (out-time after 17:30, or still in),
  // excluding welders. Robust whether the job runs at 17:45 or later in the evening.
  const toMin = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const CUTOFF = 17 * 60 + 30; // 17:30
  const stayedPastShift = r => { const o = toMin(r.outT); return o === null || o > CUTOFF; };
  const stillIn = present.rows.filter(r => !r.outT || !r.outT.trim());
  const mealRows = present.rows.filter(r => stayedPastShift(r) && (r.dept || '').toUpperCase() !== MEAL_EXCLUDE_DEPT);

  return {
    at: new Date().toISOString(),
    counts,
    presentTotal: present.rows.length,
    perDept,
    deptRatio,
    stillInCount: stillIn.length,
    mealHeadcount: mealRows.length,
    mealExcludes: MEAL_EXCLUDE_DEPT,
    lateCount: late.length,
    late: late.map(l => ({ code: l.code, name: l.name, dept: l.dept, inT: l.inT, status: l.status })),
    absentCount: absent.length,
    absent: absent.map(a => ({ code: a.code, name: a.name, dept: a.dept })),
    presentRows: present.rows, // {code,name,dept,inT,outT} — for missed-punch detection
  };
}

module.exports = { gatherState };

// CLI: print the state as JSON
if (require.main === module) {
  (async () => {
    const { browser, page } = await session();
    try { console.log(JSON.stringify(await gatherState(page), null, 2)); }
    finally { await browser.close(); }
  })();
}
