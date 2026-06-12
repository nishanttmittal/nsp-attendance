// Plating — SUMMARY (day or week). Digest of plating job-work: challans out (sent for
// plating) vs in (received back), per-party piece totals, plus incoming feeds from the
// welder app. Read-only on the plating app. Exports buildPlating(day) and
// buildPlatingWeek(from,to) for the command bot. Run once daily via cron (DATE optional).
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { istToday, istDaysAgo, prettyDate } = require('./lib/opsdate');

function qtyOf(items) {
  try { return (typeof items === 'string' ? JSON.parse(items) : items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0); }
  catch { return 0; }
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function topParties(parties) {
  return Object.entries(parties).sort((a, b) => b[1] - a[1]).map(([p, q]) => `${esc(p)} ${q}`).join(', ');
}

// Build the digest text from challan + incoming docs over any date set.
function summarize(challanDocs, incomingDocs, header) {
  const out = { count: 0, qty: 0, parties: {} };
  const inn = { count: 0, qty: 0, parties: {} };
  for (const c of challanDocs) {
    const q = qtyOf(c.items);
    const bucket = c.direction === 'in' ? inn : out;
    bucket.count++; bucket.qty += q;
    bucket.parties[c.party || '—'] = (bucket.parties[c.party || '—'] || 0) + q;
  }
  const lines = [header];
  lines.push(`Sent out: <b>${out.count}</b> challan(s) · ${out.qty} pcs`);
  if (out.count) lines.push('   ' + topParties(out.parties));
  lines.push(`Received in: <b>${inn.count}</b> challan(s) · ${inn.qty} pcs`);
  if (inn.count) lines.push('   ' + topParties(inn.parties));
  if (incomingDocs.length) {
    const feedQty = incomingDocs.reduce((s, d) => s + qtyOf(d.items), 0);
    lines.push(`From welder (incoming): <b>${incomingDocs.length}</b> feed(s) · ${feedQty} pcs`);
  }
  if (!challanDocs.length && !incomingDocs.length) lines.push('No plating activity in this period.');
  return lines.join('\n');
}

async function buildPlating(day = istToday()) {
  const fdb = db();
  const [ch, inc] = await Promise.all([
    fdb.collection('apps/platingjobwork/challans').where('date', '==', day).get(),
    fdb.collection('apps/platingjobwork/incoming').where('date', '==', day).get(),
  ]);
  return summarize(ch.docs.map(d => d.data()), inc.docs.map(d => d.data()), `⚙️ <b>Plating — ${prettyDate(day)}</b>`);
}

async function buildPlatingWeek(from = istDaysAgo(6), to = istToday()) {
  const fdb = db();
  const [ch, inc] = await Promise.all([
    fdb.collection('apps/platingjobwork/challans').where('date', '>=', from).where('date', '<=', to).get(),
    fdb.collection('apps/platingjobwork/incoming').where('date', '>=', from).where('date', '<=', to).get(),
  ]);
  return summarize(ch.docs.map(d => d.data()), inc.docs.map(d => d.data()),
    `⚙️ <b>Plating — week ${prettyDate(from)}–${prettyDate(to)}</b>`);
}

module.exports = { buildPlating, buildPlatingWeek };

if (require.main === module) {
  buildPlating(process.env.DATE || istToday())
    .then(t => sendTelegram(t).then(() => console.log('sent plating summary')))
    .catch(e => { console.error(e); process.exit(1); });
}
