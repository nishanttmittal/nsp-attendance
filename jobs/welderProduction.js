// Welder — DAILY PRODUCTION SUMMARY. Sums a day's dispatches (the day's output) grouped
// by welder and product, plus a pay-ready figure (qty × active welding rate).
// Read-only on the welder app's Firestore. Exports buildProduction() so the command bot
// and the scheduled job share identical output. Run via cron (DATE=YYYY-MM-DD optional).
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, prettyDate } = require('./lib/opsdate');

async function activeRates(fdb) {
  const snap = await fdb.collection('apps/welder/rates').where('process', '==', 'welding').get();
  const map = {};
  snap.forEach(d => { const r = d.data(); if (r.isActive) map[r.productName] = Number(r.rate) || 0; });
  return map;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function buildProduction(day = istToday()) {
  const fdb = db();
  const snap = await fdb.collection('apps/welder/dispatches').where('date', '==', day).get();
  if (snap.empty) return `🔧 <b>Welder production — ${prettyDate(day)}</b>\nNo challans recorded today.`;
  const rates = await activeRates(fdb);

  const byWelder = {}; let totQty = 0, totPay = 0;
  snap.forEach(d => {
    const c = d.data();
    const w = c.welder || '—', qty = Number(c.qty) || 0, pay = qty * (rates[c.productName] || 0);
    const e = byWelder[w] || (byWelder[w] = { qty: 0, pay: 0, products: {} });
    e.qty += qty; e.pay += pay;
    const pn = c.finishedName || c.productName || '—';
    e.products[pn] = (e.products[pn] || 0) + qty;
    totQty += qty; totPay += pay;
  });

  const lines = [`🔧 <b>Welder production — ${prettyDate(day)}</b>`];
  for (const [w, e] of Object.entries(byWelder).sort((a, b) => b[1].qty - a[1].qty)) {
    const prods = Object.entries(e.products).map(([p, q]) => `${esc(p)} ${q}`).join(', ');
    lines.push(`• <b>${esc(w)}</b>: ${e.qty} pcs${e.pay ? ` · ₹${e.pay.toLocaleString('en-IN')}` : ''}\n   ${prods}`);
  }
  lines.push(`\nTotal: <b>${totQty} pcs</b>${totPay ? ` · pay-ready ₹${totPay.toLocaleString('en-IN')}` : ''}`);
  if (!totPay) lines.push('<i>(set active welding rates to see pay-ready amounts)</i>');
  return lines.join('\n');
}

module.exports = { buildProduction };

if (require.main === module) {
  buildProduction(process.env.DATE || istToday())
    .then(t => sendTelegram(t).then(() => console.log('sent production summary')))
    .catch(e => { console.error(e); process.exit(1); });
}
