// LOADER MONEY CHECK for the 20:15 evening digest (owner 23-10-2026: "create a cron to have automatic run").
// Read-only. Finds loader money that would NOT reach the 🚚 Loading hisab, so nothing is caught a week late by hand:
//   A. Falcon 👷 Labour line naming a FIXED loader or saying "advance" (not the extra-loader format) → should be 💵 Advance
//   B. extra-loader line OK'd in Falcon but missing from 🚚 Extra loaders (bridge did not land it)
//   C. extra-loader lines still waiting for Anshul ji's OK for more than a day (count only)
//   D. OK'd Advance-tile lines whose typed name matched no worker (bridge 'unmatched') — the money is NOT in
//      anyone's account. Owner 02-11-2026 ("yes fix"): ₹4,300 of loader advances sat like this 28–30 Oct because
//      the bridge's own alert goes by Telegram, which fails on the factory network. Repeats daily until fixed.
// A and B are listed ONCE (ids remembered with the digest state); C repeats daily while pending. Silent when clean.
const { db } = require('./lib/firestore');
const { parseXload, fixedLoaderNames } = require('./falconExtraBridge');

const FROM = process.env.LOADER_FROM || '2026-10-23';     // lines before this were checked by hand on 22-10
const ADV_WORD = /\badv|adavance|advance|एडव|अडव|ऐडव/i;
const norm = (s) => String(s || '').trim().toLowerCase();
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const dm = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}`;

async function loaderIssues(fdb = db(), seen = new Set(), today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)) {
  const [lab, sal, abc, adv] = await Promise.all([
    fdb.collection('apps').doc('falcon').collection('entries').where('kind', '==', 'labour').get(),
    fdb.collection('att_salary').where('dept', 'in', ['LOADING', 'Loading', 'loading']).get(),
    fdb.collection('att_salary').doc('MAN-LOADING-ABC').get(),
    fdb.collection('apps').doc('falcon').collection('entries').where('kind', '==', 'adv').get(),
  ]);
  const fixed = fixedLoaderNames(sal.docs);
  const landed = new Set(((abc.data() || {}).advances || []).filter((a) => a && a.falconId).map((a) => a.falconId));
  const wrong = [], missing = [], newIds = [];
  let pending = 0;
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  for (const d of lab.docs) {
    const e = d.data();
    if (e.status !== 'active' || !(e.date >= FROM)) continue;
    const x = parseXload(e.detail);
    const words = norm(e.detail).split(/[^a-zऀ-ॿ]+/).filter(Boolean);
    if (!x) {
      if ((ADV_WORD.test(e.detail || '') || words.some((w) => fixed.has(w))) && !seen.has(d.id)) {
        wrong.push(`${dm(e.date)} ${e.detail} ${inr(e.amount)}`); newIds.push(d.id);
      }
      continue;
    }
    if (fixed.has(norm(x.name).split(' ')[0])) continue;   // already stopped on screen; bridge skips it
    if (e.approval !== 'ok') { if (e.date < yday || (e.date === yday)) pending++; continue; }
    if (!landed.has(d.id) && !seen.has(d.id)) { missing.push(`${dm(e.date)} ${x.name} ${inr(e.amount)}`); newIds.push(d.id); }
  }
  const unmatched = [];
  for (const d of adv.docs) {
    const e = d.data();
    if (e.status !== 'active' || e.approval !== 'ok' || e.advStatus !== 'pending' || !e.advPush || !['unmatched', 'not-on-list'].includes(e.advPush.status)) continue;
    // "List mein nahi" lines (owner 02-11-2026) carry their type: gaadi / safai / bahar
    const nol = e.advPush.status === 'not-on-list' ? ` [list mein nahi: ${String((e.advFor && e.advFor.code) || '').slice(4)}]` : '';
    unmatched.push({ date: e.date || '', text: `${dm(e.date || '0000-00-00')} ${(e.advFor && e.advFor.name) || e.detail || '?'} ${inr(e.amount)}${nol}`, amt: Number(e.amount) || 0 });
  }
  unmatched.sort((a, b) => a.date.localeCompare(b.date));
  const L = [];
  if (unmatched.length) {
    L.push(`💵 Falcon advance kisi account mein NAHI gaya (owner decide kare): ${unmatched.length} · ${inr(unmatched.reduce((t, u) => t + u.amt, 0))}`);
    unmatched.forEach((u) => L.push('  ' + u.text));
    L.push('  → Claude ko batao kiska hai, ya Falcon mein "Attendance mein daal diya" dabao');
  }
  if (wrong.length) { L.push(`🚚 Labour tile pe loader ka paisa (Advance mein hona chahiye): ${wrong.length}`); wrong.forEach((l) => L.push('  ' + l)); }
  if (missing.length) { L.push(`🚚 Extra loader Attendance mein nahi aaya: ${missing.length}`); missing.forEach((l) => L.push('  ' + l)); }
  if (pending) L.push(`🚚 Extra loader OK baaki (Anshul ji): ${pending} line`);
  return { lines: L, newIds };
}
module.exports = { loaderIssues };
if (require.main === module) loaderIssues().then((r) => { console.log(r.lines.join('\n') || '(clean — nothing to report)'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
