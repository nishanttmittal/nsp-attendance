// Plating — DAILY SUMMARY. Digest of a day's plating job-work: challans out (sent for
// plating) vs in (received back), per-party piece totals, plus new incoming feeds from the
// welder app. Read-only on the plating app. Exports buildPlating() for the command bot.
// Run once daily via cron (DATE=YYYY-MM-DD optional).
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, prettyDate } = require('./lib/opsdate');

function qtyOf(items) {
  try { return (typeof items === 'string' ? JSON.parse(items) : items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0); }
  catch { return 0; }
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function topParties(parties) {
  return Object.entries(parties).sort((a, b) => b[1] - a[1]).map(([p, q]) => `${esc(p)} ${q}`).join(', ');
}

async function buildPlating(day = istToday()) {
  const fdb = db();
  const chSnap = await fdb.collection('apps/platingjobwork/challans').where('date', '==', day).get();
  const inSnap = await fdb.collection('apps/platingjobwork/incoming').where('date', '==', day).get();

  const out = { count: 0, qty: 0, parties: {} };
  const inn = { count: 0, qty: 0, parties: {} };
  chSnap.forEach(d => {
    const c = d.data(), q = qtyOf(c.items);
    const bucket = c.direction === 'in' ? inn : out;
    bucket.count++; bucket.qty += q;
    bucket.parties[c.party || '—'] = (bucket.parties[c.party || '—'] || 0) + q;
  });

  const lines = [`⚙️ <b>Plating — ${prettyDate(day)}</b>`];
  lines.push(`Sent out: <b>${out.count}</b> challan(s) · ${out.qty} pcs`);
  if (out.count) lines.push('   ' + topParties(out.parties));
  lines.push(`Received in: <b>${inn.count}</b> challan(s) · ${inn.qty} pcs`);
  if (inn.count) lines.push('   ' + topParties(inn.parties));
  if (!inSnap.empty) {
    let feedQty = 0; inSnap.forEach(d => { feedQty += qtyOf(d.data().items); });
    lines.push(`From welder (incoming): <b>${inSnap.size}</b> feed(s) · ${feedQty} pcs`);
  }
  if (!chSnap.size && inSnap.empty) lines.push('No plating activity recorded today.');
  return lines.join('\n');
}

module.exports = { buildPlating };

if (require.main === module) {
  buildPlating(process.env.DATE || istToday())
    .then(t => sendTelegram(t).then(() => console.log('sent plating summary')))
    .catch(e => { console.error(e); process.exit(1); });
}
