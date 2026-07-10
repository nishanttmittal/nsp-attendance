// Clear the OLD advance ledger (owner 2026-07-10: "remove all old advance, I'll re-enter correct").
// Sets advances=[] and zeroes the carried advance balance for June+July (the unpaid/current months),
// so the owner re-enters correct current advances in the app. Paid history (earlier months) untouched.
// SAFE: DRY_RUN default. Backup + /tmp/advance_snapshot.json taken first. Recoverable.
const { db, FieldValue } = require('./lib/firestore');
const DRY = process.env.DRY_RUN !== 'false';
const CLEAR_MONTHS = ['2026-06', '2026-07'];

(async () => {
  const snap = await db().collection('att_salary').get();
  let changed = 0;
  for (const d of snap.docs) {
    const x = d.data();
    const hasAdv = (x.advances || []).length > 0;
    const monthsWithBal = CLEAR_MONTHS.filter(mk => { const m = (x.months || {})[mk]; return m && (m.advanceBalanceIn != null || m.advanceRecover != null || m.advanceBalanceCarried != null); });
    if (!hasAdv && monthsWithBal.length === 0) continue;
    // don't touch a month that's already PAID (locked history)
    const clearMonths = monthsWithBal.filter(mk => !((x.months || {})[mk] || {}).payment);
    const advSum = (x.advances || []).reduce((a, b) => a + Number(b.amount || 0), 0);
    if (DRY) { console.log(`DRY ${d.id} — ${(x.name||'').slice(0,22).padEnd(23)} advances[${(x.advances||[]).length}]=Rs${Math.round(advSum)} → [], clear balance in: ${clearMonths.join(',')||'(none)'}`); changed++; continue; }
    const patch = { advances: [], advancesClearedAt: new Date().toISOString() };
    if (clearMonths.length) { patch.months = {}; for (const mk of clearMonths) patch.months[mk] = { advanceBalanceIn: FieldValue.delete(), advanceRecover: FieldValue.delete(), advanceBalanceCarried: FieldValue.delete() }; }
    await d.ref.set(patch, { merge: true });
    changed++;
    console.log(`cleared ${d.id} — ${x.name || ''}`);
  }
  console.log(DRY ? `\n=== DRY — ${changed} workers would be cleared (nothing changed) ===`
                  : `\n=== DONE — cleared advances for ${changed} workers (recoverable: backup + /tmp/advance_snapshot.json) ===`);
})().catch(e => console.log('ERR', e.message));
