// Welder — NEW CHALLAN alert. Polls apps/welder/dispatches for challans created since
// we last looked and pings the NSP Ops bot once per new challan. Dedup state lives in
// att_alert_state/welder_challans (our own namespace) so we never touch the live welder app.
// Safe & additive: read-only on the welder data. Run frequently (every 15 min) from cron.
const { db, FieldValue } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { prettyDate } = require('./lib/opsdate');

const STATE = 'att_alert_state';
const STATE_DOC = 'welder_challans';
const MAX_SEEN = 400; // keep the seen-list bounded

async function main() {
  const fdb = db();
  const stateRef = fdb.collection(STATE).doc(STATE_DOC);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() : {};
  const seen = new Set(state.seenIds || []);
  // First run: don't blast history — just record what exists and stay quiet.
  const firstRun = !stateSnap.exists;

  const snap = await fdb.collection('apps/welder/dispatches').orderBy('createdAt', 'desc').limit(50).get();
  const fresh = [];
  snap.forEach(d => { if (!seen.has(d.id)) fresh.push({ id: d.id, ...d.data() }); });
  fresh.reverse(); // oldest first so messages arrive in order

  if (!firstRun) {
    for (const c of fresh) {
      const lines = [
        '🧾 <b>New welder challan</b>',
        `Challan: <b>${esc(c.welderChallan || c.id)}</b>`,
        `Welder: ${esc(c.welder || '-')}`,
        `Product: ${esc(c.finishedName || c.productName || '-')}`,
        `Qty: <b>${c.qty ?? '-'}</b>`,
        `Party: ${esc(c.party || '-')}${c.gaadi ? ' · Gaadi ' + esc(c.gaadi) : ''}`,
        c.date ? `Date: ${prettyDate(c.date)}` : '',
      ].filter(Boolean);
      await sendTelegram(lines.join('\n'));
    }
  }

  // Record every id we've now seen.
  snap.forEach(d => seen.add(d.id));
  const seenIds = [...seen].slice(-MAX_SEEN);
  await stateRef.set({ seenIds, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`${firstRun ? 'First run — recorded' : 'Alerted'} ${firstRun ? snap.size : fresh.length} challan(s).`);
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

main().catch(e => { console.error(e); process.exit(1); });
