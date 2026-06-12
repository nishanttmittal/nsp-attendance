// READ-ONLY salary-import matcher. Reads the previous-month salary xlsx (name + SALARY
// RATE), fuzzy-matches each person against the att_salary roster (whose names carry
// dept/role suffixes), and prints a 3-bucket review report. Writes NOTHING — a separate
// step applies the salaries after the owner confirms the ⚠️/❌ rows.
//   node importSalaryMatch.js "/path/to/salary april 2026.xlsx"
const XLSX = require('xlsx');
const { db } = require('./lib/firestore');

const STOP = new Set(['fitting', 'fiitting', 'fititng', 'fitter', 'press', 'pressman', 'powder', 'helper',
  'tool', 'room', 'toolroom', 'wirecut', 'welding', 'welder', 'weldwr', 'weld', 'frame', 'demo', 'guard',
  'supervisor', 'painter', 'packing', 'store', 'office', 'staff', 'ladies', 'incharge', 'mr', 'ji',
  'kumar', 'singh', 'devi', 'lal',
  'jan', 'feb', 'march', 'april', 'may', 'june', 'july', 'aug', 'sep', 'oct', 'nov', 'dec', 'new', 'old']);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => norm(s).split(' ').filter(t => t && !STOP.has(t));

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const ratio = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; };
const tokenMatch = (x, y) => x === y || (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))) || lev(x, y) <= 1;

// Compare a file name to an app name. Returns { p, s }:
//  p = precision = fraction of the file-name's words found in the app name (subset = 1)
//  s = string-closeness of the sorted name tokens (tiebreaker / spelling guard)
function sim(fileName, appName) {
  const ft = tokens(fileName), at = tokens(appName);
  if (!ft.length || !at.length) { const r = ratio(norm(fileName), norm(appName)); return { p: r, s: r }; }
  let hit = 0;
  for (const x of ft) if (at.some(y => tokenMatch(x, y))) hit++;
  const p = hit / ft.length;
  const s = ratio([...ft].sort().join(''), [...at].sort().join(''));
  return { p, s };
}
const key = m => m.p * 1000 + m.s; // sort: precision first, string closeness as tiebreak

async function runMatch(file) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  // header row 0: [' ','DAYS','OT','advance','SALARY','SALARY RATE',...] → name=col0, rate=col5
  const people = [];
  for (const r of rows.slice(1)) {
    const name = String(r[0] || '').trim();
    const rate = Number(r[5]);
    if (name && rate > 0) people.push({ name, rate });
  }

  const snap = await db().collection('att_salary').get();
  const app = snap.docs.map(d => ({ code: d.id, name: d.data().name || '', hasSalary: !!(d.data().amount || d.data().wage) }));

  // best candidate per file person
  for (const p of people) {
    let best = null, bm = { p: 0, s: 0 };
    for (const a of app) { const m = sim(p.name, a.name); if (key(m) > key(bm)) { bm = m; best = a; } }
    p.best = best; p.p = bm.p; p.s = bm.s;
  }
  // greedy UNIQUE assignment — highest-confidence claimant wins each employee
  const taken = new Map(); // code -> winning person
  [...people].sort((a, b) => key(b) - key(a)).forEach(p => {
    if (p.best && p.p >= 0.5 && !taken.has(p.best.code)) { taken.set(p.best.code, p); p.assigned = true; }
  });

  const confident = [], probable = [], none = [];
  for (const p of people) {
    const dup = p.best && !p.assigned && taken.has(p.best.code);
    p.dup = dup ? taken.get(p.best.code) : null;
    if (p.assigned && p.p >= 0.99 && p.s >= 0.45) confident.push(p);
    else if (p.best && p.p >= 0.5) probable.push(p); // includes collisions (flagged) + partials
    else none.push(p);
  }
  const appUnmatched = app.filter(a => !taken.has(a.code));
  return { people, app, confident, probable, none, appUnmatched };
}

module.exports = { runMatch };

if (require.main === module) (async () => {
  const { people, app, confident, probable, none, appUnmatched } = await runMatch(process.argv[2]);
  const r = n => '₹' + Number(n).toLocaleString('en-IN');
  const sc = p => `[${p.p.toFixed(2)}/${p.s.toFixed(2)}]`;
  console.log(`\nSalary file: ${people.length} people with a rate.  App roster: ${app.length}.\n`);
  console.log(`✅ CONFIDENT (${confident.length}) — file name → app employee  ₹rate`);
  confident.forEach(x => console.log(`   ${x.name}  →  ${x.best.name} (${x.best.code})  ${r(x.rate)}`));
  console.log(`\n⚠️  PLEASE CONFIRM (${probable.length}) — best guess, may be wrong`);
  probable.forEach(x => console.log(`   ${x.name}  ${r(x.rate)}  →  ${x.best ? x.best.name + ' (' + x.best.code + ')' : '?'} ${sc(x)}${x.dup ? '  ⚠️CLASH with "' + x.dup.name + '"' : ''}`));
  console.log(`\n❌ NO MATCH (${none.length}) — assign manually or skip`);
  none.forEach(x => console.log(`   ${x.name}  ${r(x.rate)}  (closest: ${x.best ? x.best.name : '—'} ${sc(x)})`));
  console.log(`\n🔎 APP EMPLOYEES WITH NO SALARY FROM FILE (${appUnmatched.length}) — new joiners / different name / daily-wager`);
  appUnmatched.forEach(a => console.log(`   ${a.name} (${a.code})${a.hasSalary ? ' [already has salary]' : ''}`));
})().catch(e => { console.error(e); process.exit(1); });
