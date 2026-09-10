/**
 * Welder → Plating re-sync, run from the server (admin SDK).
 *
 * Exact replica of the app's "Re-sync to Plating" tile
 * (welder/src/modules/welder/pages/ResyncPlating.jsx + core/db/firebase.js
 * pushPlatingIncoming): re-pushes chrome/gold/rose welder challans dated on or
 * after PLATING_SYNC_FROM into apps/platingjobwork/incoming as `feed_<code>`,
 * and SKIPS any id already there so an accepted/rejected incoming is never
 * reverted to pending. Idempotent — safe to run twice.
 *
 * Exists because the in-app tile has been failing (PLATING_SYNC_FAIL logs since
 * 06-Sep, almost certainly Firestore quota on the Spark plan) and the challans
 * were sitting unsynced with material already physically gone out.
 *
 * Run:  node resyncPlating.js            # dry run — lists what WOULD be pushed
 *       node resyncPlating.js --commit   # writes
 */
const { db } = require('./lib/firestore');

const COMMIT = process.argv.includes('--commit');
const PLATING_SYNC_FROM = '2026-06-01';
const PLATING_FINISHES = ['chrome', 'gold', 'rosegold'];
const SOURCE_APP = 'welder';
const num = (v) => Number(v) || 0;

(async () => {
  const w = db().collection('apps').doc('welder');
  const p = db().collection('apps').doc('platingjobwork');
  const [disp, prods, inc] = await Promise.all([
    w.collection('dispatches').get(), w.collection('products').get(), p.collection('incoming').get(),
  ]);
  const existing = new Set(inc.docs.map(d => d.id));
  const noPlating = new Set(prods.docs.map(d => d.data()).filter(x => x.noPlating).map(x => x.name));

  const byCode = {};
  for (const d of disp.docs.map(x => x.data())) {
    if (d.payBasis === 'final-dispatch') continue;
    if (!PLATING_FINISHES.includes(d.finish) || !d.welderChallan || num(d.qty) <= 0 || (d.date || '') < PLATING_SYNC_FROM) continue;
    if (noPlating.has(d.productName)) continue;
    (byCode[d.welderChallan] ||= []).push(d);
  }

  const todo = [];
  for (const [code, ds] of Object.entries(byCode)) {
    if (existing.has(`feed_${code}`)) continue;
    ds.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const first = ds[0];
    todo.push({
      id: `feed_${code}`, status: 'pending', date: first.date, party: first.party, gaadi: first.gaadi || '',
      items: ds.map(d => ({ product: d.productName, quantity: num(d.qty) })),
      welderChallanNo: code, linkedChallanId: code, batchId: first.batchId || '',
      sourceApp: SOURCE_APP, destinationApp: 'platingjobwork', parentTransactionId: '',
      createdAt: first.updatedAt || new Date().toISOString(), createdBy: first.welder || 'welder',
    });
  }
  todo.sort((a, b) => (a.date + a.welderChallanNo).localeCompare(b.date + b.welderChallanNo));

  console.log(`\n=== WELDER → PLATING RE-SYNC — ${COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)'} ===`);
  console.log(`eligible challans: ${Object.keys(byCode).length} · already in plating: ${Object.keys(byCode).length - todo.length} · TO PUSH: ${todo.length}\n`);
  for (const r of todo) {
    const qty = r.items.reduce((s, i) => s + i.quantity, 0);
    console.log(`  ${r.welderChallanNo.padEnd(9)} ${r.date}  → ${String(r.party).padEnd(22)} gaadi ${String(r.gaadi || '-').slice(-6).padEnd(6)}  ${r.items.length} item/s, qty ${qty}`);
    r.items.forEach(i => console.log(`        · ${i.product} × ${i.quantity}`));
  }
  if (!todo.length) { console.log('  Nothing to push — plating already has everything.\n'); process.exit(0); }
  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to push.\n'); process.exit(0); }

  let n = 0;
  for (const r of todo) { await p.collection('incoming').doc(r.id).set(r, { merge: true }); n++; }
  const now = new Date().toISOString();
  const id = `r_${Date.now().toString(36)}_1`;
  await w.collection('logs').doc(id).set({ id, ts: now, action: 'RESYNC_PLATING',
    detail: `re-synced ${n} challan/s (server script, in-app tile was failing)`, by: 'Owner', ref: '' });
  console.log(`\n✅ PUSHED ${n} challan/s into plating incoming.\n`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
