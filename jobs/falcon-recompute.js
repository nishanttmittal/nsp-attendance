#!/usr/bin/env node
/**
 * FALCON balance check (READ ONLY). Rebuilds every person's received/spent from the active records in
 * apps/falcon/{entries,transfers} and compares with apps/falcon/balances/{email}. Any difference = a bug.
 *   node jobs/falcon-recompute.js          → prints a table; exit 1 if anything differs
 * Never writes. Run after every Falcon deploy and nightly.
 */
const { db } = require('./lib/firestore')

;(async () => {
  const base = db().collection('apps').doc('falcon')
  const [ents, trs, bals] = await Promise.all(['entries', 'transfers', 'balances'].map(c => base.collection(c).get()))
  const want = {}
  const row = (e) => (want[e] = want[e] || { received: 0, spent: 0 })
  trs.forEach(d => {
    const t = d.data(); if (t.status === 'cancelled') return
    row(t.to).received += t.kind === 'return' ? -t.amount : t.amount
    // the giver's side: worker → worker hand-over, or Anshul ji's give / wapas (fromBal)
    if (t.kind === 'hand' || t.fromBal === true) row(t.givenBy).received -= t.kind === 'return' ? -t.amount : t.amount
  })
  ents.forEach(d => { const e = d.data(); if (e.status === 'cancelled') return; row(e.by).spent += e.amount })
  let bad = 0
  const seen = new Set()
  bals.forEach(d => {
    seen.add(d.id)
    const b = d.data(), w = want[d.id] || { received: 0, spent: 0 }
    const ok = (b.received || 0) === w.received && (b.spent || 0) === w.spent
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${d.id.padEnd(34)} received ${b.received || 0}/${w.received}  spent ${b.spent || 0}/${w.spent}  in hand ${(b.received || 0) - (b.spent || 0)}`)
  })
  for (const e of Object.keys(want)) if (!seen.has(e)) { bad++; console.log(`✗ ${e} has records but no balance doc`, want[e]) }
  console.log(`\n${ents.size} entries · ${trs.size} transfers · ${bals.size} balances · ${bad ? '🔴 ' + bad + ' MISMATCH' : '✅ all balances match their records'}`)
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e.message); process.exit(2) })
