// Welder — PRODUCTION SUMMARY (day or week). Sums dispatches (the day's output) grouped
// by welder and product, plus a pay-ready figure (qty × active welding rate). Read-only on
// the welder app. Exports buildProduction(day) and buildProductionWeek(from,to) so the
// command bot and the scheduled job share identical output. Run via cron (DATE optional).
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, istDaysAgo, prettyDate } = require('./lib/opsdate');

async function activeRates(fdb) {
  const snap = await fdb.collection('apps/welder/rates').where('process', '==', 'welding').get();
  const map = {};
  snap.forEach(d => { const r = d.data(); if (r.isActive) map[r.productName] = Number(r.rate) || 0; });
  return map;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Turn a set of dispatch docs into the grouped production text.
function summarize(docs, rates, header, emptyMsg) {
  if (!docs.length) return `${header}\n${emptyMsg}`;
  const byWelder = {}; let totQty = 0, totPay = 0;
  for (const c of docs) {
    const w = c.welder || '—', qty = Number(c.qty) || 0, pay = qty * (rates[c.productName] || 0);
    const e = byWelder[w] || (byWelder[w] = { qty: 0, pay: 0, products: {} });
    e.qty += qty; e.pay += pay;
    const pn = c.finishedName || c.productName || '—';
    e.products[pn] = (e.products[pn] || 0) + qty;
    totQty += qty; totPay += pay;
  }
  const lines = [header];
  for (const [w, e] of Object.entries(byWelder).sort((a, b) => b[1].qty - a[1].qty)) {
    const prods = Object.entries(e.products).sort((a, b) => b[1] - a[1]).map(([p, q]) => `${esc(p)} ${q}`).join(', ');
    lines.push(`• <b>${esc(w)}</b>: ${e.qty} pcs${e.pay ? ` · ₹${e.pay.toLocaleString('en-IN')}` : ''}\n   ${prods}`);
  }
  lines.push(`\nTotal: <b>${totQty} pcs</b>${totPay ? ` · pay-ready ₹${totPay.toLocaleString('en-IN')}` : ''}`);
  if (!totPay) lines.push('<i>(set active welding rates to see pay-ready amounts)</i>');
  return lines.join('\n');
}

async function buildProduction(day = istToday()) {
  const fdb = db();
  const [snap, rates] = await Promise.all([
    fdb.collection('apps/welder/dispatches').where('date', '==', day).get(),
    activeRates(fdb),
  ]);
  return summarize(snap.docs.map(d => d.data()), rates,
    `🔧 <b>Welder production — ${prettyDate(day)}</b>`, 'No challans recorded today.');
}

async function buildProductionWeek(from = istDaysAgo(6), to = istToday()) {
  const fdb = db();
  const [snap, rates] = await Promise.all([
    fdb.collection('apps/welder/dispatches').where('date', '>=', from).where('date', '<=', to).get(),
    activeRates(fdb),
  ]);
  return summarize(snap.docs.map(d => d.data()), rates,
    `🔧 <b>Welder production — week ${prettyDate(from)}–${prettyDate(to)}</b>`, 'No production this week.');
}

module.exports = { buildProduction, buildProductionWeek };

if (require.main === module) {
  buildProduction(process.env.DATE || istToday())
    .then(t => sendTelegram(t).then(() => console.log('sent production summary')))
    .catch(e => { console.error(e); process.exit(1); });
}
