// One-shot audit for the 19-08-2026 advance questions (owner: "check all against live data").
// READ-ONLY — makes no writes, changes nothing. Safe to run any number of times.
//   node jobs/verifyAdvanceState.js
// Answers, against LIVE Firestore:
//   1. who ate the read quota (usage_reads today + yesterday)
//   2. are the 7 previously-unsettled workers now locked, and what does the Advances tab show for them
//   3. are the 6 August joiners still mis-attributed into July (the pending fixAugustJoiners work)
//   4. does any LOCKED worker's advance figure differ between the old and new balance basis (must be 0)
const { db } = require('./lib/firestore');

const OPEN7 = ['00000004', '00000076', '00000077', '00000090', '00000168', '00000172', '00000307'];
const JOINERS6 = ['00000071', '00000073', '00000082', '00000102', '00000103', '00000104'];
const advMk = (a) => a.mk || String(a.date || '').slice(0, 7);
const nextMonthKey = (mk) => {
  const d = new Date(Date.UTC(Number(String(mk).slice(0, 4)), Number(String(mk).slice(5, 7)), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

// NEW basis (shipped 19-08): start at the last lock's closing balance, count every advance since.
function statement(e) {
  const M = e.months || {};
  const lockedMks = Object.keys(M).filter((m) => (M[m] || {}).locked).sort();
  const bfMonth = lockedMks[lockedMks.length - 1] || '';
  const bf = bfMonth ? Number((M[nextMonthKey(bfMonth)] || {}).openingBalance || 0) : 0;
  const entries = (e.advances || []).filter((a) => !bfMonth || advMk(a) > bfMonth)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return { bfMonth, bf, entries, since: entries.reduce((t, a) => t + Number(a.amount || 0), 0) };
}
// OLD basis, for the regression check only.
function oldBasis(e, cur) {
  const bf = Number(((e.months || {})[cur] || {}).openingBalance || 0);
  const adv = (e.advances || []).filter((a) => String(a.date || '').startsWith(cur))
    .reduce((t, a) => t + Number(a.amount || 0), 0);
  return Math.round(-bf + adv);
}

(async () => {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const cur = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
  const today = ist.toISOString().slice(0, 10);
  const yst = new Date(ist.getTime() - 86400000).toISOString().slice(0, 10);

  console.log(`=== ADVANCE STATE AUDIT — ${ist.toISOString().slice(0, 16)} IST · month ${cur} ===\n`);

  // 1. read-quota attribution
  console.log('--- 1. READ QUOTA (who ate it) ---');
  for (const day of [today, yst]) {
    const s = await db().collection('usage_reads').doc(day).get();
    if (!s.exists) { console.log(`  ${day}: no meter data`); continue; }
    const t = s.data().totals || {};
    const rows = Object.entries(t).sort((a, b) => b[1] - a[1]);
    const sum = rows.reduce((x, r) => x + Number(r[1] || 0), 0);
    console.log(`  ${day}: TOTAL ${sum.toLocaleString('en-IN')} / 50,000`);
    rows.slice(0, 12).forEach(([k, v]) => console.log(`      ${String(k).padEnd(22)} ${String(v).padStart(8)}`));
  }

  const snap = await db().collection('att_salary').get();
  const emps = {}; snap.forEach((d) => { emps[d.id] = d.data(); });
  const balDoc = await db().collection('att_meta').doc('advance_balances').get();
  const mirror = (balDoc.exists && balDoc.data().items) || {};
  const mirrorMonth = balDoc.exists ? balDoc.data().month : '?';
  const mirrorAt = balDoc.exists ? balDoc.data().updatedAt : '?';

  // 2. the 7 that were unsettled on 17-08
  console.log(`\n--- 2. THE 7 PREVIOUSLY-UNSETTLED WORKERS (owner locked them evening 18-08?) ---`);
  for (const c of OPEN7) {
    const e = emps[c]; if (!e) { console.log(`  ${c} MISSING`); continue; }
    const jul = (e.months || {})['2026-07'] || {};
    const st = statement(e);
    console.log(`  ${c} ${(e.name || '').slice(0, 20).padEnd(21)} July ${jul.locked ? 'LOCKED  paid ' + inr(jul.payment?.net || 0) : 'STILL OPEN'}`
      + ` | lastLock ${(st.bfMonth || 'never').padEnd(8)} | carried ${inr(-st.bf).padStart(9)} | adv since ${inr(st.since).padStart(8)} | tab ${inr(-st.bf + st.since)}`);
  }

  // 3. August joiners still mis-filed into July?
  console.log(`\n--- 3. AUGUST JOINERS mis-attributed to July (pending fixAugustJoiners) ---`);
  let bad = 0, badAmt = 0;
  for (const c of JOINERS6) {
    const e = emps[c]; if (!e) { console.log(`  ${c} MISSING`); continue; }
    const hits = (e.advances || []).filter((a) => a.mk === '2026-07' && String(a.date || '').startsWith('2026-08'));
    const jul = (e.months || {})['2026-07'] || {};
    const amt = hits.reduce((t, a) => t + Number(a.amount || 0), 0);
    bad += hits.length; badAmt += amt;
    console.log(`  ${c} ${(e.name || '').slice(0, 20).padEnd(21)} joinDate ${(e.joinDate || 'NONE').padEnd(10)}`
      + ` | July ${jul.locked ? 'LOCKED ⚠' : 'open'} | wrong-month advances: ${hits.length ? hits.map((a) => a.date + ' ' + inr(a.amount)).join(', ') : 'none ✓'}`);
  }
  console.log(`  → ${bad} advances totalling ${inr(badAmt)} still filed in July.`);
  console.log(`  → fix is SAFE only while those workers' July is UNLOCKED; if any shows LOCKED ⚠, do NOT run it — ask first.`);

  // 4. regression: locked workers must be identical on both bases
  console.log(`\n--- 4. REGRESSION: old vs new balance basis ---`);
  let same = 0, expected = 0, unexplained = 0; const exp = [], odd = [];
  for (const [c, e] of Object.entries(emps)) {
    if (e.active === false) continue;
    const st = statement(e);
    const nu = Math.round(-st.bf + st.since);
    const old = oldBasis(e, cur);
    const prevLocked = !!((e.months || {})[st.bfMonth] || {}).locked
      && st.bfMonth === Object.keys(e.months || {}).filter((m) => m < cur).sort().pop();
    if (!prevLocked) continue;
    if (nu === old) { same++; continue; }
    // A difference is EXPECTED — and is the whole point of the fix — when the worker has advances
    // DATED in the running month but ATTRIBUTED (mk) to the month that is already locked. Those were
    // settled inside that lock; the old date-based basis counted them a second time here. That double
    // count is exactly what the owner reported as "old month advance still shown in new month".
    const settledButLaterDated = (e.advances || [])
      .filter((a) => advMk(a) <= st.bfMonth && String(a.date || '').slice(0, 7) === cur)
      .reduce((t, a) => t + Number(a.amount || 0), 0);
    if (settledButLaterDated > 0 && Math.round(old - nu) === Math.round(settledButLaterDated)) {
      expected++; exp.push([c, e.name, old, nu, settledButLaterDated]);
    } else { unexplained++; odd.push([c, e.name, old, nu]); }
  }
  console.log(`  settled-through-last-month workers: ${same} identical · ${expected} corrected · ${unexplained} unexplained`);
  exp.forEach(([c, n, o, nu, amt]) => console.log(`    ✓ ${c} ${n}: ${inr(o)} → ${inr(nu)} (drops ${inr(amt)} already settled in the ${'lock'})`));
  odd.forEach(([c, n, o, nu]) => console.log(`    ⚠ ${c} ${n}: old ${inr(o)} vs new ${inr(nu)} — NOT explained by already-settled advances`));
  console.log(unexplained === 0
    ? '  ✓ every difference is a corrected double-count; no settled worker moved unexpectedly'
    : '  ⚠ INVESTIGATE the unexplained rows before trusting the tab');

  // 5. mirror freshness (the collapsed row figures come from here)
  console.log(`\n--- 5. MIRROR (att_meta/advance_balances) ---`);
  console.log(`  month ${mirrorMonth} · updated ${mirrorAt} · ${Object.keys(mirror).length} workers`);
  let stale = 0;
  for (const [c, e] of Object.entries(emps)) {
    if (e.active === false) continue;
    const st = statement(e);
    if (Math.round(-st.bf + st.since) !== Math.round(mirror[c]?.totalOwed || 0)) stale++;
  }
  console.log(stale === 0
    ? '  ✓ mirror matches the new basis — queue worker has rewritten it'
    : `  ⏳ ${stale} workers differ — queue worker has NOT yet rewritten the mirror on the new basis (collapsed rows still old; tapping a row is correct)`);
  console.log('\n=== END (read-only, nothing changed) ===');
})().catch((e) => {
  if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test(e.message)) {
    console.error('READ QUOTA STILL EXHAUSTED — free tier resets ~12:30 PM IST. Nothing was read.');
    process.exit(2);
  }
  console.error('FAILED:', e.message); process.exit(1);
});
