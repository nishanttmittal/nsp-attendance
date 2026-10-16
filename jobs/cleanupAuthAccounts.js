// One-off login-account cleanup (owner 17-10-2026: "Deleting the 1,232 old silent accounts and the two unused test
// accounts ... do it").
//   node cleanupAuthAccounts.js           → DRY RUN: counts only, deletes nothing
//   node cleanupAuthAccounts.js --delete  → saves a full list to ~/.claude/backups/ first, then deletes
// Deletes ONLY: (a) anonymous accounts (no email, no provider) idle for more than 30 days, and
//               (b) the two never-used password test accounts test-…@unico.local.
// Keeps every Google/password login, the WhatsApp sender, and every anonymous account used in the last 30 days.
// Deleting a silent account loses no data: a phone that comes back simply gets a new silent account on next open.
const fs = require('fs')
const os = require('os')
const path = require('path')
require('./lib/firestore').db()
const { getAuth } = require('firebase-admin/auth')

const IDLE_DAYS = 30
const TEST_EMAILS = ['test-staff@unico.local', 'test-owner@unico.local']
const WA_SENDER_UID = 'h9CtDCooxzSr3C0CCxjo3cPF0w63'
const DELETE = process.argv.includes('--delete')

const lastActive = u => Math.max(
  Date.parse(u.metadata.lastRefreshTime || 0) || 0,
  Date.parse(u.metadata.lastSignInTime || 0) || 0,
  Date.parse(u.metadata.creationTime) || 0)

;(async () => {
  const auth = getAuth()
  let token, all = []
  do { const r = await auth.listUsers(1000, token); all.push(...r.users); token = r.pageToken } while (token)
  const cutoff = Date.now() - IDLE_DAYS * 864e5

  const oldAnon = all.filter(u => !u.email && !u.phoneNumber && u.providerData.length === 0
    && u.uid !== WA_SENDER_UID && lastActive(u) < cutoff)
  const tests = all.filter(u => TEST_EMAILS.includes((u.email || '').toLowerCase())
    && u.providerData.every(p => p.providerId === 'password') && !u.metadata.lastSignInTime)
  const keepAnon = all.filter(u => !u.email && u.providerData.length === 0).length - oldAnon.length

  console.log(`accounts now: ${all.length}`)
  console.log(`delete: ${oldAnon.length} silent accounts idle > ${IDLE_DAYS} days + ${tests.length} test accounts (${tests.map(u => u.email).join(', ')})`)
  console.log(`keep:   ${all.length - oldAnon.length - tests.length} (incl. ${keepAnon} silent accounts active in the last ${IDLE_DAYS} days)`)
  if (!DELETE) { console.log('DRY RUN — nothing deleted. Run again with --delete.'); return }

  const victims = [...oldAnon, ...tests]
  const backupDir = path.join(os.homedir(), '.claude', 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const file = path.join(backupDir, `auth-accounts-deleted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(victims.map(u => ({
    uid: u.uid, email: u.email || null, providers: u.providerData.map(p => p.providerId),
    created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || null, lastRefresh: u.metadata.lastRefreshTime || null,
  })), null, 1))
  console.log(`backup list saved: ${file}`)

  let ok = 0, failed = 0
  for (let i = 0; i < victims.length; i += 1000) {
    const r = await auth.deleteUsers(victims.slice(i, i + 1000).map(u => u.uid))
    ok += r.successCount; failed += r.failureCount
    r.errors.slice(0, 5).forEach(e => console.log('  failed:', e.error.message))
  }
  console.log(`deleted ${ok}, failed ${failed}`)
})().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1) })
