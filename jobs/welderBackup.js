// Nightly backup of the WELDER contractor app (owner ask 2026-07-16): exports every
// apps/welder/* collection to JSON. The workflow step pushes the file to the PRIVATE
// unico-backups repo (owner 2026-07-17: no daily Telegram files — Telegram only on FAILURE).
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');

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
  console.log('welder backup written:', path.basename(f), `${total} records, ${cols.length} collections`);
})();
