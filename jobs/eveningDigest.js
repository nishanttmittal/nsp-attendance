// EVENING DIGEST — one short WhatsApp message at 20:15 (owner 07-10-2026: "very simple report";
// "welder and chrome item name should also be mentioned along with qty"). Replaces the separate
// welder-production + plating-summary messages. Read-only on welder/plating/salary data.
// DRY=1 prints instead of sending. DATE=YYYY-MM-DD for a past day.
const { db } = require('./lib/firestore');
const { sendPlain: sendTelegram } = require('./lib/notify'); // plain text: WA as-is, Telegram escaped
const { istToday } = require('./lib/opsdate');
const { inr, num, dmy } = require('./lib/simple');

async function weldingLines(fdb, day) {
  const [snap, rs] = await Promise.all([
    fdb.collection('apps/welder/dispatches').where('date', '==', day).get(),
    fdb.collection('apps/welder/rates').where('process', '==', 'welding').get(),
  ]);
  const rates = {}; rs.forEach(d => { const r = d.data(); if (r.isActive) rates[r.productName] = Number(r.rate) || 0; });
  const by = {};
  snap.forEach(d => { const c = d.data(); const w = c.welder || '—'; const q = Number(c.qty) || 0;
    const e = by[w] || (by[w] = { qty: 0, pay: 0, items: {} }); e.qty += q; e.pay += q * (rates[c.productName] || 0);
    const pn = c.finishedName || c.productName || '—'; e.items[pn] = (e.items[pn] || 0) + q; });
  const lines = [];
  for (const [w, e] of Object.entries(by).sort((a, b) => b[1].qty - a[1].qty)) {
    const items = Object.entries(e.items).sort((a, b) => b[1] - a[1]).map(([p, q]) => `${p} ${num(q)}`).join(', ');
    lines.push(`${w}: ${items}${e.pay ? ` · ${inr(e.pay)}` : ''}`);
  }
  return lines;
}
async function platingLines(fdb, day) {
  const snap = await fdb.collection('apps/platingjobwork/challans').where('date', '==', day).get();
  const out = [], inn = [];
  snap.forEach(d => { const c = d.data(); const items = (Array.isArray(c.items) ? c.items : []).map(it => `${it.product || '—'} ${num(it.quantity)}`).join(', ');
    (c.direction === 'in' ? inn : out).push(`${c.party || '—'}: ${items}`); });
  const lines = [];
  for (const l of out) lines.push(`→ sent ${l}`);
  for (const l of inn) lines.push(`← back ${l}`);
  return lines;
}
// Advances + salary locks since the last digest (owner 13-10-2026: "at end of day one list of advance sent
// to my whatsapp" — the one-by-one advance / locked alerts now go to Telegram only). An advance is listed
// ONCE: ids already listed are remembered in att_alert_state/evening_digest, so one entered after 20:15
// (or back-dated to any earlier day) comes in the next evening's list with its date instead of vanishing.
// "Entered when" is read from the 13-digit time inside the advance id (adv-…-<epoch ms>-…).
const STATE = fdb => fdb.collection('att_alert_state').doc('evening_digest');
const istDay = iso => new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
async function moneyLines(fdb, day) {
  const st = ((await STATE(fdb).get()).data()) || {};
  const startedMs = st.startedAt ? Date.parse(st.startedAt) : Infinity;   // before the first run only today's dated advances are listed
  const seen = new Set(st.advIds || []);
  const since = st.lastRunAt || (day + 'T00:00:00+05:30');
  const idMs = id => Number((String(id || '').match(/(?:^|-)(\d{13})(?:-|$)/) || [])[1]) || 0;
  const s = await fdb.collection('att_salary').get();
  const adv = [], ids = []; let advTotal = 0, locks = 0, lockTotal = 0;
  s.forEach(d => { const e = d.data(); const name = (e.name || d.id).trim();
    for (const a of (e.advances || [])) {
      const ad = String(a.date || '').slice(0, 10);
      if ((a.id && seen.has(a.id)) || !(ad === day || idMs(a.id) > startedMs)) continue;   // today's, or entered since the list began — never twice
      adv.push(`${name} ${inr(a.amount)}${ad === day ? '' : ` (${dmy(ad)})`}`); advTotal += Number(a.amount) || 0; if (a.id) ids.push(a.id);
    }
    for (const md of Object.values(e.months || {})) {
      if (!md || !md.locked || !md.lockedAt || md.lockedAt <= new Date(since).toISOString() || istDay(md.lockedAt) > day) continue;
      const pay = md.payment || {}; locks++; lockTotal += (Number(pay.net) || 0) + (Number((pay.breakdown || {}).pfCut) || 0);
    }
  });
  return { adv, advTotal, locks, lockTotal, save: { advIds: [...(st.advIds || []), ...ids].slice(-600), startedAt: st.startedAt || new Date().toISOString(), lastRunAt: new Date().toISOString(), lastDay: day } };
}
async function build(day = istToday(), out = {}) {
  const fdb = db();
  const [weld, plate, money] = await Promise.all([weldingLines(fdb, day), platingLines(fdb, day), moneyLines(fdb, day)]);
  out.save = money.save;
  const L = [`🌙 Aaj ka hisab — ${dmy(day)}`];
  L.push('Welding: ' + (weld.length ? '' : 'koi challan nahi')); for (const l of weld) L.push('  ' + l);
  L.push('Chrome plating: ' + (plate.length ? '' : 'kuch nahi')); for (const l of plate) L.push('  ' + l);
  L.push(money.adv.length ? `Advance diya: ${money.adv.length} · ${inr(money.advTotal)}` : 'Advance diya: nahi'); for (const l of money.adv) L.push('  ' + l);
  if (money.locks) L.push(`Salary lock: ${money.locks} staff · ${inr(money.lockTotal)}`);
  return L.join('\n');
}
module.exports = { build };
if (require.main === module) {
  (async () => {
    // A late run (the GitHub fallback has arrived after midnight) belongs to the day that just ended; and a day
    // already sent is never sent twice. DATE=… (a manual re-run) skips both checks and does not touch the state.
    const manual = process.env.DATE;
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    const day = manual || (now.getUTCHours() < 12 ? addDays(istToday(), -1) : istToday());
    if (!manual && !process.env.DRY) {
      const st = ((await STATE(db()).get()).data()) || {};
      if (st.lastDay === day) { console.log('evening digest already sent for ' + day + ' — skipped'); return; }
    }
    const out = {}; const t = await build(day, out);
    if (process.env.DRY) { console.log(t); return; }
    const r = await sendTelegram(t);
    if (!manual && !(r && r.wa === false)) await STATE(db()).set(out.save, { merge: true });   // not marked listed if WhatsApp did not take it
    console.log('sent evening digest');
  })().catch(e => { console.error(e); process.exit(1); });
}
