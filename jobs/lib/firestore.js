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
  return _db;
}
module.exports = { db, FieldValue };
