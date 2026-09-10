/**
 * ONE-OFF (2026-09-09, owner-approved): close Raju's welder hisab for Jun/Jul/Aug 2026.
 *
 * Owner confirmed: Raju is off contract work, and the ₹34,120 he earned was paid
 * to him IN CASH but never entered in the app (0 payments / 0 ledger / 0 settlements).
 * So we (a) record the three cash payments and (b) finalize the three months, each
 * landing at net ₹0. Under the hisab-driven entry lock this also stops anyone
 * back-dating new Raju entries. Reopen a month in Hisab if he ever returns.
 *
 * WHY NOT THE APP'S OWN FINALIZE: Hisab.finalize() hardcodes `cutoff = todayStr()`.
 * Finalizing June today would stamp cutoffDate 2026-09-09, and June's payment window
 * (lowerCut..advUpper) would then swallow the July AND August payments too — all the
 * money would land in June and July/Aug would finalize wrong. Closing BACK-months
 * needs month-end cutoffs, which the UI cannot express. Hence this script.
 *
 * Run:  node closeRajuHisab.js            # dry run, prints everything, writes nothing
 *       node closeRajuHisab.js --commit   # writes (single atomic batch)
 */
const { db } = require('./lib/firestore');

const COMMIT = process.argv.includes('--commit');
const W = 'Raju';
const BY = 'Owner';
const REMARK = 'Cash paid outside app - recorded 09-Sep-2026 on owner confirmation';
const MONTHS = [
  { m: '2026-06', end: '2026-06-30' },
  { m: '2026-07', end: '2026-07-31' },
  { m: '2026-08', end: '2026-08-31' },
];

const num = (v) => Number(v) || 0;
const rProduct = (r) => r.productName || r.product || '';
const rProcess = (r) => r.process || 'welding';
const applies = (r, p, proc, d) => r.isActive !== false && rProcess(r) === proc && rProduct(r) === p &&
  (!r.effectiveFrom || r.effectiveFrom <= d) && (!r.effectiveTo || d <= r.effectiveTo);
const latestFirst = (a, b) => (b.effectiveFrom || '').localeCompare(a.effectiveFrom || '') ||
  (b.createdAt || '').localeCompare(a.createdAt || '');
function rateOn(rates, p, contractor, date, proc = 'welding') {
  const pool = rates.filter(r => applies(r, p, proc, date));
  const sp = pool.filter(r => r.contractor && r.contractor === contractor).sort(latestFirst)[0];
  if (sp) return num(sp.rate);
  const c = pool.filter(r => !r.contractor).sort(latestFirst)[0];
  return c ? num(c.rate) : 0;
}
const SLIP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const slipSuffix = (n = 6) => Array.from({ length: n },
  () => SLIP_ALPHABET[Math.floor(Math.random() * SLIP_ALPHABET.length)]).join('');
const money = (n) => '₹' + n.toLocaleString('en-IN');
let _seq = 0;
const makeId = (p = 'r') => `${p}_${Date.now().toString(36)}_${++_seq}`;

