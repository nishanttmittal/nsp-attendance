// ONE-TIME MIGRATION (owner rule 13-08-2026): advances handed out in Aug-2026 BEFORE July was locked
// belong to July. Stamps mk='2026-07' on every un-stamped advance dated 2026-08-* for workers whose
// 2026-07 month is not yet locked/paid (and who existed in July). Workers whose July is already
// locked are left alone — their money settled under the old date rule and re-stamping would
// double-count. Backs up every doc it changes. DRY run by default; DRY_RUN=false node attributeJulyAdvances.js
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');

const OLD = '2026-07', NEW_PREFIX = '2026-08';
const DRY = process.env.DRY_RUN !== 'false';

(async () => {
  const snap = await db().collection('att_salary').get();
  const backup = {}; const plan = []; const dupes = [];
  for (const d of snap.docs) {
    const e = d.data();
    // DOUBLE-ENTRY CHECK (owner 14-08): while the advance seemed "not to show" he may have tapped
    // again — each tap mints a fresh id, so system dedupe can't catch a human re-tap. Flag any
    // same-day same-amount same-mode pairs among recent (Jul/Aug 2026) advances. REPORT ONLY.
    {
      const seen = {};
      for (const a of (e.advances || [])) {
        const dt = String(a.date || '');
        if (!(dt.startsWith('2026-07') || dt.startsWith('2026-08'))) continue;
        const k = dt + '|' + Number(a.amount || 0) + '|' + (a.mode || '');
        if (seen[k]) dupes.push({ code: d.id, name: e.name || '', date: dt, amount: a.amount, mode: a.mode || '', by: a.paidBy || '' });
        seen[k] = true;
      }
    }
    const md = (e.months || {})[OLD] || {};
    if (md.locked || md.payment) continue;                       // July settled → Aug advances stay Aug
    const joined = String(e.joinDate || '').slice(0, 7);
    if (joined && joined > OLD) continue;                        // joined after July → nothing to settle
    const advs = e.advances || [];
    const hits = advs.filter((a) => !a.mk && String(a.date || '').startsWith(NEW_PREFIX));
    if (!hits.length) continue;
    backup[d.id] = advs;
    plan.push({ code: d.id, name: e.name || '', hits: hits.map((a) => `${a.date} ₹${a.amount}`) });
    if (!DRY) {
      await db().runTransaction(async (tx) => {                  // re-read inside the txn — a manager's
        const ref = db().collection('att_salary').doc(d.id);     // concurrent arrayUnion must not be lost
        const s = await tx.get(ref);
        const cur = (s.data() || {}).advances || [];
        tx.update(ref, { advances: cur.map((a) => (!a.mk && String(a.date || '').startsWith(NEW_PREFIX)) ? { ...a, mk: OLD } : a) });
      });
    }
  }
  if (Object.keys(backup).length) {
    const f = path.join(__dirname, 'rules_backup', `advances-before-mk-migration-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(backup, null, 2));
    console.log('backup:', f);
  }
  for (const p of plan) console.log(`${DRY ? '[DRY] ' : ''}${p.code} ${p.name}: ${p.hits.join(', ')} -> mk=${OLD}`);
  console.log(`${DRY ? 'WOULD stamp' : 'STAMPED'} ${plan.reduce((s, p) => s + p.hits.length, 0)} advances on ${plan.length} workers`);
  if (dupes.length) {
    console.log('\n⚠ POSSIBLE DOUBLE ENTRIES (same worker+date+amount+mode — owner to confirm, nothing auto-deleted):');
    for (const x of dupes) console.log(`  ${x.code} ${x.name}: ${x.date} ₹${x.amount} ${x.mode} (by ${x.by})`);
  } else {
    console.log('\n✓ no duplicate advances found in Jul/Aug 2026');
  }
})().catch((e) => { console.error(e); process.exit(1); });
