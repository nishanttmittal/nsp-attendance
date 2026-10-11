// Load one month's PF figures (from the consultant's salary register) onto the workers' records, so the
// app can show "PF deposited for you" (owner 2026-10-11). Writes ONLY att_salary/{code}.pf[month] =
// { days, wage, ee, er, source, at } with merge — nothing about pay, attendance or month locks is touched.
//   FILE=pf/2026-09.json DRY=true|false node setPfMonth.js
const fs = require('fs'); const path = require('path');
const { db } = require('./lib/firestore');
const DRY = process.env.DRY !== 'false';
(async () => {
  const file = path.resolve(__dirname, process.env.FILE || '');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^\d{4}-\d{2}$/.test(j.month || '')) throw new Error('month YYYY-MM required in file');
  const col = db().collection('att_salary'); const before = {}; let ee = 0, er = 0;
  for (const r of j.rows) {
    const snap = await col.doc(r.code).get();
    if (!snap.exists) throw new Error(`no att_salary record ${r.code} (${r.name})`);
    for (const k of ['days', 'wage', 'ee', 'er']) if (!(Number(r[k]) >= 0)) throw new Error(`bad ${k} for ${r.code}`);
    before[r.code] = (snap.data().pf || null);
    ee += r.ee; er += r.er;
    console.log(r.code, (snap.data().name || '').padEnd(26), '←', r.name.padEnd(18), `days ${r.days} wage ${r.wage} ee ${r.ee} er ${r.er} total ${r.ee + r.er}`);
  }
  console.log(`${j.month}: ${j.rows.length} workers, employee ₹${ee} + employer ₹${er} = ₹${ee + er}`);
  if (DRY) { console.log('DRY — not written'); return process.exit(0); }
  const bk = path.resolve(__dirname, 'rules_backup', `pf-before-${j.month}-${Date.now()}.json`);
  fs.writeFileSync(bk, JSON.stringify(before, null, 1)); console.log('backup', bk);
  const at = new Date().toISOString();
  for (const r of j.rows) {
    await col.doc(r.code).set({ pf: { [j.month]: { days: r.days, wage: r.wage, ee: r.ee, er: r.er, source: j.source || '', at } } }, { merge: true });
  }
  let ok = 0; for (const r of j.rows) { const p = ((await col.doc(r.code).get()).data().pf || {})[j.month]; if (p && p.ee === r.ee && p.er === r.er) ok++; }
  console.log(`written, read back OK: ${ok}/${j.rows.length}`);
  process.exit(ok === j.rows.length ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