(async () => {
  const root = db().collection('apps').doc('welder');
  const [disp, rates, prods, pays, setl, led] = await Promise.all([
    root.collection('dispatches').get(), root.collection('rates').get(), root.collection('products').get(),
    root.collection('payments').get(), root.collection('settlements').get(), root.collection('ledger').get(),
  ]);
  const R = rates.docs.map(d => d.data());
  const ref = new Set(prods.docs.map(d => d.data()).filter(p => p.referenceOnly).map(p => p.name));
  const P = pays.docs.map(d => d.data());
  const S = setl.docs.map(d => d.data());
  const L = led.docs.map(d => d.data());

  // ---- GUARDS: refuse to run if the world is not what we were told ----------
  const fail = (m) => { console.error('\n⛔ ABORT —', m); process.exit(1); };
  if (S.some(s => s.welder === W)) fail(`${W} already has ${S.filter(s => s.welder === W).length} settlement(s). Nothing written.`);
  if (P.some(p => p.contractor === W && !p.reversed)) fail(`${W} already has payment rows. Nothing written.`);
  if (L.some(e => e.contractor === W && !e.reversed)) fail(`${W} already has ledger rows — opening/advances would change the maths. Nothing written.`);

  // ---- recompute earned per month from live data (never hardcode money) -----
  const rows = disp.docs.map(d => d.data()).filter(r => r.welder === W && num(r.qty) > 0 && !ref.has(r.productName));
  const earnedBy = {};
  for (const r of rows) earnedBy[r.date.slice(0, 7)] = (earnedBy[r.date.slice(0, 7)] || 0) + num(r.qty) * rateOn(R, r.productName, W, r.date);
  const stray = Object.keys(earnedBy).filter(m => !MONTHS.some(x => x.m === m));
  if (stray.length) fail(`${W} has production in un-handled month(s): ${stray.join(', ')}. Extend MONTHS first.`);

  let maxSlip = 0;
  for (const p of P) { const m = /UMP-PAY-(\d+)/.exec(p.paymentSlipNo || ''); if (m) maxSlip = Math.max(maxSlip, num(m[1])); }

  const now = new Date().toISOString();
  const writes = [];
  let opening = 0, total = 0;
  console.log(`\n=== CLOSE ${W}'s HISAB — ${COMMIT ? 'COMMIT' : 'DRY RUN (nothing will be written)'} ===\n`);
  for (const { m, end } of MONTHS) {
    const earned = Math.round((earnedBy[m] || 0) * 100) / 100;
    const paid = earned;                    // owner: paid in full, in cash
    const net = opening + earned - paid;    // net = opening + debits - credits
    const slip = `UMP-PAY-${String(++maxSlip).padStart(4, '0')}-${slipSuffix()}`;
    const payRow = { id: makeId('r'), createdAt: now, updatedAt: now,
      paymentSlipNo: slip, contractor: W, amount: paid, paymentMode: 'Cash', remark: REMARK,
      paymentDate: end, paidByUser: '', paidByRole: 'owner', reversed: false, date: end, note: REMARK };
    const setRow = { id: makeId('r'), createdAt: now, updatedAt: now,
      welder: W, month: m, periodFrom: `${m}-01`, periodTo: end, cutoffDate: end,
      opening, earned, advances: 0, payments: paid, dayPayment: 0, net, finalizedBy: BY, locked: true };
    writes.push({ coll: 'payments', rec: payRow }, { coll: 'settlements', rec: setRow });
    console.log(`${m}  opening ${money(opening)} + earned ${money(earned)} - paid ${money(paid)} = NET ${money(net)}`);
    console.log(`      payment ${slip}  ${money(paid)} Cash dated ${end}`);
    console.log(`      settlement cutoffDate ${end}  locked=true  by=${BY}`);
    opening = net; total += paid;
    if (net !== 0) console.log(`      ⚠️  net is NOT zero — check before committing`);
  }
  console.log(`\nTOTAL cash recorded: ${money(total)}   final carry-forward: ${money(opening)}`);
  console.log(`Docs to write: ${writes.length} (3 payments + 3 settlements), one atomic batch.`);

  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to write.\n'); process.exit(0); }

  const batch = db().batch();
  for (const w of writes) batch.set(root.collection(w.coll).doc(w.rec.id), w.rec);
  const logId = makeId('r');
  batch.set(root.collection('logs').doc(logId), { id: logId, ts: now,
    action: 'SETTLEMENT_FINALIZE',
    detail: `${W} Jun+Jul+Aug 2026 closed by script · ${money(total)} cash recorded · net ₹0 · contractor off-boarded`,
    by: BY, ref: '' });
  await batch.commit();
  console.log('\n✅ WRITTEN (atomic). Raju Jun/Jul/Aug are finalized, net ₹0, entry now locked.\n');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
