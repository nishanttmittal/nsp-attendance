/**
 * One-off: enable the Email/Password sign-in provider on the `unico-operations`
 * Identity Platform config. TARGETED patch (updateMask=signIn.email.enabled) so
 * it ONLY flips email on — the anonymous + Google providers are untouched
 * (anonymous is load-bearing across all apps; do not disable it). Idempotent.
 */
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const sa = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'firebase-admin.json'), 'utf8'))
const PROJECT = sa.project_id

;(async () => {
  const auth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired`
  const res = await client.request({
    url, method: 'PATCH',
    data: { signIn: { email: { enabled: true, passwordRequired: true } } },
  })
  console.log('signIn.email now:', JSON.stringify(res.data.signIn?.email))
  console.log('signIn.anonymous still:', JSON.stringify(res.data.signIn?.anonymous))
  process.exit(0)
})().catch((e) => { console.error('FAILED:', e.response?.data || e.message); process.exit(1) })
