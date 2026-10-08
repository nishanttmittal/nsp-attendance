#!/usr/bin/env node
/**
 * FALCON one-time backfill (owner 08-10-2026 approval system): lines saved BEFORE the approval field existed carry no
 * `approval` → the app shows them as "Check baaki" and a Hisab final is blocked until each is OK'd. Sandeep's ~100 lines
 * were already checked by the owner against the diary, so mark them OK once (approvedBy 'system-backfill'), and give
 * every entry / transfer `hisab: null` so the worker's "open lines" query (hisab == null) finds them.
 *   node jobs/falcon-backfill-approval.js --dry   → counts only
 *   node jobs/falcon-backfill-approval.js         → writes (additive fields only; nothing deleted, no amounts touched)
 */
const { db } = require('./lib/firestore');
const DRY = process.argv.includes('--dry');
// Lines created AFTER the cut-over are the owner's / Anshul ji's to check — only older ones are auto-OK'd (audit P2-8).
// Default cut-over = the moment this script first ran; pass CUTOFF=2026-10-08T12:00:00+05:30 to pin it.
// Fixed, not "now": a later re-run must never widen the auto-OK window (security review 08-10).
const CUTOFF = new Date(process.env.CUTOFF || '2026-10-08T14:00:00+05:30');
(async () => {
  const base = db().collection('apps').doc('falcon');
  const [ents, trs, users] = await Promise.all([base.collection('entries').get(), base.collection('transfers').get(), base.collection('users').get()]);
  const role = Object.fromEntries(users.docs.map(d => [d.id, d.data().role]));
  let batch = db().batch(), n = 0, ok = 0, nul = 0, skipped = 0;
  // every write carries the snapshot's updateTime as a precondition: a line touched by a phone between read and write
  // (OK'd, cancelled, hisab-closed) makes that batch fail instead of being overwritten — re-run then picks up the rest
  const flush = async () => { if (n && !DRY) { try { await batch.commit(); } catch (e) { skipped += n; console.warn('batch skipped (changed meanwhile):', e.message.slice(0, 120)); } } batch = db().batch(); n = 0; };
  for (const d of ents.docs) {
    const e = d.data(); const patch = {};
    if (role[e.by] !== 'spender') { if (e.hisab === undefined) { batch.update(d.ref, { hisab: null }, { lastUpdateTime: d.updateTime }); n++; nul++; } continue; } // staff lines are OK by rule already
    const created = e.createdAt && e.createdAt.toDate ? e.createdAt.toDate() : new Date(e.clientAt || 0);
    if (e.approval === undefined && created < CUTOFF) { patch.approval = 'ok'; patch.approvedBy = 'system-backfill'; patch.approvedAt = new Date(); ok++; }
    else if (e.approval === undefined) { patch.approval = 'pending'; }   // saved by an old phone after cut-over → staff check it
    if (e.hisab === undefined) { patch.hisab = null; nul++; }           // never touches a line already closed (hisab set)
    if (Object.keys(patch).length) { batch.update(d.ref, patch, { lastUpdateTime: d.updateTime }); n++; if (n >= 50) await flush(); }
  }
  for (const d of trs.docs) { if (d.data().hisab === undefined) { batch.update(d.ref, { hisab: null }, { lastUpdateTime: d.updateTime }); n++; nul++; if (n >= 50) await flush(); } }
  await flush();
  console.log(`${DRY ? '[dry] ' : ''}cutoff ${CUTOFF.toISOString()} · entries ${ents.size} (approval→ok ${ok}) · transfers ${trs.size} · hisab:null added ${nul} · skipped (changed meanwhile) ${skipped} · roles ${JSON.stringify(role)}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
