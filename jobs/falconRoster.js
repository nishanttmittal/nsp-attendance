// FALCON roster mirror — worker NAMES for the Advance / Khana tiles (owner 08-10-2026: "he picks the worker from the
// Attendance app's name list"). Copies code + name + dept + active from att_salary (admin-only) into
// apps/falcon/roster/{code}, which every active Falcon member may read and no phone may write. No pay data leaves.
// Runs daily from scheduler.js (08:05) and can be run by hand: node jobs/falconRoster.js
const { db } = require('./lib/firestore');

async function mirrorRoster() {
  const fdb = db();
  const src = await fdb.collection('att_salary').get();
  const dst = fdb.collection('apps').doc('falcon').collection('roster');
  const have = {};
  (await dst.get()).forEach(d => { have[d.id] = d.data(); });
  let batch = fdb.batch(), n = 0, writes = 0, active = 0;
  const seen = new Set();
  const flush = async () => { if (n) { await batch.commit(); batch = fdb.batch(); n = 0; } };
  for (const d of src.docs) {
    const e = d.data();
    const name = String(e.name || '').trim();
    if (!name) continue;
    const isActive = e.active !== false && !e.exitDate && !e.resignedAt;
    const row = { code: d.id, name, dept: String(e.dept || '').trim(), active: isActive };
    seen.add(d.id);
    if (isActive) active++;
    const old = have[d.id];
    if (old && old.name === row.name && old.dept === row.dept && old.active === row.active) continue;
    batch.set(dst.doc(d.id), { ...row, updatedAt: new Date() });
    n++; writes++;
    if (n >= 400) await flush();
  }
  // a worker deleted from att_salary disappears from the pick list (kept as inactive, never deleted)
  for (const id of Object.keys(have)) if (!seen.has(id) && have[id].active !== false) { batch.set(dst.doc(id), { active: false, updatedAt: new Date() }, { merge: true }); n++; writes++; }
  await flush();
  console.log(`falcon roster: ${src.size} workers in att_salary, ${active} active, ${writes} written`);
  return { total: src.size, active, writes };
}

module.exports = { mirrorRoster };
if (require.main === module) mirrorRoster().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
