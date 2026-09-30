// VIEW-ONLY copy of the 🚚 Loading hisab for the manager (owner 29-09-2026: "he should be able to see
// loading hisab also no modification just viewing"). att_salary and att_punches are owner-only by rule,
// so the manager cannot read them; this writes att_meta/loading_hisab (staff-readable, write: false)
// with ONLY the loader fields that web/src/lib/loadingHisab.js needs. The app runs the same math on it,
// so the manager sees exactly the owner's figures. No other worker's pay data is copied.
const { db } = require('./lib/firestore');

// same test as isLoader() in web/src/lib/loadingHisab.js
const isLoader = (e) => String((e && e.dept) || '').toUpperCase() === 'LOADING' && e.type === 'daily';
const KEEP_MONTHS = 3;   // punch months copied (enough for any open hisab; joinDate-seeded cards start recent)

function slimEmp(code, e) {
  const months = {};
  for (const [mk, md] of Object.entries(e.months || {})) {
    const p = md && md.payment;
    if (p) months[mk] = { payment: { cash: Number(p.cash) || 0, account: Number(p.account) || 0, date: p.date || null } };
  }
  return {
    code, name: e.name || code, dept: e.dept || '', type: e.type || '',
    wage: Number(e.wage) || 0, stdHours: Number(e.stdHours) || Number(e.standardHours) || null,
    active: e.active !== false, appOnly: !!e.appOnly, joinDate: e.joinDate || null,
    hisabClears: Array.isArray(e.hisabClears) ? e.hisabClears : [],
    advances: (e.advances || []).filter((a) => a && a.id && a.date)
      .map((a) => ({ id: a.id, date: a.date, amount: Number(a.amount) || 0, mode: a.mode || 'cash', remark: a.remark || '', by: a.paidBy || '' })),
    months,
  };
}

// `sal` = the att_salary snapshot the worker already read (no extra salary reads).
async function writeLoadingMirror(sal) {
  const emps = [];
  sal.forEach((d) => { const e = d.data(); if (isLoader(e)) emps.push(slimEmp(d.id, e)); });
  const refs = emps.filter((e) => !e.appOnly).map((e) => db().collection('att_punches').doc(e.code));
  const docs = refs.length ? await db().getAll(...refs) : [];
  const punches = {};
  let syncedTill = '';
  for (const d of docs) {
    if (!d.exists) continue;
    const all = d.data().months || {};
    const keep = Object.keys(all).sort().slice(-KEEP_MONTHS);
    const months = {};
    for (const mk of keep) {
      months[mk] = all[mk];
      for (const [dd, r] of Object.entries(all[mk] || {})) if (r && (r.i || r.o) && `${mk}-${dd}` > syncedTill) syncedTill = `${mk}-${dd}`;
    }
    punches[d.id] = { months };
  }
  await db().collection('att_meta').doc('loading_hisab').set({ emps, punches, syncedTill, updatedAt: new Date().toISOString() });
  return emps.length;
}

module.exports = { writeLoadingMirror };

// one-off: `node jobs/loadingMirror.js` writes the doc now (without running the whole worker)
if (require.main === module) {
  (async () => {
    const sal = await db().collection('att_salary').get();
    console.log('loading mirror: wrote', await writeLoadingMirror(sal), 'loaders');
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
