import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'

const CARD = '250811133266'
const DATE = '20260819'
const ID = `${CARD}_${DATE}`
const OWNER = 'nspenterprises24@gmail.com'      // bootstrap owner
const STAFF = 'staff@example.com'
const OTHER = 'stranger@example.com'
const INACTIVE = 'inactive@example.com'

let env
const ctx = (email, provider = 'google.com') => env.authenticatedContext(
  email ? email.replace(/[^a-z]/g, '') : 'anon',
  email ? { email, firebase: { sign_in_provider: provider } } : { firebase: { sign_in_provider: 'anonymous' } })
const dbOf = (email, provider) => ctx(email, provider).firestore()

const reading = (over = {}) => ({
  cardId: CARD, date: DATE, meterA: 100, meterB: 50, total: 150,
  note: '', enteredBy: STAFF, createdAt: serverTimestamp(), schemaVersion: 2, ...over,
})

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'unico-operations',
    firestore: { rules: fs.readFileSync('/home/nishel/attendance-app/firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  })
  // seed the allowlist with security rules disabled
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore()
    await setDoc(doc(d, 'apps/laser/users', STAFF), { email: STAFF, role: 'meter', active: true })
    await setDoc(doc(d, 'apps/laser/users', INACTIVE), { email: INACTIVE, role: 'meter', active: false })
  })
})
after(async () => { await env?.cleanup() })

const freshDoc = async (data = {}) => {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'laser_meter', ID), {
      cardId: CARD, date: DATE, meterA: 100, meterB: 50, total: 150, note: '',
      enteredBy: STAFF, schemaVersion: 2, ...data,
    })
  })
}
const clear = async () => {
  await env.withSecurityRulesDisabled(async (c) => { await deleteDoc(doc(c.firestore(), 'laser_meter', ID)) })
}

test('meter staff creates a missing valid reading — ALLOWED', async () => {
  await clear()
  await assertSucceeds(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading()))
})

test('meter staff creating with someone else\'s email — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ enteredBy: OWNER })))
})

test('meter staff overwriting an existing reading — DENIED', async () => {
  await freshDoc()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ meterA: 999 })))
})

test('meter staff deleting a reading — DENIED', async () => {
  await freshDoc()
  await assertFails(deleteDoc(doc(dbOf(STAFF), 'laser_meter', ID)))
})

test('total inconsistent with A + B — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ total: 999 })))
})

test('unexpected extra field — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ sneaky: true })))
})

test('document id not matching card_date — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', 'wrong_id'), reading()))
})

test('client-supplied timestamp instead of server time — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ createdAt: Date.now() })))
})

test('negative reading — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), reading({ meterA: -5, total: 45 })))
})

test('inactive user creates or reads — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(INACTIVE), 'laser_meter', ID), reading({ enteredBy: INACTIVE })))
  await freshDoc()
  await assertFails(getDoc(doc(dbOf(INACTIVE), 'laser_meter', ID)))
})

test('unrelated signed-in Google user — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(OTHER), 'laser_meter', ID), reading({ enteredBy: OTHER })))
  await freshDoc()
  await assertFails(getDoc(doc(dbOf(OTHER), 'laser_meter', ID)))
})

test('anonymous user — DENIED', async () => {
  await clear()
  await assertFails(setDoc(doc(dbOf(null, 'anonymous'), 'laser_meter', ID), reading()))
  await freshDoc()
  await assertFails(getDoc(doc(dbOf(null, 'anonymous'), 'laser_meter', ID)))
})

test('owner creates a missing reading — ALLOWED', async () => {
  await clear()
  await assertSucceeds(setDoc(doc(dbOf(OWNER), 'laser_meter', ID), reading({ enteredBy: OWNER })))
})

test('owner performs an approved correction — ALLOWED', async () => {
  await freshDoc()
  await assertSucceeds(setDoc(doc(dbOf(OWNER), 'laser_meter', ID), {
    cardId: CARD, date: DATE, meterA: 120, meterB: 50, total: 170, note: '',
    enteredBy: STAFF, schemaVersion: 2,
    correctedBy: OWNER, correctedAt: serverTimestamp(), correctionId: 'op_1',
  }))
})

test('owner correction on a LEGACY doc without enteredBy/createdAt — ALLOWED', async () => {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'laser_meter', ID), {
      cardId: CARD, date: DATE, meterA: 100, meterB: 50, total: 150, note: '', enteredAt: 1234567890,
    })
  })
  await assertSucceeds(setDoc(doc(dbOf(OWNER), 'laser_meter', ID), {
    cardId: CARD, date: DATE, meterA: 120, meterB: 50, total: 170, note: '', enteredAt: 1234567890,
    correctedBy: OWNER, correctedAt: serverTimestamp(), correctionId: 'op_2',
  }))
})

test('owner correction that changes the date — DENIED', async () => {
  await freshDoc()
  await assertFails(setDoc(doc(dbOf(OWNER), 'laser_meter', ID), {
    cardId: CARD, date: '20260101', meterA: 120, meterB: 50, total: 170, note: '',
    enteredBy: STAFF, schemaVersion: 2, correctedBy: OWNER, correctedAt: serverTimestamp(), correctionId: 'op_3',
  }))
})

test('staff attempting a correction-shaped update — DENIED', async () => {
  await freshDoc()
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter', ID), {
    cardId: CARD, date: DATE, meterA: 120, meterB: 50, total: 170, note: '',
    enteredBy: STAFF, schemaVersion: 2, correctedBy: STAFF, correctedAt: serverTimestamp(), correctionId: 'op_4',
  }))
})

test('owner hard-deletes a reading — DENIED', async () => {
  await freshDoc()
  await assertFails(deleteDoc(doc(dbOf(OWNER), 'laser_meter', ID)))
})

test('correction record: owner creates — ALLOWED; anyone edits or deletes it — DENIED', async () => {
  const rec = {
    operationId: 'op_9', cardId: CARD, meterDocId: ID, date: DATE,
    before: { meterA: 100, meterB: 50, total: 150, note: '' },
    after: { cardId: CARD, date: DATE, meterA: 120, meterB: 50, total: 170, note: '' },
    reason: 'digit mistyped', correctedBy: OWNER, correctedAt: serverTimestamp(),
  }
  await assertSucceeds(setDoc(doc(dbOf(OWNER), 'laser_meter_corrections', 'op_9'), rec))
  // immutable afterwards
  await assertFails(setDoc(doc(dbOf(OWNER), 'laser_meter_corrections', 'op_9'), { ...rec, reason: 'changed my mind' }))
  await assertFails(deleteDoc(doc(dbOf(OWNER), 'laser_meter_corrections', 'op_9')))
  // staff can neither write nor read the audit trail
  await assertFails(setDoc(doc(dbOf(STAFF), 'laser_meter_corrections', 'op_10'), { ...rec, correctedBy: STAFF }))
  await assertFails(getDoc(doc(dbOf(STAFF), 'laser_meter_corrections', 'op_9')))
})

test('correction record without a reason — DENIED', async () => {
  await assertFails(setDoc(doc(dbOf(OWNER), 'laser_meter_corrections', 'op_11'), {
    operationId: 'op_11', cardId: CARD, meterDocId: ID, date: DATE,
    reason: '', correctedBy: OWNER, correctedAt: serverTimestamp(),
  }))
})
