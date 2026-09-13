// One-time OPENING clearance for the Loading hisab card (owner 13-09-2026).
// The crew's last full hisab closed on 09-09-2026 (Anshul's slip ₹30,100 verified against punches;
// Anshul paid ₹12,500 + owner paid the ₹2,800 balance — memory loading-crew-hisab-2026-09-09).
// Writes ONE additive entry per loader into att_salary.hisabClears via arrayUnion — touches no other
// field, idempotent by id. Backs up the docs first. DRY by default:  DRY=false node jobs/seedLoadingHisab.js
const fs = require('fs');
const path = require('path');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./lib/firestore');

const TILL = '2026-09-09';
const CODES = ['00000051', '00000056', '00000060', '00000062', '00000117', 'MAN-LOADING-ABC'];
const DRY = process.env.DRY !== 'false';

(async () => {
  const col = db().collection('att_salary');
  const docs = await Promise.all(CODES.map((c) => col.doc(c).get()));
  const backup = {};
  docs.forEach((d) => { if (d.exists) backup[d.id] = d.data(); });
  const dir = path.join(process.env.HOME, '.claude', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `att_salary-loading-hisab-seed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log('backup ->', file);
  for (const d of docs) {
    if (!d.exists) { console.log('MISSING', d.id); continue; }
    const e = d.data();
    const id = `seed-${TILL}`;
    if ((e.hisabClears || []).some((c) => c && c.id === id)) { console.log('already seeded', d.id, e.name); continue; }
    const entry = { id, seed: true, till: TILL, carry: 0, hours: 0, earned: 0, paid: 0, advIds: [], payKeys: [],
      note: 'Opening: loading hisab fully settled till 09-09-2026 (Anshul slip + owner balance)', by: 'claude-for-owner', at: new Date().toISOString() };
    console.log(DRY ? 'DRY would seed' : 'seeding', d.id, e.name);
    if (!DRY) await col.doc(d.id).update({ hisabClears: FieldValue.arrayUnion(entry) });
  }
  if (!DRY) {
    const after = await Promise.all(CODES.map((c) => col.doc(c).get()));
    after.forEach((d) => console.log('read-back', d.id, JSON.stringify((d.data().hisabClears || []).map((c) => c.till))));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
