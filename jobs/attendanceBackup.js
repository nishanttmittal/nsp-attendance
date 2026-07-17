// Nightly backup of the NSP ATTENDANCE app (owner ask 2026-07-17): exports every root
// att_* collection (auto-discovered — the old backup.js hardcoded list missed newer
// collections like att_job_requests) to JSON. The workflow step pushes the file to the
// PRIVATE unico-backups repo — payroll data must NEVER land in the public nsp-attendance
// repo. Telegram fires only on FAILURE. backup.js (Telegram file) stays for manual use.
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');

(async () => {
  const cols = (await db().listCollections()).filter((c) => c.id.startsWith('att_'));
  const out = { app: 'nsp-attendance', version: 1, exportedAt: new Date().toISOString(), collections: {} };
  let total = 0;
  for (const c of cols) {
    const s = await c.get();
    out.collections[c.id] = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
    total += s.size;
  }
  const dir = path.resolve(__dirname, 'downloads'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const f = path.join(dir, `nsp-attendance-backup-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log('attendance backup written:', path.basename(f), `${total} records, ${cols.length} collections`);
})();
