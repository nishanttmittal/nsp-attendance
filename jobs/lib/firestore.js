// Firebase Admin (server side) for the jobs. Service account comes from the
// FIREBASE_SERVICE_ACCOUNT env (GitHub Actions secret, JSON string) or the git-ignored
// jobs/firebase-admin.json file (local). All attendance data lives under att_* collections.
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

let _db = null;
function db() {
  if (_db) return _db;
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'firebase-admin.json'), 'utf8'));
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(svc) });
  _db = getFirestore(app);
  installReadMeter(_db);
  return _db;
}

// ---- READ METER (usage_reads/{YYYY-MM-DD}.totals['jobs:<script>']) ----------
// Every script that uses this lib (attendance jobs, fullBackup, laser-iot
// sync/report/archive, ad-hoc admin scripts) gets its Firestore reads counted
// into the same shared meter doc the web apps write to, so quota exhaustion is
// attributable. Fail-safe: wrappers never throw, never alter results; disable
// with READ_METER=0. Batched: 1 write per 15s / 500 reads.
let _pending = 0, _timer = null, _label = 'jobs:unknown';
function _tally(n) {
  _pending += Number(n) || 0;
  if (_pending >= 500) return _flushMeter();
  if (!_timer) { _timer = setTimeout(_flushMeter, 15000); if (_timer.unref) _timer.unref(); }
}
function _flushMeter() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const n = _pending; _pending = 0;
  if (!n || !_db) return;
  const d = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return _db.collection('usage_reads').doc(d)
    .set({ totals: { [_label]: FieldValue.increment(n) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => { _pending += n; });
}
function installReadMeter(fdb) {
  if (process.env.READ_METER === '0') return;
  try {
    _label = 'jobs:' + (process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?js$/, '') : 'repl');
    const colRef = fdb.collection('usage_reads');
    const queryProto = Object.getPrototypeOf(Object.getPrototypeOf(colRef)); // Query (parent of CollectionReference)
    const wrap = (proto, name, count) => {
      const orig = proto && proto[name];
      if (typeof orig !== 'function' || orig.__metered) return;
      const fn = function (...args) {
        const p = orig.apply(this, args);
        if (p && typeof p.then === 'function') p.then((s) => { try { _tally(count(s)); } catch { /* never break reads */ } }, () => {});
        return p;
      };
      fn.__metered = true;
      proto[name] = fn;
    };
    // NOTE: DocumentReference.get() routes through Firestore.getAll internally,
    // so wrapping getAll alone covers both single-doc and batch doc reads
    // (wrapping doc.get too double-counts — verified 2026-07-25).
    wrap(queryProto, 'get', (s) => (s && s.size) || 0);
    wrap(Object.getPrototypeOf(fdb), 'getAll', (a) => (a && a.length) || 0);
    process.on('beforeExit', () => { _flushMeter(); });
  } catch { /* meter is best-effort; reads must always work */ }
}

module.exports = { db, FieldValue };
