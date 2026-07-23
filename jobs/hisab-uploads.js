/**
 * hisab-uploads — drains the UNICO Hisab photo queue (apps/hisab/uploads).
 * The owner uploads a khata/kharcha photo in the app → a 'pending' doc with the
 * compressed image. When Claude's system is running:
 *   1) node hisab-uploads.js pull                      → saves images + manifest
 *   2) Claude READS each image and builds entries
 *   3) node hisab-uploads.js commit-expenses <id> '<json>'   → adds + clears upload
 *      node hisab-uploads.js commit-ledger <id> <supplierId> '<json>'
 * The app's realtime listener then shows the new entries on every device.
 */
const { db } = require('./lib/firestore')
const fs = require('fs')

const OUT = '/tmp/hisab-uploads'
const uploads = () => db().collection('apps').doc('hisab').collection('uploads')
const expenses = () => db().collection('apps').doc('hisab').collection('expenses')
const ledger = () => db().collection('apps').doc('hisab').collection('ledger')
const nowISO = () => new Date().toISOString()

async function pull() {
  const snap = await uploads().get()
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = []
  snap.forEach((d) => {
    const u = d.data()
    if (u.status === 'done') return
    let file = null
    if (typeof u.image === 'string' && u.image.startsWith('data:')) {
      file = `${OUT}/${d.id}.jpg`
      fs.writeFileSync(file, Buffer.from(u.image.split(',')[1], 'base64'))
    }
    manifest.push({ id: d.id, kind: u.kind || 'expense', note: u.note || '', createdAt: u.createdAt, file })
  })
  console.log(JSON.stringify(manifest, null, 2))
}

async function commitExpenses(uploadId, entriesJson) {
  const entries = JSON.parse(entriesJson)
  const b = db().batch(); let i = Date.now()
  for (const e of entries) {
    const id = 'up_' + (i++)
    const rec = { id, date: String(e.date || ''), desc: String(e.desc || ''), amount: Number(e.amount) || 0,
      cat: String(e.cat || 'Misc'), createdAt: nowISO(), updatedAt: nowISO(), source: 'photo' }
    if (e.adv) rec.adv = true; if (e.material) rec.material = true
    b.set(expenses().doc(id), rec)
  }
  b.delete(uploads().doc(uploadId))
  await b.commit()
  console.log(`added ${entries.length} expenses; cleared upload ${uploadId}`)
}

async function commitLedger(uploadId, supplierId, entriesJson) {
  const entries = JSON.parse(entriesJson)
  const b = db().batch(); let i = Date.now()
  for (const e of entries) {
    const id = 'up_' + (i++)
    const rec = { id, supplierId, date: String(e.date || ''), particulars: String(e.particulars || ''),
      createdAt: nowISO(), updatedAt: nowISO(), source: 'photo' }
    if (e.purchase) rec.purchase = Number(e.purchase)
    if (e.payment) rec.payment = Number(e.payment)
    if (e.adj) rec.adj = Number(e.adj)
    b.set(ledger().doc(id), rec)
  }
  b.delete(uploads().doc(uploadId))
  await b.commit()
  console.log(`added ${entries.length} ledger rows to ${supplierId}; cleared upload ${uploadId}`)
}

const [cmd, a, b2, c] = process.argv.slice(2)
;(async () => {
  if (cmd === 'pull') await pull()
  else if (cmd === 'commit-expenses') await commitExpenses(a, b2)
  else if (cmd === 'commit-ledger') await commitLedger(a, b2, c)
  else console.log('usage: pull | commit-expenses <uploadId> <json> | commit-ledger <uploadId> <supplierId> <json>')
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
