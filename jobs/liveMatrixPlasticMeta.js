// LIVE write-matrix for the plastic-jobwork meta split — runs REAL writes against
// the DEPLOYED Firestore rules via custom-token → ID-token → Firestore REST.
// Safe: uses throwaway doc ids (__ruletest), a NO-OP counter write, and cleans up.
// Run it BEFORE deploy (shows old lax behavior) and AFTER deploy (must be all green).
//   node liveMatrixPlasticMeta.js
const { db } = require('./lib/firestore');
const { getAuth } = require('firebase-admin/auth');

const PROJECT = 'unico-operations';
const WEB_KEY = 'AIzaSyCK0M-EfmOp9nh1-ZJcrBqT7c4plNxL2FM'; // public web apiKey (client-side by design)
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const MGR_EMAIL = 'mgr-ruletest@unico.test';

const asFields = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { integerValue: String(v) }])) });

async function idTokenFor(email) {
  const custom = await getAuth().createCustomToken(`rt-${email}`, { email });
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('token exchange failed: ' + JSON.stringify(j));
  return j.idToken;
}

// PATCH a doc (create-or-update). token=null → unauthenticated. Returns HTTP status.
async function write(token, docPath, fields) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${DOCS}/${docPath}${token ? '' : `?key=${WEB_KEY}`}`;
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(asFields(fields)) });
  return r.status;
}

async function main() {
  const database = db();
  // Seed a throwaway ACTIVE MANAGER so plUser()/plExists() resolve for them.
  await database.doc(`apps/plasticjobwork/users/${MGR_EMAIL}`).set({ email: MGR_EMAIL, role: 'manager', active: true });
  // Current counter value so the manager "write" is a no-op (doesn't bump the live sequence).
  const cSnap = await database.doc('apps/plasticjobwork/meta/counter').get();
  const cVal = cSnap.exists ? (cSnap.data().value || 0) : 0;

  const mgr = await idTokenFor(MGR_EMAIL);
  const owner = await idTokenFor('nspenterprises24@gmail.com'); // bootstrap owner

  const ALLOW = (s) => s === 200, DENY = (s) => s === 403 || s === 401;
  const cases = [
    ['MGR   write meta/__ruletest (rates/recipe/lock)   → DENY',  DENY,  () => write(mgr, 'apps/plasticjobwork/meta/__ruletest', { x: 1 })],
    ['MGR   write meta/counter    (production save)      → ALLOW', ALLOW, () => write(mgr, 'apps/plasticjobwork/meta/counter', { value: cVal })],
    ['MGR   write production/__ruletest (core flow)      → ALLOW', ALLOW, () => write(mgr, 'apps/plasticjobwork/production/__ruletest', { t: 1 })],
    ['OWNER write meta/__ruletest (owner keeps control)  → ALLOW', ALLOW, () => write(owner, 'apps/plasticjobwork/meta/__ruletest', { x: 2 })],
    ['ANON  write meta/counter                           → DENY',  DENY,  () => write(null, 'apps/plasticjobwork/meta/counter', { value: cVal })],
    ['ANON  write production/__ruletest2                 → DENY',  DENY,  () => write(null, 'apps/plasticjobwork/production/__ruletest2', { t: 1 })],
  ];

  let fails = 0;
  for (const [label, ok, run] of cases) {
    const s = await run();
    const pass = ok(s);
    if (!pass) fails++;
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  (HTTP ${s})  ${label}`);
  }

  // Cleanup — remove every throwaway doc; counter untouched (no-op writes).
  await Promise.all([
    database.doc(`apps/plasticjobwork/users/${MGR_EMAIL}`).delete(),
    database.doc('apps/plasticjobwork/meta/__ruletest').delete(),
    database.doc('apps/plasticjobwork/production/__ruletest').delete(),
    database.doc('apps/plasticjobwork/production/__ruletest2').delete(),
  ]);
  console.log(`\n${cases.length - fails}/${cases.length} passed. Cleaned up test docs.`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
