// Nightly backup of ALL UNICO apps (owner ask 2026-07-17): exports the whole
// unico-operations Firestore, grouped into one JSON per app, for the workflow step to
// push to the PRIVATE unico-backups repo. Collections are auto-discovered — a new app
// under apps/<id> or a new root collection is picked up automatically (unknown root
// collections land in misc.json, so nothing is ever silently missed).
// laser_jobs (6k+ docs, >half of all reads) is included only on the weekly FULL run
// (Saturday UTC night = Sunday 02:45 IST) or with FULL=1, to protect the free
// 50k-reads/day Firestore quota. Replaces welderBackup.js + attendanceBackup.js in the
// nightly cron (both kept for manual single-app use).
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');

const ROOT_GROUPS = [
  { name: 'attendance', match: (id) => id.startsWith('att_') },
  { name: 'costing', match: (id) => id.startsWith('costing_') },
  { name: 'laser', match: (id) => id.startsWith('laser_') },
  { name: 'leads', match: (id) => ['indiamart_leads', 'whatsapp_leads', 'imart_state', 'wa_outbox'].includes(id) },
];
const FULL = process.env.FULL === '1' || new Date().getUTCDay() === 6;

(async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.resolve(__dirname, 'downloads', 'allbackup');
  fs.mkdirSync(dir, { recursive: true });
  const groups = {};
  const g = (name) => (groups[name] ||= { app: name, version: 1, exportedAt: new Date().toISOString(), full: FULL, collections: {}, skipped: [] });
  const dump = async (col, group, label) => {
    if (!FULL && label === 'laser_jobs') { g(group).skipped.push(`${label} (weekly full only)`); return 0; }
    const s = await col.get();
    g(group).collections[label] = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
    return s.size;
  };
  let total = 0;
  for (const c of await db().listCollections()) {
    if (c.id === 'apps') continue; // per-app subcollections handled below
    const grp = ROOT_GROUPS.find((x) => x.match(c.id))?.name || 'misc';
    total += await dump(c, grp, c.id);
  }
  for (const d of await db().collection('apps').listDocuments()) {
    for (const c of await d.listCollections()) total += await dump(c, d.id, c.id);
  }
  for (const [name, data] of Object.entries(groups)) {
    if (!data.skipped.length) delete data.skipped;
    fs.writeFileSync(path.join(dir, `${name}-backup-${stamp}.json`), JSON.stringify(data, null, 2));
  }
  console.log(`all-apps backup written: ${Object.keys(groups).length} apps, ${total} records, full=${FULL}`);
  console.log(Object.entries(groups).map(([n, d]) => `${n}: ${Object.values(d.collections).reduce((t, c) => t + Object.keys(c).length, 0)} records`).join('\n'));
})();
