// FALCON → ATTENDANCE extra-loader bridge (owner 22-10-2026: "do what is most efficient and most effective").
//
// An extra loader's day is now written ONCE — in Falcon, by whoever hands over the cash: 👷 Labour → Loading/Unloading
// → Kaun (picked) → Kitna kaam (Full din / 4 / 6 / 8 / 12 ghante). This job turns each such line into the 🚚 Loading tab's
// ➕ Extra loaders entry on MAN-LOADING-ABC (same shape the app writes: advance with `extra.rows`, self-settled, never an
// advance or a balance). Before this the same cash was typed twice (Falcon + Attendance) and the two drifted.
//
// Detail format (falcon/src/logic/falcon.js parseXload — keep the two in step):
//   "Loading · Toufiq · Full din"   ·   "Unloading · 3 aadmi · Chowk labour · 6 ghante · note"
// Only lines dated from GO_LIVE; old free-text lines are never guessed. Idempotent: the entry id is fixed per Falcon line
// (adv-x-falcon-<id>); an edited Falcon line updates it, a cancelled one removes it (it was created here, nothing else).
// A day already entered by hand in Attendance (same date + name + amount) is not added again.
//   node jobs/falconExtraBridge.js --dry
const { db } = require('./lib/firestore');

const GO_LIVE = '2026-10-23';
const ABC = 'MAN-LOADING-ABC';
const XLOAD_CHIPS = ['Loading', 'Unloading'];
const XLOAD_WORK = ['Full din', '4 ghante', '6 ghante', '8 ghante', '12 ghante'];
const hoursOf = (w) => (w === 'Full din' ? 10 : Number(String(w || '').split(' ')[0]) || 0);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Fixed loaders (on the machine, paid via Clear hisab) must never also get an extra-loader day — that would pay the day twice.
// First names of active LOADING workers + spellings seen on slips (tophik on the machine = Toufiq / Tofiq on paper).
const ALIASES = { tophik: ['toufiq', 'tofiq', 'taufiq', 'tofik', 'toufik'], navi: ['nabi'], nagender: ['nagendra'] };
function fixedLoaderNames(salDocs) {
  const set = new Set();
  for (const d of salDocs) {
    const e = d.data();
    if (String(e.dept || '').toUpperCase() !== 'LOADING' || e.appOnly || e.active === false) continue;
    const first = norm(e.name).split(' ')[0];
    if (!first) continue;
    set.add(first); (ALIASES[first] || []).forEach((x) => set.add(x));
  }
  return set;
}

function parseXload(detail) {
  const p = String(detail || '').split(' · ');
  if (!XLOAD_CHIPS.includes(p[0])) return null;
  let i = 1, men = 1;
  const m = /^(\d+) aadmi$/.exec(p[i] || '');
  if (m) { men = Number(m[1]); i++; }
  const name = (p[i] || '').trim(), work = p[i + 1];
  if (!name || !XLOAD_WORK.includes(work)) return null;
  return { chip: p[0], men, name, hours: hoursOf(work), full: work === 'Full din', note: p.slice(i + 2).join(' · ') };
}

// same owner rule as web/src/lib/data.js attributeAdvanceMk + lock guard
function mkFor(emp, ymd) {
  const dm = ymd.slice(0, 7); const [y, m] = dm.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const j = String(emp.joinDate || '').slice(0, 7); if (j && j > prev) return dm;
  const pm = (emp.months || {})[prev] || {}; return (pm.locked || pm.payment) ? dm : prev;
}
const lockedFrom = (months, mk) => Object.entries(months || {}).find(([k, d]) => k >= mk && d && (d.locked || d.payment));

function entryFor(e, x, byName) {
  const amount = Number(e.amount) || 0, each = Math.round((amount / x.men) * 100) / 100;
  const rows = Array.from({ length: x.men }, () => ({ name: x.name, hours: x.hours, amount: each, full: x.full }));
  const work = x.full ? 'full day' : `${x.hours}h`;
  return {
    id: 'adv-x-falcon-' + e.id, date: e.date, mode: 'cash', amount, paidBy: e.by, falconId: e.id,
    remark: `Extra loaders: ${x.men > 1 ? x.men + ' × ' : ''}${x.name} ${work} (Falcon · ${byName})${x.note ? ' · ' + x.note : ''}`,
    extra: { rows, hours: x.hours * x.men, earned: amount },
  };
}
const same = (a, b) => a.date === b.date && a.amount === b.amount && a.remark === b.remark && JSON.stringify(a.extra) === JSON.stringify(b.extra);

async function run({ dry = false, target = ABC, entriesOverride = null } = {}) {   // target / entriesOverride: tests only
  const f = db();
  const base = f.collection('apps').doc('falcon');
  const [labSnap, users, sal] = await Promise.all([entriesOverride ? null : base.collection('entries').where('kind', '==', 'labour').get(), base.collection('users').get(),
    f.collection('att_salary').where('dept', 'in', ['LOADING', 'Loading', 'loading']).get()]);
  const fixed = fixedLoaderNames(sal.docs);
  const nameOf = Object.fromEntries(users.docs.map((d) => [d.id, d.data().name || d.id]));
  const want = new Map(), fixedSkipped = [];
  const lab = entriesOverride || labSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
  for (const e of lab) {
    if (e.status !== 'active' || !(e.date >= GO_LIVE)) continue;
    const x = parseXload(e.detail);
    if (!x || !(Number(e.amount) > 0)) continue;
    if (fixed.has(norm(x.name).split(' ')[0])) { fixedSkipped.push(`${e.date} ${x.name} ₹${e.amount}`); continue; }   // fixed crew → his Clear hisab
    want.set(e.id, entryFor(e, x, nameOf[e.by] || e.byName || e.by));
  }
  const ref = f.collection('att_salary').doc(target);
  const out = { added: 0, updated: 0, removed: 0, skippedHand: 0, locked: [], fixedSkipped };
  await f.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new Error(target + ' missing');
    const emp = snap.data();
    let advs = (emp.advances || []).slice();
    const auto = new Map(advs.filter((a) => a && a.falconId).map((a) => [a.falconId, a]));
    const hand = advs.filter((a) => a && a.extra && !a.falconId);
    let changed = false;
    for (const [fid, a] of want) {
      a.mk = auto.get(fid)?.mk || mkFor(emp, a.date);
      const lk = lockedFrom(emp.months, a.mk);
      if (lk) { out.locked.push(`${a.date} ${a.remark} (month ${lk[0]} locked)`); continue; }
      const old = auto.get(fid);
      if (old) { if (!same(old, a)) { advs = advs.map((x) => (x.id === old.id ? a : x)); out.updated++; changed = true; } continue; }
      const dup = hand.find((h) => h.date === a.date && Number(h.amount) === a.amount
        && (h.extra.rows || []).some((r) => norm(r.name) === norm(a.extra.rows[0].name)));
      if (dup) { out.skippedHand++; continue; }
      advs.push(a); out.added++; changed = true;
    }
    for (const [fid, a] of auto) {
      if (want.has(fid)) continue;
      if (lockedFrom(emp.months, a.mk || a.date.slice(0, 7))) { out.locked.push(`${a.date} cancel of ${a.remark}`); continue; }
      advs = advs.filter((x) => x.id !== a.id); out.removed++; changed = true;
    }
    if (changed && !dry) t.update(ref, { advances: advs });
  });
  return out;
}

module.exports = { run, parseXload, fixedLoaderNames };
if (require.main === module) {
  run({ dry: process.argv.includes('--dry') }).then((o) => { console.log('falcon extra-loader bridge:', JSON.stringify(o)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
