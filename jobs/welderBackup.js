// Nightly backup of the WELDER contractor app (owner ask 2026-07-16): exports every
// apps/welder/* collection to JSON and sends it to Telegram as the off-site copy —
// same pattern as backup.js (attendance). Scheduled in .github/workflows/alerts.yml.
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');
const { sendTelegramDocument } = require('./lib/notify');

(async () => {
  const root = db().collection('apps').doc('welder');
  const cols = await root.listCollections();   // auto-discovers new collections — never silently misses one
  const out = { app: 'welder', version: 1, exportedAt: new Date().toISOString(), collections: {} };
  let total = 0;
  for (const c of cols) {
    const s = await c.get();
    out.collections[c.id] = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
    total += s.size;
  }
  const dir = path.resolve(__dirname, 'downloads'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const f = path.join(dir, `welder-backup-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  await sendTelegramDocument(f, `🗄️ Welder app nightly backup — ${total} records across ${cols.length} collections (hisab, payments, rates, dispatches…)`);
  console.log('welder backup sent:', path.basename(f), `${total} records`);
})();
