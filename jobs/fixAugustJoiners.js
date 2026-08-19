// FOLLOW-UP to attributeJulyAdvances (owner verify 15-08-2026): 6 of the 11 migrated workers have
// ZERO July attendance — they joined in August, so their advances are AUGUST advances. The blanket
// migration moved them to July only because their joinDate field was empty. This flips their
// Aug-dated advances back to mk=2026-08 and sets joinDate=2026-08-01 (their portal attendance counts
// from 1 Aug) so month attribution can never mis-file them again. The other 5 (real July workers)
// are untouched. DRY run by default; DRY_RUN=false applies.
const { db } = require('./lib/firestore');

const CODES = ['00000071', '00000073', '00000082', '00000102', '00000103', '00000104'];
const DRY = process.env.DRY_RUN !== 'false';

(async () => {
  for (const code of CODES) {
    const ref = db().collection('att_salary').doc(code);
    if (DRY) {
      const s = await ref.get();
      const e = s.data() || {};
      const hits = (e.advances || []).filter((a) => a.mk === '2026-07' && String(a.date || '').startsWith('2026-08'));
      console.log(`[DRY] ${code} ${e.name || ''}: ${hits.map((a) => `${a.date} ₹${a.amount}`).join(', ') || 'nothing to flip'} -> mk=2026-08 + joinDate=2026-08-01`);
      continue;
    }
    await db().runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const e = s.data() || {};
      const advances = (e.advances || []).map((a) =>
        (a.mk === '2026-07' && String(a.date || '').startsWith('2026-08')) ? { ...a, mk: '2026-08' } : a);
      tx.update(ref, { advances, joinDate: e.joinDate || '2026-08-01' });
    });
    console.log(`${code}: flipped to mk=2026-08, joinDate set`);
  }
  console.log(DRY ? 'DRY done' : 'APPLIED');
})().catch((e) => { console.error(e.message); process.exit(1); });
