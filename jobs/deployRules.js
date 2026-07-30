// Deploy the ONE canonical Firestore ruleset LIVE. Creates a new ruleset and points the
// cloud.firestore release at it. Uses the firebase-admin service account — no interactive login.
//   node deployRules.js          # publish (shows a diff, then asks for confirmation)
//   node deployRules.js --dry    # validate only — creates NOTHING in the project
//
// Validation uses projects:test, which checks syntax + semantics WITHOUT creating anything.
// A ruleset is only created after you confirm, because rulesets are persistent and immutable —
// validating with rulesets.create would leave orphaned rulesets behind on every aborted run.
// Always run getRules.js first if you want the latest live copy as your base.
//
// SAFETY: every UNICO app shares ONE ruleset and it lives at attendance-app/firestore.rules.
// Copies of firestore.rules used to sit in 8 other repos; they were deleted 2026-07-28 because
// deploying the wrong one would silently change permissions for every app. This script now
// REFUSES to run unless the file it is about to publish really is the canonical one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { client, liveFirestoreRules } = require('./getRules');
const key = require('./firebase-admin.json');

const PROJECT = key.project_id;
const DRY = process.argv.includes('--dry');

// The only path this script is ever allowed to publish from.
const CANONICAL_SUFFIX = path.join('attendance-app', 'firestore.rules');
// Secondary sanity signal ONLY — never the main guard. The legitimate ruleset may shrink.
const EXPECT_MIN_BYTES = 8000;

// --- Guard: resolve the real path and prove it is the canonical file -------------------
function resolveCanonicalRulesPath() {
  const candidate = path.join(__dirname, '..', 'firestore.rules');
  if (!fs.existsSync(candidate)) {
    throw new Error(`no rules file at ${candidate} — run getRules.js first`);
  }
  const real = fs.realpathSync(candidate); // follows symlinks; absolute
  if (!real.endsWith(path.sep + CANONICAL_SUFFIX)) {
    throw new Error(
      `REFUSING TO DEPLOY — not the canonical ruleset.\n` +
      `  resolved: ${real}\n` +
      `  expected a path ending in: ${path.sep}${CANONICAL_SUFFIX}\n` +
      `  All UNICO apps share ONE ruleset. Deploy only from the attendance-app repo.`
    );
  }
  // The canonical repo must actually be this tooling's repo, not a folder that merely got renamed.
  const repoRoot = path.dirname(real);
  for (const marker of ['jobs/getRules.js', 'jobs/deployRules.js', 'jobs/rules_backup']) {
    if (!fs.existsSync(path.join(repoRoot, marker))) {
      throw new Error(
        `REFUSING TO DEPLOY — ${repoRoot} does not look like the attendance-app repo ` +
        `(missing ${marker}).`
      );
    }
  }
  return real;
}

