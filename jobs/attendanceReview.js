// "To handle" attendance review (owner 2026-08-12) — a read-only monthly list of days the
// owner may want to act on, surfaced in the Problems tab. Two kinds:
//   1. earlyFull  — weekday left ≥45 min before shift end yet still classified a FULL day
//                   (paid in full for unworked time; shows the ≈₹ value)
//   2. brokenDays — workers with ≥2 short days (half/absent WITH punches) in the month
// Exclusions: Saturdays (worked Sat = bonus OT), daily wagers (hours-paid — nothing leaks),
// app-only staff, single-punch days (missed-punch flow), and the sanctioned 1-hour-evening-grace
// people: sandeep supervisor 00000255 + satish guard 00000061 (their early exits are agreed).
// Writes att_meta/attendance_review_{YYYY-MM}. Runs once/day from worker.js; manual:
//   MONTHS=0,1 node attendanceReview.js
const { db } = require('./lib/firestore');

const EXCLUDE = new Set(['00000255', '00000061']);   // owner-sanctioned evening grace
const SHIFT_END_MIN = { GEN: 17 * 60 + 30, '10H': 19 * 60 + 30, '12H': 21 * 60, wir: 20 * 60, DSG: 19 * 60, LOD: 19 * 60 + 30 };
const NET_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10, DSG: 9.5, LOD: 10 };
const EARLY_MIN = 45, GRACE_HRS = 0.25;

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };

function monthKey(offset) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function buildReview(offsets = [0, 1]) {
  // the app-side engine is an ES module — dynamic import works from CJS
  const { computeMonth, SHIFT_HOURS } = await import('../web/src/lib/attendanceEngine.js');
  const fdb = db();
  const [salSnap, punSnap] = await Promise.all([
    fdb.collection('att_salary').get(),
    fdb.collection('att_punches').get(),
  ]);
  const sal = {}; salSnap.forEach((d) => { sal[d.id] = d.data(); });
  const pun = {}; punSnap.forEach((d) => { pun[d.id] = d.data().months || {}; });

  const out = [];
  for (const off of offsets) {
    const mk = monthKey(off);
    const [y, m] = mk.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const earlyFull = [], brokenDays = [];
    for (const [code, x] of Object.entries(sal)) {
      if (EXCLUDE.has(code) || x.appOnly || x.type === 'daily') continue;
      if (x.active === false || x.resigned || x.removed || !x.amount) continue;
      const months = pun[code]; if (!months) continue;
      const byDate = {};
      for (const k of [prev, mk]) for (const dd of Object.keys(months[k] || {})) byDate[`${k}-${dd}`] = months[k][dd] || {};
      const shift = x.shift || 'GEN';
      const app = computeMonth(shift, byDate, { start: `${mk}-01`, to: `${mk}-${String(last).padStart(2, '0')}` });
      const endMin = SHIFT_END_MIN[shift] || SHIFT_END_MIN.GEN;
      const span = SHIFT_HOURS[shift] || 8.5;
      const hourly = (Number(x.amount) / last) / (NET_HOURS[shift] || 8);
      const broken = [];
      for (const day of app.detail) {
        if (['weekly-off', 'sat-worked', 'sat-absent'].includes(day.kind)) continue;   // Saturdays out
        const hasPunch = !!(day.in || day.out);
        if (day.kind === 'full' && day.out != null && day.worked != null) {
          const outM = toMin(day.out);
          if (outM != null && outM < endMin - EARLY_MIN) {
            const shortHrs = Math.max(0, span - day.worked - GRACE_HRS);
            if (shortHrs > 0.1) earlyFull.push({
              code, name: x.name || code, date: day.ymd, in: day.in, out: day.out,
              shortHrs: Math.round(shortHrs * 10) / 10, value: Math.round(shortHrs * hourly),
            });
          }
        }
        if ((day.kind === 'half' || day.kind === 'absent') && hasPunch && !day.single) {
          broken.push({ date: day.ymd, in: day.in, out: day.out, kind: day.kind, worked: day.worked != null ? Math.round(day.worked * 10) / 10 : null });
        }
      }
      if (broken.length >= 2) brokenDays.push({ code, name: x.name || code, count: broken.length, days: broken });
    }
    earlyFull.sort((a, b) => b.value - a.value);
    brokenDays.sort((a, b) => b.count - a.count);
    await fdb.collection('att_meta').doc(`attendance_review_${mk}`).set({
      month: mk, earlyFull, brokenDays,
      totalEarlyValue: earlyFull.reduce((s, e) => s + e.value, 0),
      computedAt: new Date().toISOString(),
    });
    out.push({ mk, earlyFull: earlyFull.length, brokenDays: brokenDays.length });
  }
  return out;
}

module.exports = { buildReview };

if (require.main === module) {
  const offsets = (process.env.MONTHS || '0,1').split(',').map((n) => parseInt(n.trim(), 10));
  buildReview(offsets).then((r) => {
    r.forEach((x) => console.log(`${x.mk}: earlyFull=${x.earlyFull} brokenPatterns=${x.brokenDays}`));
    process.exit(0);
  }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
