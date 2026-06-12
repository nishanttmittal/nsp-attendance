// Welder — CONTRACTOR PAY READY. Rolls up dispatched qty per welder over a period and
// multiplies by the active welding rate to give the amount payable. Read-only on the
// welder app. Exports buildPayReady() for reuse by the command bot. Default window = last
// 7 days; override with FROM/TO=YYYY-MM-DD. Run weekly via cron.
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

async function buildPayReady(from = istDaysAgo(6), to = istToday()) {
  const fdb = db();
  const snap = await fdb.collection('apps/welder/dispatches')
    .where('date', '>=', from).where('date', '<=', to).get();
  const rates = await activeRates(fdb);

  const byWelder = {}; let totPay = 0, totQty = 0;
  snap.forEach(d => {
    const c = d.data();
    const w = c.welder || '—', qty = Number(c.qty) || 0, pay = qty * (rates[c.productName] || 0);
    const e = byWelder[w] || (byWelder[w] = { qty: 0, pay: 0, products: {} });
    e.qty += qty; e.pay += pay;
    const pn = c.finishedName || c.productName || '—';
    const p = e.products[pn] || (e.products[pn] = { qty: 0, pay: 0 });
    p.qty += qty; p.pay += pay;
    totQty += qty; totPay += pay;
  });

  const lines = [`💰 <b>Welder pay-ready</b> · ${prettyDate(from)}–${prettyDate(to)}`];
  if (!snap.size) { lines.push('No production in this window.'); return lines.join('\n'); }
  for (const [w, e] of Object.entries(byWelder).sort((a, b) => b[1].pay - a[1].pay)) {
    const prods = Object.entries(e.products)
      .map(([p, v]) => `${esc(p)} ${v.qty}${v.pay ? `=₹${v.pay.toLocaleString('en-IN')}` : ''}`).join(', ');
    lines.push(`• <b>${esc(w)}</b>: ${e.qty} pcs → <b>₹${e.pay.toLocaleString('en-IN')}</b>\n   ${prods}`);
  }
  lines.push(`\nTotal payable: <b>₹${totPay.toLocaleString('en-IN')}</b> (${totQty} pcs)`);
  if (!totPay) lines.push('<i>(set active welding rates to see amounts)</i>');
  return lines.join('\n');
}

module.exports = { buildPayReady };

if (require.main === module) {
  buildPayReady(process.env.FROM || istDaysAgo(6), process.env.TO || istToday())
    .then(t => sendTelegram(t).then(() => console.log('sent pay-ready')))
    .catch(e => { console.error(e); process.exit(1); });
}
