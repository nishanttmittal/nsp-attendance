// RESTORE DRILL — proves a nightly backup can actually be restored.
//
// WHY: a backup file existing proves nothing. This restores one into a THROWAWAY
// Firestore emulator and compares the result against the source, field by field.
//
// ─────────────────────────────────────────────────────────────────────────────
// SAFETY. This script CANNOT touch production. It refuses to start unless:
//   1. FIRESTORE_EMULATOR_HOST is explicitly set (no default, no guessing)
//   2. that emulator actually answers on the socket
//   3. NO real credentials are visible (GOOGLE_APPLICATION_CREDENTIALS unset,
//      no serviceAccount file discoverable)
//   4. the project id is the hardcoded throwaway below and nothing else
// Any one of these failing = hard exit before a single write.
// ─────────────────────────────────────────────────────────────────────────────
//
// USAGE
//   Leg A — structural fidelity, no emulator, always safe:
//       node restoreDrill.js --file <backup.json>
//   Leg B — full restore into the emulator (needs Java + firebase-tools):
//       npx firebase emulators:start --only firestore --project drill-throwaway
//       FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node restoreDrill.js --file <backup.json> --emulator
//
// Writes a pass/fail report to jobs/restore_drill_reports/.

const fs = require('fs');
const path = require('path');
const net = require('net');

const DRILL_PROJECT = 'drill-throwaway';           // never a real project
const REPORT_DIR = path.join(__dirname, 'restore_drill_reports');

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const useEmulator = args.includes('--emulator');
const FILE = arg('--file');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return pass;
};
const die = (msg) => { console.error(`\nABORT: ${msg}`); process.exit(2); };

// ── Guardrails ───────────────────────────────────────────────────────────────
function assertNoProductionCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS)
    die('GOOGLE_APPLICATION_CREDENTIALS is set. Unset it — this drill must never hold real credentials.');
  for (const f of ['serviceAccount.json', 'lib/serviceAccount.json', '../serviceAccount.json']) {
    if (fs.existsSync(path.join(__dirname, f)))
      die(`A service-account file is reachable at ${f}. Refusing to run where real credentials exist.`);
  }
  if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== DRILL_PROJECT)
    die(`GCLOUD_PROJECT is "${process.env.GCLOUD_PROJECT}", not the throwaway project.`);
}

function probe(hostPort) {
  return new Promise((resolve) => {
    const [host, port] = hostPort.split(':');
    const s = net.createConnection({ host, port: Number(port) });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(2500, () => done(false));
  });
}

async function assertEmulator() {
  const hp = process.env.FIRESTORE_EMULATOR_HOST;
  if (!hp) die('FIRESTORE_EMULATOR_HOST is not set. Refusing to run — without it firebase-admin would talk to PRODUCTION.');
  if (!await probe(hp)) die(`Nothing is listening on ${hp}. Start the emulator first. Refusing to continue.`);
  console.log(`Emulator confirmed at ${hp}, project "${DRILL_PROJECT}".\n`);
}

// ── Backup shape ─────────────────────────────────────────────────────────────
// { app, version, exportedAt, full, collections: { <name>: { <docId>: {...} } } }
function loadBackup(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.collections || typeof raw.collections !== 'object')
    die('Backup has no `collections` object — unexpected shape.');
  return raw;
}

const docsOf = (c) => Array.isArray(c) ? c.map((d, i) => [d.id || String(i), d]) : Object.entries(c || {});

function summarise(backup) {
  const s = { collections: 0, docs: 0, perCollection: {}, money: {} };
  for (const [name, coll] of Object.entries(backup.collections)) {
    const entries = docsOf(coll);
    s.collections++; s.docs += entries.length;
    s.perCollection[name] = entries.length;
    let total = 0, n = 0;
    for (const [, d] of entries) if (typeof d.amount === 'number') { total += d.amount; n++; }
    if (n) s.money[name] = { docsWithAmount: n, total: Math.round(total * 100) / 100 };
  }
  return s;
}

// ── Leg A: structural fidelity (no emulator, always runs) ────────────────────
function legA(backup) {
  console.log('LEG A — structural fidelity (no emulator)\n');
  const s = summarise(backup);

  check('backup parses as JSON with a collections map', true, `${s.collections} collections, ${s.docs} docs`);
  // NOTE: `full` means "this was the WEEKLY run that also includes laser_jobs"
  // (see fullBackup.js) — it does NOT mean "this export is complete". A nightly
  // backup is legitimately full=false. Only the timestamp is a real health signal.
  check('export carries a timestamp', !!backup.exportedAt,
    `exportedAt=${backup.exportedAt}, weeklyFullRun=${backup.full === true}`);
  check('every collection has at least one document',
    Object.values(s.perCollection).every(n => n > 0),
    Object.entries(s.perCollection).map(([k, v]) => `${k}:${v}`).join(' '));

  // Document IDs must be unique and non-empty — a restore keyed on these must not merge rows.
  let idProblems = 0, blank = 0;
  for (const [, coll] of Object.entries(backup.collections)) {
    const ids = docsOf(coll).map(([id]) => id);
    if (new Set(ids).size !== ids.length) idProblems++;
    blank += ids.filter(id => !id || !String(id).trim()).length;
  }
  check('document ids unique within every collection', idProblems === 0, `${idProblems} collections with duplicates`);
  check('no blank document ids', blank === 0, `${blank} blank`);

  // Values must survive a JSON round-trip unchanged, or a restore silently mutates data.
  let mutated = 0, sampled = 0;
  for (const [, coll] of Object.entries(backup.collections)) {
    for (const [, d] of docsOf(coll)) {
      sampled++;
      if (JSON.stringify(d) !== JSON.stringify(JSON.parse(JSON.stringify(d)))) mutated++;
    }
  }
  check('all documents survive a JSON round-trip unchanged', mutated === 0, `${sampled} docs checked, ${mutated} mutated`);

  // Undefined is not writable to Firestore — it would throw mid-restore.
  let undef = 0;
  const scan = (o) => { if (o && typeof o === 'object') for (const v of Object.values(o)) { if (v === undefined) undef++; else scan(v); } };
  for (const [, coll] of Object.entries(backup.collections)) for (const [, d] of docsOf(coll)) scan(d);
  check('no undefined values (Firestore would reject these)', undef === 0, `${undef} found`);

  for (const [name, m] of Object.entries(s.money))
    check(`money totals readable in "${name}"`, true, `${m.docsWithAmount} docs, total ${m.total.toLocaleString('en-IN')}`);

  return s;
}

