// Pull the LIVE Firestore rules for the project and save them locally.
// Writes ../firestore.rules (source of truth) + a timestamped backup in jobs/rules_backup/.
// Uses the firebase-admin service account — no interactive login needed.
const fs = require('fs');
const path = require('path');
const { JWT } = require('google-auth-library');
const key = require('./firebase-admin.json');

const PROJECT = key.project_id;
const SCOPES = ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform'];

async function client() { const c = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES }); await c.authorize(); return c; }

async function liveFirestoreRules(c) {
  const rel = await c.request({ url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases` });
  const fsRel = (rel.data.releases || []).find(r => /cloud\.firestore/.test(r.name));
  if (!fsRel) throw new Error('no cloud.firestore release found');
  const rs = await c.request({ url: `https://firebaserules.googleapis.com/v1/${fsRel.rulesetName}` });
  const file = (rs.data.source.files || []).find(f => /firestore/.test(f.name)) || rs.data.source.files[0];
  return { content: file.content, rulesetName: fsRel.rulesetName };
}

async function main() {
  const c = await client();
  const { content, rulesetName } = await liveFirestoreRules(c);
  const backupDir = path.join(__dirname, 'rules_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `firestore-${stamp}.rules`), content);
  fs.writeFileSync(path.join(__dirname, '..', 'firestore.rules'), content);
  console.log(`Live ruleset: ${rulesetName}`);
  console.log(`Saved -> firestore.rules  + backup rules_backup/firestore-${stamp}.rules  (${content.length} bytes)`);
}

if (require.main === module) main().catch(e => { console.error('ERR', e.response?.status, JSON.stringify(e.response?.data || e.message)); process.exit(1); });
module.exports = { client, liveFirestoreRules };
