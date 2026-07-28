// READ-ONLY audit: who loses overtime because their shift crosses midnight?
//
// The biometric portal reports one row per calendar day (first-in, last-out). When a worker punches
// out AFTER midnight, the out-time lands EARLIER than the in-time on that row, so the day's span is
// negative and its overtime is at risk of never being credited. See memory: payroll-night-ot-gap.
//
// ⚠️ WHAT THIS SCRIPT DOES AND DOES NOT PROVE (checked 2026-07-28):
//   PROVES  — which workers/days crossed midnight, and how much OT those days are WORTH.
//   DOES NOT PROVE — that the portal failed to credit it. att_attendance stores only a MONTHLY OT
//   total, and reconstructing the portal's per-day OT rules (caps, grace, the 20-min floor, Saturday
//   handling) was not faithful enough to decide: portal totals land BETWEEN "all credited" and
//   "none credited". Settling it needs the portal's PER-DAY OT report for one of these dates.
// So read the rupee column as OT AT RISK, not as money definitely owed.
//
//   node auditMidnightOt.js                 # last 2 months
//   MONTHS=2026-06,2026-07 node auditMidnightOt.js
//
// Reads att_punches (one doc per employee) + att_salary for names and rates. WRITES NOTHING.
const { db } = require('./lib/firestore');

const SHIFT_HOURS = { GEN: 8, '10H': 10, '12H': 12, wir: 10, DSG: 10 };
const mins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function monthsWanted() {
  if (process.env.MONTHS) return process.env.MONTHS.split(',').map(s => s.trim());
  const now = new Date(), out = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

(async () => {
  const months = monthsWanted();
  const [punchSnap, salSnap] = await Promise.all([
    db().collection('att_punches').get(),
    db().collection('att_salary').get(),
  ]);
  const emps = {};
  salSnap.forEach(d => { emps[d.id] = d.data(); });
  console.log(`Read ${punchSnap.size} punch docs + ${salSnap.size} salary docs. Months: ${months.join(', ')}\n`);

  const findings = [];
  punchSnap.forEach(doc => {
    const code = doc.id;
    const emp = emps[code] || {};
    const all = (doc.data().months) || {};
    for (const mk of months) {
      const days = all[mk];
      if (!days) continue;
      for (const [dd, p] of Object.entries(days)) {
        const i = mins(p.i), o = mins(p.o);
        if (i == null || o == null) continue;
        if (o >= i) continue;                       // normal same-day shift
        // Crossed midnight: real span = (24:00 − in) + out
        const realMins = (1440 - i) + o;
        const shiftHrs = SHIFT_HOURS[emp.shift] || 8;
        const realOtHrs = Math.max(0, realMins / 60 - shiftHrs);
        // Worth of the day's OT if it were credited in full. Whether the portal already did is UNVERIFIED.
        const lostOtHrs = realOtHrs;
        const rate = Number(emp.type === 'daily' ? emp.wage : emp.amount) || 0;
        const daysInMonth = new Date(+mk.slice(0, 4), +mk.slice(5, 7), 0).getDate();
        const perDay = emp.type === 'daily' ? rate : rate / daysInMonth;
        const lostRupees = emp.type === 'daily' ? 0 : lostOtHrs * (perDay / shiftHrs);
        findings.push({
          code, name: emp.name || code, shift: emp.shift || 'GEN', type: emp.type || 'monthly',
          month: mk, day: dd, in: p.i, out: p.o,
          realSpan: hhmm(Math.round(realMins)), shiftHrs,
          lostOtHrs: Math.round(lostOtHrs * 100) / 100,
          lostRupees: Math.round(lostRupees * 100) / 100,
        });
      }
    }
  });

  if (!findings.length) { console.log('No midnight-crossing shifts found in these months.'); process.exit(0); }

  findings.sort((a, b) => b.lostRupees - a.lostRupees || b.lostOtHrs - a.lostOtHrs);
  console.log('MIDNIGHT-CROSSING SHIFTS — overtime AT RISK (portal crediting NOT verified)');
  console.log('-'.repeat(112));
  console.log('worker'.padEnd(26) + 'shift'.padEnd(7) + 'date'.padEnd(12) + 'in→out'.padEnd(16) + 'real span'.padEnd(11) + 'lost OT'.padEnd(10) + 'lost ₹');
  console.log('-'.repeat(112));
  for (const f of findings) {
    console.log(
      `${f.name.slice(0, 24)}`.padEnd(26) + String(f.shiftHrs + 'h').padEnd(7) +
      `${f.day}-${f.month.slice(5)}`.padEnd(12) + `${f.in} → ${f.out}`.padEnd(16) +
      f.realSpan.padEnd(11) + `${f.lostOtHrs}h`.padEnd(10) + `₹${f.lostRupees.toFixed(2)}`);
  }

  const byWorker = {};
  for (const f of findings) {
    const w = (byWorker[f.code] ||= { name: f.name, days: 0, hrs: 0, rs: 0, type: f.type });
    w.days++; w.hrs += f.lostOtHrs; w.rs += f.lostRupees;
  }
  console.log('\nPER WORKER');
  console.log('-'.repeat(112));
  for (const [code, w] of Object.entries(byWorker).sort((a, b) => b[1].rs - a[1].rs)) {
    console.log(`${w.name.slice(0, 24)}`.padEnd(26) + `${code}`.padEnd(12) +
      `${w.days} night${w.days === 1 ? '' : 's'}`.padEnd(12) +
      `${Math.round(w.hrs * 100) / 100} h`.padEnd(12) +
      `₹${w.rs.toFixed(2)}` + (w.type === 'daily' ? '   (daily wager — paid by hours, no separate OT)' : ''));
  }
  const totalRs = Object.values(byWorker).reduce((s, w) => s + w.rs, 0);
  const totalHrs = Object.values(byWorker).reduce((s, w) => s + w.hrs, 0);
  console.log('-'.repeat(112));
  console.log(`TOTAL: ${findings.length} night(s) across ${Object.keys(byWorker).length} worker(s) — ` +
    `${Math.round(totalHrs * 100) / 100} h, ₹${totalRs.toFixed(2)} of overtime AT RISK.`);
  console.log('\nNothing was changed. This is a report only. The rupee column is OT AT RISK — see the');
  console.log('header note: whether the portal already credited these days is NOT established.');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