// ── Leg B: real restore into the emulator, then read back and compare ────────
async function legB(backup, srcSummary) {
  console.log('\nLEG B — real restore into emulator, then verify\n');
  // Modular API, matching jobs/lib/firestore.js. No credential is passed on
  // purpose — with FIRESTORE_EMULATOR_HOST set, the SDK talks only to the emulator.
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = getApps().length ? getApps()[0] : initializeApp({ projectId: DRILL_PROJECT });
  const db = getFirestore(app);

  // Wipe the emulator FIRST. Different apps share collection names (logs, users,
  // meta, products), so restoring several in a row without clearing makes each
  // read-back include the previous app's documents and every count check lies.
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const wipe = await fetch(
    `http://${host}/emulator/v1/projects/${DRILL_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' });
  if (!wipe.ok) die(`Could not wipe emulator before restore (HTTP ${wipe.status}). Refusing — counts would be wrong.`);
  const leftover = (await db.listCollections()).length;
  check('emulator empty before restore', leftover === 0, `${leftover} collections remain`);

  let written = 0;
  for (const [name, coll] of Object.entries(backup.collections)) {
    const entries = docsOf(coll);
    for (let i = 0; i < entries.length; i += 400) {           // stay under the 500-op batch limit
      const batch = db.batch();
      for (const [id, d] of entries.slice(i, i + 400)) batch.set(db.collection(name).doc(String(id)), d);
      await batch.commit();
      written += Math.min(400, entries.length - i);
    }
  }
  check('restore wrote without error', true, `${written} documents`);

  // Read everything back out and re-derive the same summary.
  const back = { collections: {} };
  for (const name of Object.keys(backup.collections)) {
    const snap = await db.collection(name).get();
    back.collections[name] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  }
  const dst = summarise(back);

  check('collection count matches', srcSummary.collections === dst.collections, `${srcSummary.collections} -> ${dst.collections}`);
  check('total document count matches', srcSummary.docs === dst.docs, `${srcSummary.docs} -> ${dst.docs}`);

  const countMismatch = Object.entries(srcSummary.perCollection).filter(([k, v]) => dst.perCollection[k] !== v);
  check('per-collection counts match', countMismatch.length === 0,
    countMismatch.map(([k, v]) => `${k} ${v}->${dst.perCollection[k]}`).join(' ') || 'all equal');

  // Document ids must come back identical — this is what makes a restore a restore.
  let idMismatch = 0;
  for (const [name, coll] of Object.entries(backup.collections)) {
    const a = new Set(docsOf(coll).map(([id]) => String(id)));
    const b = new Set(Object.keys(back.collections[name] || {}));
    if (a.size !== b.size || [...a].some(id => !b.has(id))) idMismatch++;
  }
  check('every document id restored identically', idMismatch === 0, `${idMismatch} collections differ`);

  // Money must reconcile to the paisa.
  let moneyBad = [];
  for (const [name, m] of Object.entries(srcSummary.money)) {
    const d = dst.money[name];
    if (!d || d.total !== m.total || d.docsWithAmount !== m.docsWithAmount)
      moneyBad.push(`${name}: ${m.total} -> ${d ? d.total : 'MISSING'}`);
  }
  check('financial totals reconcile exactly', moneyBad.length === 0, moneyBad.join(' | ') || 'all match');

  // Full field-level comparison, not just counts.
  let fieldDiff = 0, compared = 0;
  for (const [name, coll] of Object.entries(backup.collections)) {
    for (const [id, src] of docsOf(coll)) {
      const got = (back.collections[name] || {})[String(id)];
      compared++;
      if (JSON.stringify(src) !== JSON.stringify(got)) fieldDiff++;
    }
  }
  check('every document matches field-for-field', fieldDiff === 0, `${compared} compared, ${fieldDiff} differ`);
}

(async () => {
  if (!FILE) die('Pass --file <backup.json>');
  if (!fs.existsSync(FILE)) die(`No such file: ${FILE}`);

  assertNoProductionCredentials();
  console.log(`Restore drill — ${path.basename(FILE)}\n`);

  const backup = loadBackup(FILE);
  const srcSummary = legA(backup);

  if (useEmulator) { await assertEmulator(); await legB(backup, srcSummary); }
  else console.log('\nLeg B skipped (no --emulator). Structural fidelity only — this does NOT prove a live restore.');

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  const verdict = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`\n${verdict} — ${passed}/${results.length} checks passed`);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = (backup.exportedAt || 'unknown').replace(/[:.]/g, '-');
  const report = {
    verdict, ranAt: new Date().toISOString(), backupFile: path.basename(FILE),
    backupExportedAt: backup.exportedAt, app: backup.app,
    legBRun: useEmulator, emulatorHost: useEmulator ? process.env.FIRESTORE_EMULATOR_HOST : null,
    passed, failed, checks: results, summary: srcSummary,
  };
  const out = path.join(REPORT_DIR, `drill-${backup.app || 'app'}-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Report: ${out}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => die(e.stack || e.message));
