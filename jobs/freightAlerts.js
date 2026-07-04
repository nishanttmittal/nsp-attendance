// Transport-freight balance alerts. Reads each gaadiwala's running balance from
// the shared `unico-operations` Firestore (apps/transportfreight/transporters) and
// pings the owner on WhatsApp + Telegram when a balance CROSSES UP a threshold
// (₹5k → ₹10k → ₹15k → ₹20k) — so what UNICO owes a gaadiwala never quietly grows
// too big before it's cleared. Server-side (firebase-admin) so it needs no client
// write-rule on wa_outbox and no browser open; dedup via each transporter's stored
// `alertedLevel` (same field the app maintains). Additive; touches only the
// transportfreight collection — never payroll.
//
// Run: `node freightAlerts.js`  (DRY=1 to preview without sending/writing)
const { db, FieldValue } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');

const THRESHOLDS = [5000, 10000, 15000, 20000]; // mirror app config THRESHOLD_LEVELS
const DRY = process.env.DRY === '1';
const TF = 'apps/transportfreight/transporters';

const num = (v) => Number(v) || 0;
const inr = (n) => '₹' + num(n).toLocaleString('en-IN');
// Highest threshold the balance has reached (0 = below the first).
const levelOf = (bal) => THRESHOLDS.reduce((hit, t) => (num(bal) >= t ? t : hit), 0);

async function main() {
  const snap = await db().collection(TF).get();
  const crossed = [];   // gaadiwalas who just crossed UP
  const resync = [];    // alertedLevel drifted (paid down) — quietly realign

  for (const doc of snap.docs) {
    const t = doc.data();
    if (t.deleted) continue;
    const bal = num(t.runningBalance);
    const level = levelOf(bal);
    const alerted = num(t.alertedLevel);
    if (level > alerted) crossed.push({ id: doc.id, name: t.name || '—', bal, level });
    else if (level < alerted) resync.push({ id: doc.id, level }); // balance came down; re-arm lower
  }

  if (!crossed.length && !resync.length) { console.log('[freightAlerts] nothing to alert.'); return; }

  // Realign alertedLevel downward for anyone paid below their last alert (so a
  // future re-cross alerts again). Silent — no message.
  for (const r of resync) {
    console.log(`[freightAlerts] re-arm ${r.id} → level ${r.level}`);
    if (!DRY) await db().collection(TF).doc(r.id).set({ alertedLevel: r.level, updatedAt: new Date().toISOString() }, { merge: true });
  }

  if (crossed.length) {
    const lines = crossed
      .sort((a, b) => b.bal - a.bal)
      .map(c => `• ${c.name}: ${inr(c.bal)} (crossed ${inr(c.level)})`);
    const text = `🚚 *Freight balance alert*\nUNICO owes these gaadiwalas — clear soon:\n\n${lines.join('\n')}`;
    console.log('[freightAlerts] alerting:\n' + text);
    if (!DRY) {
      await sendTelegram(text); // sends Telegram + enqueues wa_outbox (WhatsApp)
      for (const c of crossed) {
        await db().collection(TF).doc(c.id).set({ alertedLevel: c.level, updatedAt: new Date().toISOString() }, { merge: true });
      }
    }
  }
  console.log(DRY ? '[freightAlerts] DRY run — nothing sent/written.' : '[freightAlerts] done.');
}

main().then(() => process.exit(0)).catch(e => { console.error('freightAlerts failed:', e); process.exit(1); });
