// LOD (loading) daily-wager grace engine — owner rule 2026-08-11 ("grace both ways"):
//   day = 09:00–19:30 (lunch 13:00–13:30 unpaid) = 10 working hours = one wage (₹700 → ₹70/hr).
//   • Short day: late-in + early-out totalling ≤ 15 min → counts a FULL day; > 15 min → pay
//     actual hours (no forgiveness), clamped to the 09:00–19:30 window.
//   • Extra time past 19:30: ≤ 15 min earns nothing; > 15 min counts in full from 19:30 at 1×.
// Computes equivalentDays from ACTUAL punches (att_punches) — deliberately NOT from the portal's
// monthly "Total Work", which for LOD workers reports ~8.5 h/day against 10.4 h punch spans
// (policy-basis artifact, seen July 2026). att_attendance.months[mk].equivalentDays feeds both
// pay engines directly (owner's md.override.days still wins — paycalc sets it after this).
// Single-punch days count FULL (mirrors the LOD shift's single-punch handling); both-null = absent.
// The owner's per-day override (att_salary months[mk].dayOverrides['YYYY-MM-DD'] = full|half|absent)
// WINS over the punch calc — e.g. salman's 2026-07-22 lone punch is owner-marked absent.
const { db } = require('./lib/firestore');

const SHIFT_START = 9 * 60, SHIFT_END = 19 * 60 + 30;   // 09:00–19:30
const STD_HOURS = 10, LUNCH_HRS = 0.5, GRACE_MIN = 15;

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };

// hours credited for one day's punches under the grace rule
function dayHours(iRaw, oRaw) {
  const i = toMin(iRaw), o = toMin(oRaw);
  if (i == null && o == null) return { hrs: 0, kind: 'absent' };
  if (i == null || o == null) return { hrs: STD_HOURS, kind: 'single' };   // single punch = full day
  const inM = Math.max(i, SHIFT_START);                       // early arrival earns nothing
  const lateMin = Math.max(0, i - SHIFT_START);
  const earlyMin = Math.max(0, SHIFT_END - o);
  const extraMin = Math.max(0, o - SHIFT_END);
  const base = (lateMin + earlyMin) <= GRACE_MIN
    ? STD_HOURS
    : Math.max(0, (Math.min(o, SHIFT_END) - inM) / 60 - LUNCH_HRS);
  const ot = extraMin > GRACE_MIN ? extraMin / 60 : 0;        // ignore ≤15 min past 19:30
  return { hrs: base + ot, kind: 'worked' };
}

// month key + label for an offset (0 = current IST month, 1 = last month …)
function monthKey(offset) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Recompute equivalentDays for every active LOD daily wager for the given month offsets.
async function graceAdjust(offsets = [0, 1]) {
  const fdb = db();
  const sal = await fdb.collection('att_salary').where('type', '==', 'daily').get();
  const workers = [];
  sal.forEach(d => { const x = d.data(); if ((x.shift || '') === 'LOD' && x.active !== false) workers.push({ code: d.id, name: x.name }); });
  const out = [];
  for (const mkOff of offsets) {
    const mk = monthKey(mkOff);
    for (const w of workers) {
      const [pun, salDoc] = await Promise.all([
        fdb.collection('att_punches').doc(w.code).get(),
        fdb.collection('att_salary').doc(w.code).get(),
      ]);
      const days = ((pun.data() || {}).months || {})[mk];
      if (!days) continue;
      const overrides = (((salDoc.data() || {}).months || {})[mk] || {}).dayOverrides || {};
      let equiv = 0, worked = 0, single = 0, overridden = 0;
      for (const dd of Object.keys(days)) {
        const ov = overrides[`${mk}-${dd}`];
        let r;
        if (ov === 'absent') r = { hrs: 0, kind: 'override' };
        else if (ov === 'half') r = { hrs: STD_HOURS / 2, kind: 'override' };
        else if (ov === 'full') r = { hrs: STD_HOURS, kind: 'override' };
        else r = dayHours(days[dd].i, days[dd].o);
        equiv += r.hrs / STD_HOURS;
        if (r.kind === 'worked') worked++;
        if (r.kind === 'single') single++;
        if (r.kind === 'override') overridden++;
      }
      equiv = Math.round(equiv * 1000) / 1000;
      await fdb.collection('att_attendance').doc(w.code).set({
        months: { [mk]: { equivalentDays: equiv, graceMeta: { rule: 'lod-15min-both-ways', at: new Date().toISOString(), worked, single, overridden } } },
      }, { merge: true });
      out.push({ mk, code: w.code, name: w.name, equiv, worked, single, overridden });
    }
  }
  return out;
}

module.exports = { graceAdjust, dayHours };

if (require.main === module) {
  const offsets = (process.env.MONTHS || '0,1').split(',').map(n => parseInt(n.trim(), 10));
  graceAdjust(offsets).then(rows => {
    rows.forEach(r => console.log(`${r.mk} ${r.code} ${r.name}: equivalentDays=${r.equiv} (worked=${r.worked}${r.single ? ', single-punch=' + r.single : ''})`));
    console.log(`updated ${rows.length} worker-months`);
    process.exit(0);
  }).catch(e => { console.error('ERR', e.message); process.exit(1); });
}
