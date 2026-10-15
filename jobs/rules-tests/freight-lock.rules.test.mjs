/**
 * Transport Freight — settled-period lock (tfLocked, review 12-10-2026 gap 2).
 * Run like laser-meter.rules.test.mjs (see README): copy into ~/laser-rules-test and
 *   firebase emulators:exec --only firestore --project unico-operations "node --test freight-lock.rules.test.mjs"
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc, getDoc, runTransaction, increment } from 'firebase/firestore'

const RULES = process.env.RULES_FILE || '/home/nishel/attendance-app/firestore.rules'
const OWNER = 'nspenterprises24@gmail.com'
const MANAGER = 'anshul@example.com'
const GW = 'bharat@example.com'      // gaadiwala of T1
const NS = 'apps/transportfreight'
const T1 = 'T1', T2 = 'T2'            // T1 settled through 2026-10-05; T2 never settled

let env, n = 0
const id = (p) => `${p}_${String(++n).padStart(4, '0')}`
const ctx = (email) => env.authenticatedContext(email.replace(/[^a-z0-9]/g, ''), { email, email_verified: true, firebase: { sign_in_provider: 'google.com' } })
const dbOf = (email) => ctx(email).firestore()
const admin = async (fn) => { let out; await env.withSecurityRulesDisabled(async (c) => { out = await fn(c.firestore()) }); return out }

const entry = (over = {}) => ({
  transporterId: T1, transporterName: 'Bharat', date: '2026-10-10', status: 'pending', challanNo: 0, approvedBy: '',
  revision: 0, destinationId: 'D1', bags: 2, freight: 300, lrCharge: 50, unloading: 0, misc: 0, extraPoint: 0,
  pvtMarka: '', remarks: '', gaadiNumber: 'DL1', batchId: 'b1', deleted: false, factoryId: 'main', sourceApp: 'transportfreight', ...over,
})
const advance = (over = {}) => ({ transporterId: T1, transporterName: 'Bharat', date: '2026-10-10', amount: 500, paidBy: 'Anshul', note: '', paymentNo: 1, reversal: false, reversed: false, deleted: false, factoryId: 'main', ...over })

const seedEntry = (eid, over) => admin((d) => setDoc(doc(d, `${NS}/entries`, eid), entry(over)))
const seedAdvance = (aid, over) => admin((d) => setDoc(doc(d, `${NS}/advances`, aid), advance(over)))

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'unico-operations', firestore: { rules: fs.readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 } })
})
beforeEach(async () => {
  await env.clearFirestore()
  await admin(async (d) => {
    await setDoc(doc(d, `${NS}/users`, MANAGER), { role: 'manager', active: true })
    await setDoc(doc(d, `${NS}/users`, GW), { role: 'gaadiwala', active: true, transporterId: T1 })
    await setDoc(doc(d, `${NS}/transporters`, T1), { name: 'Bharat', active: true, runningBalance: 0, alertedLevel: 0, deleted: false, settledThrough: '2026-10-05' })
    await setDoc(doc(d, `${NS}/transporters`, T2), { name: 'Legacy', active: true, runningBalance: 0, alertedLevel: 0, deleted: false })
  })
})
after(async () => { await env?.cleanup() })

// ---- entries: create
test('manager: entry dated AFTER the cutoff is allowed', async () => {
  await assertSucceeds(setDoc(doc(dbOf(MANAGER), `${NS}/entries`, id('e')), entry({ date: '2026-10-06', status: 'passed', challanNo: 5 })))
})
test('manager: entry dated ON the cutoff is refused', async () => {
  await assertFails(setDoc(doc(dbOf(MANAGER), `${NS}/entries`, id('e')), entry({ date: '2026-10-05', status: 'passed', challanNo: 5 })))
})
test('manager: entry dated BEFORE the cutoff is refused', async () => {
  await assertFails(setDoc(doc(dbOf(MANAGER), `${NS}/entries`, id('e')), entry({ date: '2026-09-01', status: 'passed', challanNo: 5 })))
})
test('gaadiwala: own pending trip after the cutoff is allowed, inside it is refused', async () => {
  await assertSucceeds(setDoc(doc(dbOf(GW), `${NS}/entries`, id('e')), entry({ date: '2026-10-07' })))
  await assertFails(setDoc(doc(dbOf(GW), `${NS}/entries`, id('e')), entry({ date: '2026-10-01' })))
})
test('legacy transporter with NO settledThrough: any date is allowed (nothing changes for existing data)', async () => {
  await assertSucceeds(setDoc(doc(dbOf(MANAGER), `${NS}/entries`, id('e')), entry({ transporterId: T2, date: '2025-01-01', status: 'passed', challanNo: 5 })))
  await assertSucceeds(setDoc(doc(dbOf(GW), `${NS}/entries`, id('e')), entry({ date: '2026-10-07' })))
})
test('owner: keeps today\'s powers — may write inside the cutoff (admin repair path)', async () => {
  await assertSucceeds(setDoc(doc(dbOf(OWNER), `${NS}/entries`, id('e')), entry({ date: '2026-09-01', status: 'passed', challanNo: 5 })))
})
test('manager: the chakkar transaction (rows + balance) succeeds after the cutoff, fails inside it', async () => {
  const m = dbOf(MANAGER)
  const run = (date) => runTransaction(m, async (tx) => {
    tx.set(doc(m, `${NS}/entries`, id('e')), entry({ date, status: 'passed', challanNo: 9 }))
    tx.set(doc(m, `${NS}/entries`, id('e')), entry({ date, status: 'passed', challanNo: 9, extraPoint: 50 }))
    tx.set(doc(m, `${NS}/transporters`, T1), { runningBalance: increment(750), updatedAt: 'x' }, { merge: true })
  })
  await assertSucceeds(run('2026-10-08'))
  await assertFails(run('2026-10-05'))
})

// ---- entries: update
test('pending trip on a locked date: gaadiwala may WITHDRAW it (deleted flag), manager may VOID or RETURN it', async () => {
  await seedEntry('p1', { date: '2026-10-01' })
  await seedEntry('p2', { date: '2026-10-01' })
  await seedEntry('p3', { date: '2026-10-01' })
  await assertSucceeds(updateDoc(doc(dbOf(GW), `${NS}/entries`, 'p1'), { deleted: true, revision: 1, updatedAt: 'x' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 'p2'), { status: 'voided', voidReason: 'paper settled', challanNo: 0, approvedBy: '', approvedAt: '', correctionReason: '', cancelReason: '', revision: 1, updatedAt: 'x' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 'p3'), { status: 'needs_correction', correctionReason: 'date', challanNo: 0, approvedBy: '', approvedAt: '', voidReason: '', cancelReason: '', revision: 1, updatedAt: 'x' }))
})
test('pending trip on a locked date: manager may NOT pass it (money below the cutoff)', async () => {
  await seedEntry('p1', { date: '2026-10-01' })
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 'p1'), { status: 'passed', challanNo: 12, approvedBy: MANAGER, approvedAt: 'x', voidReason: '', correctionReason: '', cancelReason: '', revision: 1, updatedAt: 'x' }))
})
test('pending trip on a locked date: gaadiwala may NOT edit its amounts or re-date it', async () => {
  await seedEntry('p1', { date: '2026-10-01' })
  await assertFails(updateDoc(doc(dbOf(GW), `${NS}/entries`, 'p1'), { freight: 900, revision: 1, updatedAt: 'x' }))
  await assertFails(updateDoc(doc(dbOf(GW), `${NS}/entries`, 'p1'), { date: '2026-10-09', revision: 1, updatedAt: 'x' }))
})
test('passed trip on a locked date: manager may NOT cancel it, nor move it OUT of the period', async () => {
  await seedEntry('s1', { date: '2026-10-01', status: 'passed', challanNo: 3 })
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 's1'), { status: 'cancelled', cancelReason: 'x', revision: 1, updatedAt: 'x' }))
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 's1'), { date: '2026-10-09', revision: 1, updatedAt: 'x' }))
})
test('passed trip AFTER the cutoff: manager may NOT move it INTO the period, may still edit it otherwise', async () => {
  await seedEntry('s2', { date: '2026-10-08', status: 'passed', challanNo: 3 })
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 's2'), { date: '2026-10-02', revision: 1, updatedAt: 'x' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/entries`, 's2'), { freight: 350, revision: 1, updatedAt: 'x' }))
})
test('owner: may cancel a passed trip on a locked date (unchanged power)', async () => {
  await seedEntry('s1', { date: '2026-10-01', status: 'passed', challanNo: 3 })
  await assertSucceeds(updateDoc(doc(dbOf(OWNER), `${NS}/entries`, 's1'), { status: 'cancelled', cancelReason: 'x', revision: 1, updatedAt: 'x' }))
})

// ---- advances / reversals
test('manager: payment dated after the cutoff allowed; on/before refused; legacy transporter allowed', async () => {
  await assertSucceeds(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, id('a')), advance({ date: '2026-10-06' })))
  await assertFails(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, id('a')), advance({ date: '2026-10-05' })))
  await assertFails(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, id('a')), advance({ date: '2026-09-20' })))
  await assertSucceeds(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, id('a')), advance({ transporterId: T2, date: '2025-01-01' })))
})
test('manager: the payment transaction (record + balance) is refused as a whole inside the cutoff', async () => {
  const m = dbOf(MANAGER)
  const run = (date) => runTransaction(m, async (tx) => {
    tx.set(doc(m, `${NS}/advances`, id('a')), advance({ date }))
    tx.set(doc(m, `${NS}/transporters`, T1), { runningBalance: increment(-500), updatedAt: 'x' }, { merge: true })
  })
  await assertSucceeds(run('2026-10-09'))
  await assertFails(run('2026-10-03'))
  const t = await admin(async (d) => (await getDoc(doc(d, `${NS}/transporters`, T1))).data())
  assert.equal(t.runningBalance, -500, 'only the allowed payment moved the balance')
})
test('manager: reversal (negative payment) follows the same lock', async () => {
  await assertSucceeds(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'rev_1'), advance({ date: '2026-10-09', amount: -500, reversal: true, reversesPaymentNo: 1, paymentNo: 0 })))
  await assertFails(setDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'rev_2'), advance({ date: '2026-10-04', amount: -500, reversal: true, reversesPaymentNo: 2, paymentNo: 0 })))
})
test('manager: a settled payment cannot be re-dated out of, nor an open one into, the period', async () => {
  await seedAdvance('a1', { date: '2026-10-01' })
  await seedAdvance('a2', { date: '2026-10-09' })
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'a1'), { date: '2026-10-09', updatedAt: 'x' }))
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'a1'), { note: 'x', updatedAt: 'x' }))
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'a2'), { date: '2026-10-01', updatedAt: 'x' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/advances`, 'a2'), { note: 'x', updatedAt: 'x' }))
})
test('owner: may write a payment inside the cutoff (settle path writes periodTo-dated payment + cutoff together)', async () => {
  const o = dbOf(OWNER)
  await assertSucceeds(runTransaction(o, async (tx) => {
    tx.set(doc(o, `${NS}/advances`, id('a')), advance({ date: '2026-10-12' }))
    tx.set(doc(o, `${NS}/settlements`, id('s')), { transporterId: T1, periodFrom: '2026-10-06', periodTo: '2026-10-12', locked: true, closingBalance: 0 })
    tx.set(doc(o, `${NS}/transporters`, T1), { runningBalance: 0, settledThrough: '2026-10-12', updatedAt: 'x' }, { merge: true })
  }))
})

// ---- transporter cutoff only moves forward
test('manager: cannot lower or blank settledThrough; may raise it; other fields still editable; owner may lower', async () => {
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/transporters`, T1), { settledThrough: '2026-09-01' }))
  await assertFails(updateDoc(doc(dbOf(MANAGER), `${NS}/transporters`, T1), { settledThrough: '' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/transporters`, T1), { settledThrough: '2026-10-20' }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/transporters`, T1), { runningBalance: 10, alertedLevel: 0 }))
  await assertSucceeds(updateDoc(doc(dbOf(MANAGER), `${NS}/transporters`, T2), { runningBalance: 10 }))
  await assertSucceeds(updateDoc(doc(dbOf(OWNER), `${NS}/transporters`, T1), { settledThrough: '2026-09-01' }))
})
