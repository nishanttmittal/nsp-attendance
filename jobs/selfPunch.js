// Drains att_self_punch (created by the login-free punch.html link) and records each
// worker's in/out into att_punch/{code} — AFTER validating the token server-side against
// att_salary.selfPunchToken. Bad/forged tokens are dropped. Keeps earliest IN, latest OUT
// per day. att_punch holds NO salary (just name + standardHours + days) so it's safe to be
// publicly readable by the punch page. Called by worker.js each cycle.
const { db } = require('./lib/firestore');

async function drainSelfPunch() {
  const fdb = db();
  const snap = await fdb.collection('att_self_punch').limit(300).get();
  if (snap.empty) return 0;

  // group raw taps by employee code
  const byCode = {};
  for (const d of snap.docs) {
    const p = d.data();
    if (!p.code || !['in', 'out'].includes(p.dir) || !p.date || !p.localTime) { await d.ref.delete(); continue; }
    (byCode[p.code] || (byCode[p.code] = [])).push({ ref: d.ref, ...p });
  }

  let applied = 0;
  for (const [code, taps] of Object.entries(byCode)) {
    const emp = await fdb.collection('att_salary').doc(code).get();
    const want = emp.exists ? emp.data().selfPunchToken : null;
    const valid = taps.filter(t => want && t.token === want);
    // drop everything for this code (valid ones get applied below; invalid are ignored)
    await Promise.all(taps.map(t => t.ref.delete()));
    if (!valid.length) continue;

    const punchDoc = fdb.collection('att_punch').doc(code);
    const cur = (await punchDoc.get()).data() || {};
    const days = { ...(cur.days || {}) };
    for (const t of valid) {
      const day = days[t.date] || (days[t.date] = {});
      if (t.dir === 'in') day.in = day.in && day.in < t.localTime ? day.in : t.localTime;   // earliest IN
      else day.out = day.out && day.out > t.localTime ? day.out : t.localTime;              // latest OUT
    }
    await punchDoc.set({
      name: emp.data().name || '', standardHours: emp.data().standardHours || '', days,
    }, { merge: true });
    applied += valid.length;
  }
  return applied;
}

module.exports = { drainSelfPunch };

if (require.main === module) drainSelfPunch()
  .then(n => console.log('self-punch applied', n))
  .catch(e => { console.error(e); process.exit(1); });
