/**
 * One-off: set up email+password logins for UNICO Hisab (2 users).
 *  • Owner  nspenterprises24@gmail.com — add a password to the existing account
 *    (it already exists as a Google login; adding a password keeps the same email,
 *    so the bootstrapOwner Firestore rule still grants full access).
 *  • Anshul anshul@unicoproductsindia.com — create the account + allowlist doc
 *    apps/hisab/users/{email} {active:true} so the hiUser() rule grants access.
 * Prints the two passwords ONCE. Not stored anywhere. Re-runnable (idempotent).
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { initializeApp, cert, getApps } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore } = require('firebase-admin/firestore')

const sa = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'firebase-admin.json'), 'utf8'))
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) })
const auth = getAuth(app)
const db = getFirestore(app)

const OWNER = 'nspenterprises24@gmail.com'
const ANSHUL = 'anshul@unicoproductsindia.com'

// Typeable passphrase: two words + 4 digits (~good enough; iPhone autofill saves it).
const W = ['steel', 'laser', 'unico', 'weld', 'chrome', 'metal', 'plant', 'coil', 'bend', 'forge', 'grind', 'tiger', 'delhi', 'panel']
const pass = () => {
  const w = () => W[crypto.randomInt(W.length)]
  return `${w()}-${w()}-${crypto.randomInt(1000, 9999)}`
}

async function ensurePassword(email, name) {
  const pw = pass()
  let uid
  try {
    const u = await auth.getUserByEmail(email)
    uid = u.uid
    await auth.updateUser(uid, { password: pw, emailVerified: true })
    console.log(`  updated existing account: ${email}`)
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      const u = await auth.createUser({ email, password: pw, emailVerified: true, displayName: name })
      uid = u.uid
      console.log(`  created new account: ${email}`)
    } else { throw e }
  }
  return { email, pw, uid }
}

;(async () => {
  const owner = await ensurePassword(OWNER, 'Nishant (Owner)')
  const anshul = await ensurePassword(ANSHUL, 'Anshul')

  // Anshul needs an allowlist doc (owner is granted by the bootstrapOwner rule).
  await db.doc(`apps/hisab/users/${ANSHUL}`).set(
    { active: true, name: 'Anshul', role: 'user', createdAt: new Date().toISOString() },
    { merge: true },
  )
  console.log(`  allowlist doc written: apps/hisab/users/${ANSHUL} {active:true}`)

  console.log('\n================ HISAB LOGINS (share once, then delete this message) ================')
  console.log(`  OWNER   email: ${owner.email}`)
  console.log(`          password: ${owner.pw}`)
  console.log(`  ANSHUL  email: ${anshul.email}`)
  console.log(`          password: ${anshul.pw}`)
  console.log('=====================================================================================')
  process.exit(0)
})().catch((e) => { console.error('FAILED:', e); process.exit(1) })