// --- Inspection report: path, size, fingerprint, and a diff vs what is LIVE right now ---
function describe(label, content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length;
  const matches = (content.match(/^\s*match\s+\//gm) || []).length;
  const sha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  return `${label}: ${bytes} bytes · ${lines} lines · ${matches} match blocks · sha256:${sha}`;
}

function showDiff(liveContent, newContent) {
  if (liveContent === newContent) {
    console.log('\nDIFF vs LIVE: identical — nothing would change.');
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulesdiff-'));
  const a = path.join(dir, 'live.rules');
  const b = path.join(dir, 'new.rules');
  fs.writeFileSync(a, liveContent);
  fs.writeFileSync(b, newContent);
  console.log('\nDIFF vs LIVE  (- currently live, + about to publish)');
  console.log('------------------------------------------------------------');
  try {
    execFileSync('diff', ['-u', '--label', 'LIVE', '--label', 'NEW', a, b], { stdio: 'inherit' });
  } catch (e) {
    if (e.status !== 1) {
      // `diff` unavailable or failed for a real reason — fall back to a coarse summary.
      const la = liveContent.split('\n');
      const lb = newContent.split('\n');
      const setA = new Set(la);
      const setB = new Set(lb);
      console.log(`  (diff tool unavailable: ${e.message})`);
      console.log(`  removed lines: ${la.filter(l => !setB.has(l)).length}`);
      console.log(`  added lines:   ${lb.filter(l => !setA.has(l)).length}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('------------------------------------------------------------');
  return true;
}

// Validate WITHOUT creating anything. projects:test compiles the source and returns any
// syntax/semantic issues; it never persists a ruleset. Returns true if it actually ran.
//
// ✅ RESOLVED 2026-07-31. The service account previously lacked `firebaserules.rulesets.test`
// and this returned 403. Owner granted it via a LEAST-PRIVILEGE custom role — "Firestore Rules
// Tester" (projects/unico-operations/roles/CustomRole), containing that ONE permission, not
// roles/firebaserules.admin (which would also allow create/delete/update).
// Confirmed working: "Validated OK (projects:test) — 0 warning(s), no ruleset created."
// The 403 fallback below is KEPT deliberately: it is what makes this survive a future IAM change.
// Note: the grant took ~1 minute to propagate — a 403 immediately after granting is not a failure.
async function validateOnly(c, content) {
  let res;
  try {
    res = await c.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`,
      method: 'POST',
      data: { source: { files: [{ name: 'firestore.rules', content }] } },
    });
  } catch (e) {
    if (e.response?.status === 403) {
      console.log('⚠️  Pre-confirmation validation unavailable: the service account lacks');
      console.log('    `firebaserules.rulesets.test`. Grant it (roles/firebaserules.admin) to');
      console.log('    validate before creating anything. Rules will still be compile-checked');
      console.log('    at creation time — after you confirm, before the live release switches.');
      return false;
    }
    throw new Error('validation call failed: ' + JSON.stringify(e.response?.data || e.message));
  }

  const issues = res.data.issues || [];
  const errors = issues.filter(i => i.severity === 'ERROR');
  for (const i of issues) {
    const at = i.sourcePosition ? ` (line ${i.sourcePosition.line}, col ${i.sourcePosition.column})` : '';
    console.log(`  ${i.severity}: ${i.description}${at}`);
  }
  if (errors.length) throw new Error(`ruleset rejected — ${errors.length} error(s); nothing was created.`);
  console.log(`Validated OK (projects:test) — ${issues.length} warning(s), no ruleset created.`);
  return true;
}

function confirm(question) {
  if (!process.stdin.isTTY) {
    throw new Error(
      'REFUSING TO DEPLOY — no terminal to confirm on. Publishing rules must be done ' +
      'interactively. Run `node deployRules.js` yourself in a terminal.'
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const rulesPath = resolveCanonicalRulesPath();
  const content = fs.readFileSync(rulesPath, 'utf8');

  console.log('Project     :', PROJECT);
  console.log('Rules file  :', rulesPath);
  console.log(describe('Local (to publish)', content));
  if (Buffer.byteLength(content, 'utf8') < EXPECT_MIN_BYTES) {
    console.log(
      `⚠️  WARNING: only ${Buffer.byteLength(content, 'utf8')} bytes (below the usual ~${EXPECT_MIN_BYTES}). ` +
      'That can be legitimate, but check the diff below before publishing.'
    );
  }

  const c = await client();

  // Show exactly what would change, against the ruleset that is live right now.
  let live = null;
  try {
    live = await liveFirestoreRules(c);
    console.log(describe('Live  (current)   ', live.content));
    console.log('Live ruleset:', live.rulesetName);
  } catch (e) {
    console.log('⚠️  could not read the live ruleset for comparison:', e.message);
  }
  // REFUSE to publish blind (fix 2026-07-30, Codex review). Without the live ruleset there is no
  // diff to review AND no rollback copy to fall back on — and with projects:test currently 403ing,
  // both pre-publish protections would be absent at once. A dry run is still allowed.
  if (!live && !DRY) {
    throw new Error(
      'REFUSING TO DEPLOY — could not read the LIVE ruleset, so there is no diff to review and no ' +
      'rollback copy. Fix the read (or run with --dry) before publishing. Never publish blind.');
  }
  const changed = live ? showDiff(live.content, content) : true;

  // 1. validate — creates NOTHING in the project
  console.log('');
  const validated = await validateOnly(c, content);

  if (DRY) {
    console.log(validated
      ? '--dry: validated only. No ruleset created, nothing published.'
      : '--dry: could NOT validate (see above). Nothing was created, nothing published.');
    process.exitCode = validated ? 0 : 2;
    return;
  }
  if (live && !changed) { console.log('Nothing to publish — local file already matches live.'); return; }

  // 2. explicit confirmation — this changes permissions for EVERY UNICO app
  console.log('\nThis publishes the ruleset LIVE for every UNICO app (welder, plating, fitting,');
  console.log('orders, attendance, hisab, transport, plastic, laser, costing). Review the diff above.');
  const ans = await confirm(`Type the project id "${PROJECT}" to publish (anything else aborts): `);
  if (ans !== PROJECT) { console.log('Aborted — nothing was created and nothing was published.'); return; }

  // 3. keep a rollback copy of what is live BEFORE replacing it
  if (live) {
    const backupDir = path.join(__dirname, 'rules_backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `firestore-PRE-DEPLOY-${stamp}.rules`);
    fs.writeFileSync(backupFile, live.content);
    console.log('Rollback copy of the LIVE rules ->', backupFile);
  }

  // 4. create the ruleset (persistent + immutable — only now, after confirmation)
  const created = await c.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets`,
    method: 'POST',
    data: { source: { files: [{ name: 'firestore.rules', content }] } },
  }).catch(e => { throw new Error('ruleset rejected: ' + JSON.stringify(e.response?.data || e.message)); });
  const rulesetName = created.data.name;
  console.log('Created ruleset ->', rulesetName);

  // 5. point the cloud.firestore release at the new ruleset
  await c.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`,
    method: 'PATCH',
    data: { release: { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName } },
  });
  console.log('PUBLISHED LIVE. cloud.firestore ->', rulesetName);
  // Read back and PROVE the release actually points at what we just created (Codex review 2026-07-30):
  // the PATCH returning 200 is not by itself evidence that the live rules changed.
  try {
    const after = await liveFirestoreRules(c);
    if (after.rulesetName === rulesetName && after.content === content) {
      console.log('✅ VERIFIED: live release now serves this exact ruleset.');
    } else {
      console.error('🚨 POST-DEPLOY MISMATCH — live release is', after.rulesetName, 'not', rulesetName);
      console.error('   Roll back with the pre-deploy copy in jobs/rules_backup/.');
      process.exitCode = 3;
    }
  } catch (e) {
    console.error('⚠️  could not verify the deploy (read-back failed):', e.message);
    process.exitCode = 3;
  }
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { resolveCanonicalRulesPath, describe, confirm };
