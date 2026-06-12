// Welder — DAILY PRODUCTION SUMMARY. Sums today's dispatches (the day's output) grouped
// by welder and product, plus a contractor-pay-ready figure (qty × active welding rate).
// Read-only on the welder app's Firestore; pushes one digest to the NSP Ops bot.
// Run once at end of day (cron). Set DATE=YYYY-MM-DD to summarise a specific day.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, prettyDate } = require('./lib/opsdate');

async function activeRates(fdb) {
  // productName -> rate, for the active welding rate rows.
  const snap = await fdb.collection('apps/welder/rates').where('process', '==', 'welding').get();
  const map = {};
  snap.forEach(d => { const r = d.data(); if (r.isActive) map[r.productName] = Number(r.rate) || 0; });
  return map;
}

async function main() {
  const fdb = db();
  const day = process.env.DATE || istToday();
  const snap = await fdb.collection('apps/welder/dispatches').where('date', '==', day).get();
  if (snap.empty) {
    await sendTelegram(`🔧 <b>Welder production — ${prettyDate(day)}</b>\nNo challans recorded today.`);
    console.log('No dispatches for', day); return;
  }
  const rates = await activeRates(fdb);

  const byWelder = {};   // welder -> { qty, pay, products:{name:qty} }
  let totQty = 0, totPay = 0;
  snap.forEach(d => {
    const c = d.data();
    const w = c.welder || '—';
    const qty = Number(c.qty) || 0;
    const rate = rates[c.productName] || 0;
    const pay = qty * rate;
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

  await sendTelegram(lines.join('\n'));
  console.log('Sent production summary for', day, '—', totQty, 'pcs');
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

main().catch(e => { console.error(e); process.exit(1); });
