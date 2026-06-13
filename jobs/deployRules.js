// Deploy ../firestore.rules LIVE to the project. Creates a new ruleset and points the
// cloud.firestore release at it. Uses the firebase-admin service account — no interactive login.
//   node deployRules.js          # deploy ../firestore.rules
//   node deployRules.js --dry    # compile/validate only, do NOT publish
// Always run getRules.js first if you want the latest live copy as your base.
const fs = require('fs');
const path = require('path');
const { client } = require('./getRules');
const key = require('./firebase-admin.json');

const PROJECT = key.project_id;
const DRY = process.argv.includes('--dry');

async function main() {
  const rulesPath = path.join(__dirname, '..', 'firestore.rules');
  const content = fs.readFileSync(rulesPath, 'utf8');
  const c = await client();

  // 1. create (and compile-check) the ruleset
  const created = await c.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets`,
    method: 'POST',
    data: { source: { files: [{ name: 'firestore.rules', content }] } },
  }).catch(e => { throw new Error('ruleset rejected: ' + JSON.stringify(e.response?.data || e.message)); });
  const rulesetName = created.data.name;
  console.log('Compiled OK ->', rulesetName);

  if (DRY) { console.log('--dry: validated only, NOT published.'); return; }

  // 2. point the cloud.firestore release at the new ruleset
  await c.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`,
    method: 'PATCH',
    data: { release: { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName } },
  });
  console.log('PUBLISHED LIVE. cloud.firestore ->', rulesetName);
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
