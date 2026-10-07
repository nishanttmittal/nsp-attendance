// EVENING DIGEST — one short WhatsApp message at 20:15 (owner 07-10-2026: "very simple report";
// "welder and chrome item name should also be mentioned along with qty"). Replaces the separate
// welder-production + plating-summary messages. Read-only on welder/plating/salary data.
// DRY=1 prints instead of sending. DATE=YYYY-MM-DD for a past day.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
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
async function advanceLines(fdb, day) {
  const s = await fdb.collection('att_salary').get(); const rows = [];
  s.forEach(d => { const e = d.data(); for (const a of (e.advances || [])) if (String(a.date || '').slice(0, 10) === day) rows.push(`${(e.name || d.id).trim()} ${inr(a.amount)}`); });
  return rows;
}
async function build(day = istToday()) {
  const fdb = db();
  const [weld, plate, adv] = await Promise.all([weldingLines(fdb, day), platingLines(fdb, day), advanceLines(fdb, day)]);
  const L = [`🌙 Aaj ka hisab — ${dmy(day)}`];
  L.push('Welding: ' + (weld.length ? '' : 'koi challan nahi')); for (const l of weld) L.push('  ' + l);
  L.push('Chrome plating: ' + (plate.length ? '' : 'kuch nahi')); for (const l of plate) L.push('  ' + l);
  L.push('Advance diya: ' + (adv.length ? adv.join(', ') : 'nahi'));
  return L.join('\n');
}
module.exports = { build };
if (require.main === module) {
  build(process.env.DATE || istToday()).then(async t => {
    if (process.env.DRY) { console.log(t); return; }
    await sendTelegram(t); console.log('sent evening digest');
  }).catch(e => { console.error(e); process.exit(1); });
}
