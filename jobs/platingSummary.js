// Plating — DAILY SUMMARY. Digest of today's plating job-work: challans out (sent for
// plating) vs in (received back), per-party piece totals, plus new incoming feeds from the
// welder app. Read-only on the plating app's Firestore; one message to the NSP Ops bot.
// Run once at end of day (cron). Set DATE=YYYY-MM-DD for a specific day.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, prettyDate } = require('./lib/opsdate');

function qtyOf(items) {
  // items is a JSON string: [{product, quantity}, ...]
  try { return (typeof items === 'string' ? JSON.parse(items) : items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0); }
  catch { return 0; }
}

async function main() {
  const fdb = db();
  const day = process.env.DATE || istToday();

  const chSnap = await fdb.collection('apps/platingjobwork/challans').where('date', '==', day).get();
  const inSnap = await fdb.collection('apps/platingjobwork/incoming').where('date', '==', day).get();

  const out = { count: 0, qty: 0, parties: {} };
  const inn = { count: 0, qty: 0, parties: {} };
  chSnap.forEach(d => {
    const c = d.data(); const q = qtyOf(c.items);
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

  await sendTelegram(lines.join('\n'));
  console.log('Sent plating summary for', day, '— out', out.count, 'in', inn.count);
}

function topParties(parties) {
  return Object.entries(parties).sort((a, b) => b[1] - a[1])
    .map(([p, q]) => `${esc(p)} ${q}`).join(', ');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

main().catch(e => { console.error(e); process.exit(1); });
