// Fix / undo a worker's PART payments for a month (owner 2026-07-10 split-pay feature).
// Use when a part payment was mistyped (e.g. ₹50,000 instead of ₹5,000) and needs correcting.
// Only touches a month whose hisab is NOT yet fully closed (no md.payment); a fully-settled
// month is history — reopen it via the normal settlement flow instead, not this.
//
// Resets months[MONTH].payments=[] and paidSoFar=0 for the given worker, so the owner can
// re-enter the correct part(s) in the app. SAFE: DRY_RUN default, prints before/after.
//
//   node jobs/clearPayments.js CODE MONTH            # dry run (shows what it would clear)
//   DRY_RUN=false node jobs/clearPayments.js CODE MONTH   # actually clear
// e.g.  DRY_RUN=false node jobs/clearPayments.js 00000079 2026-06
const { db } = require('./lib/firestore');
const DRY = process.env.DRY_RUN !== 'false';
const [, , CODE, MONTH] = process.argv;

(async () => {
  if (!CODE || !MONTH) { console.error('usage: node jobs/clearPayments.js CODE YYYY-MM'); process.exit(1); }
  const ref = db().collection('att_salary').doc(CODE);
  const snap = await ref.get();
  if (!snap.exists) { console.error('no employee ' + CODE); process.exit(1); }
  const e = snap.data();
  const md = (e.months || {})[MONTH] || {};
  const parts = Array.isArray(md.payments) ? md.payments : [];
  const paidSoFar = Number(md.paidSoFar || 0);
  console.log(`${e.name || CODE} · ${MONTH}: ${parts.length} part(s), Rs${Math.round(paidSoFar)} paid so far`);
  parts.forEach((p, i) => console.log(`  #${i + 1} ${p.date} ${p.mode} Rs${p.amount}${p.remark ? ' · ' + p.remark : ''}`));
  if (md.payment) { console.error('This month is FULLY PAID / closed — use the settlement flow to reopen, not this script.'); process.exit(1); }
  if (!parts.length && !paidSoFar) { console.log('Nothing to clear.'); process.exit(0); }
  if (DRY) { console.log('DRY RUN — set DRY_RUN=false to actually clear these part payments back to zero.'); process.exit(0); }
  const months = { ...(e.months || {}) };
  months[MONTH] = { ...md, payments: [], paidSoFar: 0 };
  await ref.set({ months }, { merge: true });
  console.log('CLEARED — part payments reset. Re-enter the correct amount in the app.');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
