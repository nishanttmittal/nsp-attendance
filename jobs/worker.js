// Queue worker: processes pending att_job_requests created by the PWA (manual punch,
// onboard, resign, monthly download, payslip). Runs on a frequent GitHub Actions cron.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');
const { sendTelegram, sendTelegramDocument } = require('./lib/notify');
const { drainSelfPunch } = require('./selfPunch');
const { captureLate } = require('./lateCapture');
const { alertLate } = require('./lateAlert');
const { runDueTasks } = require('./scheduler');

const DL = path.resolve(__dirname, 'downloads');

// "2026-07" -> "2026-08" (mirrors web/src/lib/data.js nextMonthKey)
const nextMonthKey = (mk) => {
  const d = new Date(Date.UTC(Number(String(mk).slice(0, 4)), Number(String(mk).slice(5, 7)), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── Job authorization (P1-1) ────────────────────────────────────────────────
// The queue runs with Admin SDK, so a job request is a PRIVILEGED API call — it
// must be authorized here, not just by Firestore create rules. `requestedBy` is
// the signed-in email the PWA stamped on the job.
const BOOTSTRAP_OWNER = 'nspenterprises24@gmail.com';   // same as ADMIN_EMAILS / isAttAdmin
// Money/identity-changing jobs only the OWNER may run.
const OWNER_ONLY = new Set(['finalize_hisab', 'lock_month', 'unlock_month', 'resign_employee', 'reprocess_period', 'monthly_download', 'payslip', 'backup', 'onboard_employee', 'push_employee_edit', 'weeklyoff_audit']);
// Everything the worker knows how to do — unknown types are rejected outright.
const KNOWN_TYPES = new Set(['manual_punch', 'backup', 'onboard_employee', 'push_employee_edit', 'resign_employee', 'reprocess_period', 'weeklyoff_audit', 'scan_missed', 'mark_paid', 'lock_month', 'unlock_month', 'finalize_hisab', 'add_advance', 'monthly_download', 'payslip']);

async function authorizeJob(requestedBy, type) {
  if (!KNOWN_TYPES.has(type)) return { ok: false, reason: `unknown job type '${type}'` };
  const email = String(requestedBy || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no requestedBy' };
  if (email === BOOTSTRAP_OWNER) return { ok: true };            // owner short-circuit — never needs an att_users doc
  // otherwise must be an ACTIVE att_users/{email} manager/owner
  const snap = await db().collection('att_users').doc(email).get();
  const u = snap.exists ? snap.data() : null;
  const activeStaff = !!u && u.active !== false && ['manager', 'admin', 'owner'].includes(u.role);
  if (!activeStaff) return { ok: false, reason: `not an authorized user (${email})` };
  if (OWNER_ONLY.has(type)) return { ok: false, reason: `'${type}' is owner-only` };
  return { ok: true };
}

function run(file, env) {
  try {
    return execFileSync('node', [path.resolve(__dirname, file)], {
      env: { ...process.env, ...env }, encoding: 'utf8', timeout: 260000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // execFileSync's default message is just "Command failed", which hides WHY — that cost us a
    // diagnosis on the 2026-07-22 declare pushes. Surface the child's own error line (ERROR:/VERIFY
    // FAILED:/not found/…) so the job's stored error + the retry classifier can see the real cause.
    const out = `${e.stderr || ''}\n${e.stdout || ''}`;
    const detail = out.split('\n').map((s) => s.trim()).filter(Boolean).reverse()
      .find((l) => /ERROR:|VERIFY FAILED:|WARN:|not found|Gender|timeout|net::/i.test(l))
      || out.trim().split('\n').filter(Boolean).pop() || e.message;
    throw new Error(`${file}: ${detail}`);
  }
}

async function handle(type, p) {
  if (type === 'manual_punch') {
    run('manualPunch.js', { EMP: p.emp, DATE: p.date, IN: p.in || '', OUT: p.out || '', REMARK: p.remark || 'app', DRY: 'false' });
    // attendance-correction log on the employee record (dispute trail: who/when/what/why)
    try {
      const ref = db().collection('att_salary').doc(p.emp);
      const snap = await ref.get();
      const corrections = (snap.exists && snap.data().corrections) || [];
      corrections.push({ date: p.date, in: p.in || '', out: p.out || '', reason: p.reason || p.remark || 'manual', by: p._by || 'app', at: new Date().toISOString() });
      await ref.set({ corrections }, { merge: true });
    } catch (e) { console.error('correction log failed:', e.message); }
    // remove this entry from the missed-punch list NOW so it drops off immediately (don't wait for the next rescan)
    try {
      const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(p.date || '');
      if (m) {
        const mref = db().collection('att_missed_punch').doc(`${m[3]}-${m[2]}`);
        const ms = await mref.get();
        if (ms.exists) {
          const d = ms.data();
          const keep = (arr) => (arr || []).filter(e => !(e.code === p.emp && e.date === p.date));
          await mref.set({ entries: keep(d.entries), shortHours: keep(d.shortHours) }, { merge: true });
        }
      }
    } catch (e) { console.error('missed-list cleanup failed:', e.message); }
    await sendTelegram(`✏️ Punch correction: ${p.emp} on ${p.date} (in ${p.in || '—'}/out ${p.out || '—'})${p.reason ? ' — ' + p.reason : ''}.`);
    return 'punch inserted + day reprocessed + logged + removed from list';
  }
  if (type === 'backup') {
    run('backup.js', { REASON: p.reason || 'on demand' });
    return 'backup sent';
  }
  if (type === 'onboard_employee') {
    // best-effort duplicate guard (2026-07-18): a stale-recovery re-run must not create the same
    // card number twice on the machine. Roster syncs daily, so a same-day retry can still slip
    // through — but this catches the common case cheaply.
    const rosterDoc = (await db().collection('att_meta').doc('roster').get()).data() || {};
    if ((rosterDoc.employees || []).some((x) => String(Number(x.code)) === String(Number(p.cardno)))) {
      return `cardno ${p.cardno} already on the machine roster — skipped (duplicate guard)`;
    }
    run('onboardEmployee.js', { NAME: p.name, CARDNO: p.cardno, DEPT: p.dept, SHIFT: p.shift, GENDER: p.gender, DRY: 'false' });
    await sendTelegram(`🧑‍🏭 New employee added: ${p.name} (${p.cardno}) · ${p.dept} · ${p.shift}.`);
    return 'employee created on machine';
  }
  if (type === 'push_employee_edit') {   // owner edited profile in app → push to the machine
    const env = { PE_CARD: p.code, DRY: 'false' };
    if (p.name) env.PE_NAME = p.name;
    if (p.dept) env.PE_DEPT = p.dept;
    if (p.shift) env.PE_SHIFT = p.shift;
    if (p.gender) env.PE_GENDER = p.gender;
    run('pushEmployeeEdit.js', env);
    const bits = [p.name ? 'name “' + p.name + '”' : '', p.dept ? 'dept ' + p.dept : '', p.shift ? 'shift ' + p.shift : '', p.gender ? p.gender : ''].filter(Boolean).join(' · ');
    await sendTelegram(`✏️ Updated on machine: ${p.code}${bits ? ' · ' + bits : ''}.`);
    return 'profile pushed to machine';
  }
  if (type === 'resign_employee') {
    // Owner rule (2026-07-12): KEEP the worker's record INACTIVE with name + paid history so the owner
    // can always look up whom he paid & when. NO att_archive snapshot (removed) — the live inactive
    // record + the monthly salary_register ARE the permanent record. Machine removal stays manual.
    await sendTelegram(`👋 ${p.code} marked resigned — kept inactive in the salary sheet (name + paid history retained). Machine removal is manual.`).catch(() => {});
    return 'resigned: kept inactive in salary sheet (no archive; machine NOT touched)';
  }
  if (type === 'reprocess_period') {
    run('reprocessRange.js', { FROM: p.from, TO: p.to });
    await sendTelegram(`🔄 Reprocessed attendance ${p.from} → ${p.to}.`);
    return 'reprocessed ' + p.from + '..' + p.to;
  }
  if (type === 'weeklyoff_audit') {   // worked-but-unearned Saturdays → unpaidWorkedSat (OT-only rule)
    const { audit } = require('./weeklyOffAudit');
    const r = await audit(Number(p.month || 0));
    return `weekly-off audit ${r.label}: ${r.flagged} flagged`;
  }
  if (type === 'scan_missed') {     // rescan a chosen month's missed punches for the app's Problems tab
    const { scanMissed } = require('./missedPunchScan');
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    const curMk = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
    const [cy, cm] = curMk.split('-').map(Number);
    const [my, mm] = String(p.month || curMk).split('-').map(Number);
    const offset = (cy * 12 + cm) - (my * 12 + mm);     // 0 = current month, 1 = last month, …
    const n = await scanMissed(Math.max(0, offset));
    await sendTelegram(`🔍 Rescanned ${p.month || curMk}: ${n} missed punch(es) found — see the Problems tab.`);
    return `scanned ${p.month}: ${n}`;
  }
  if (type === 'mark_paid') {    // pay a salary — supports PART payments (e.g. cash today + bank next day)
    const ref = db().collection('att_salary').doc(p.code);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('no employee ' + p.code);
    const e = snap.data();
    const md = (e.months || {})[p.month] || {};
    if (!md.approved) throw new Error('not approved yet');
    // Already FULLY settled → ignore (double-tap / duplicate job / owner+manager both pay).
    // A settlement re-open (md.payment.settlement) is the only legitimate re-pay.
    if (md.payment && !md.payment.settlement) return `already fully paid on ${md.payment.date} (₹${md.payment.net}) — ignored`;
    const due = Number(md.approvedNet || 0);
    const prevPayments = Array.isArray(md.payments) ? md.payments : [];
    const paidBefore = prevPayments.reduce((s, x) => s + Number(x.amount || 0), 0);
    // IDEMPOTENT part: every Pay tap carries a unique payId — a retried/duplicate job with the
    // same id is a no-op, so a re-tap during the queue delay can never double-record a part.
    const payId = p.payId || `pay-${p.month}-legacy`;
    if (prevPayments.some(x => x.id === payId)) return `payment ${payId} already recorded — ignored`;
    // amount handed over NOW (defaults to the whole remaining balance = classic one-tap full pay).
    const thisAmt = p.amount != null ? Number(p.amount) : Math.max(0, due - paidBefore);
    const date = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const [y, m] = p.month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const payments = [...prevPayments, { id: payId, date, mode: p.mode || 'cash', amount: thisAmt, by: p._by || 'manager', remark: p.remark || '' }];
    const paidSoFar = payments.reduce((s, x) => s + Number(x.amount || 0), 0);
    const fullyPaid = paidSoFar >= due - 0.5;   // ½-rupee tolerance
    const months = { ...(e.months || {}) };
    const patch = { months };
    if (fullyPaid) {
      // FULLY paid now → close this worker's hisab (PER-WORKER rule, owner 2026-07-10): lock him +
      // carry his leftover advance forward, so one still-pending worker never holds up the month.
      const extra = Math.max(0, paidSoFar - due);
      const mode = payments.length > 1 ? 'split' : (payments[0].mode || 'cash');
      months[p.month] = { ...md, payments, paidSoFar, locked: true, hisabFinalized: true, finalizedAt: new Date().toISOString(),
        payment: { date, mode, net: paidSoFar, due, extra, parts: payments.length, by: p._by || 'manager', remark: p.remark || '' } };
      months[next] = { ...(months[next] || {}), advanceBalanceIn: Number(md.approvedCarry || 0) };   // leftover advance → next month opening
      // overpayment → NEXT-MONTH advance entry (carried forward). IDEMPOTENT by a deterministic id.
      if (extra > 0) {
        const advId = `extra-${p.month}`;
        if (!(e.advances || []).some(a => a.id === advId))
          patch.advances = [...(e.advances || []), { id: advId, date: `${next}-01`, amount: extra, mode, remark: `extra paid with ${p.month} salary`, paidBy: p._by || 'manager' }];
      }
    } else {
      months[p.month] = { ...md, payments, paidSoFar };   // PART payment — hisab stays OPEN until fully paid
    }
    await ref.set(patch, { merge: true });
    // DURABLE monthly salary register (owner 2026-06-15) — snapshot ONLY once the month is fully
    // settled (net = total actually paid), so the costing total stays accurate. Immutable per month.
    if (fullyPaid) {
      try {
        const regRef = db().collection('att_meta').doc('salary_register_' + p.month);
        const reg = (await regRef.get()).data() || { month: p.month, byCode: {} };
        reg.byCode = reg.byCode || {};
        reg.byCode[p.code] = { name: e.name || p.code, dept: e.dept || '', net: paidSoFar, mode: months[p.month].payment.mode, date, by: p._by || 'manager' };
        reg.total = Object.values(reg.byCode).reduce((s, x) => s + Number(x.net || 0), 0);
        reg.count = Object.keys(reg.byCode).length;
        reg.updatedAt = new Date().toISOString();
        await regRef.set(reg);
      } catch (e2) { console.error('salary register write failed:', e2.message); }
    }
    const remaining = Math.max(0, due - paidSoFar);
    if (fullyPaid) {
      const extra = Math.max(0, paidSoFar - due);
      await sendTelegram(`💵 Paid in full: <b>${e.name || p.code}</b> ₹${paidSoFar.toLocaleString('en-IN')} (${months[p.month].payment.mode}) · ${p.month}${extra > 0 ? ` · ₹${extra.toLocaleString('en-IN')} extra → advance carried forward` : ''}${payments.length > 1 ? ` · ${payments.length} parts` : ''}${p.remark ? ` · ${p.remark}` : ''} · by ${p._by || 'manager'}`);
      return extra > 0 ? `paid in full (₹${extra} extra → advance)` : 'paid in full';
    }
    await sendTelegram(`💵 Part paid: <b>${e.name || p.code}</b> ₹${thisAmt.toLocaleString('en-IN')} (${p.mode || 'cash'}) · ${p.month} · ₹${remaining.toLocaleString('en-IN')} still pending${p.remark ? ` · ${p.remark}` : ''} · by ${p._by || 'manager'}`);
    return `part paid ₹${thisAmt} · ₹${remaining} pending`;
  }
  if (type === 'lock_month') {   // CASHIER settle (owner 2026-07-12): record cash+account, freeze the
    // month, carry the running balance (payable − paid) to next month. Replaces tick→pay for the owner.
    const ref = db().collection('att_salary').doc(p.code);
    const snap = await ref.get(); if (!snap.exists) throw new Error('no employee ' + p.code);
    const e = snap.data(); const md = (e.months || {})[p.month] || {};
    const date = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    let cash, account, paid, closing;
    if (md.locked && md.payment && md.payment.mode === 'lock') {
      // App already locked it INSTANTLY (direct att_salary write) — just add register + Telegram.
      cash = Number(md.payment.cash || 0); account = Number(md.payment.account || 0);
      paid = Number(md.payment.net || 0); closing = Number(md.payment.closing || 0);
    } else if (md.locked) {
      return `already locked (${p.month})`;
    } else {
      // STALE-REPLAY GUARD (2026-07-18, the Kamla case): if the owner UNLOCKED this month AFTER
      // this job was queued, the direct lock this job mirrors was deliberately undone — re-locking
      // here would resurrect it (and without the app's breakdown snapshot). Skip it.
      if (md.unlockedAt && p._createdAt && md.unlockedAt > p._createdAt) {
        return `stale lock skipped — ${p.month} was unlocked after this job was queued`;
      }
      // legacy queue-only path (no direct write): do the full lock + carry here.
      cash = Number(p.cash || 0); account = Number(p.account || 0); paid = cash + account;
      const payable = Number(p.payable || 0);
      closing = Math.round((payable - paid) * 100) / 100;
      const [y, m] = p.month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const months = { ...(e.months || {}) };
      // CHRONOLOGY GUARD (2026-07-31) — mirror of lockMonthDirect. Writing next month's opening
      // balance when next month is already frozen desyncs the carry chain. Unlock later months first.
      const nextMd = months[next] || {};
      if (nextMd.locked || nextMd.payment) {
        await sendTelegram(`🚫 Could not lock <b>${e.name || p.code}</b> ${p.month} — ${next} is already paid & locked. Reopen ${next} first, then lock ${p.month}.`).catch(() => {});
        return `REFUSED — ${next} is already locked; lock months in order`;
      }
      const prevNextOpening = Number(nextMd.openingBalance || 0), prevNextAdvance = Number(nextMd.advanceBalanceIn || 0);
      months[p.month] = { ...md, locked: true, lockedAt: new Date().toISOString(),
        payment: { cash, account, net: paid, payable, closing, date, mode: 'lock', prevNextOpening, prevNextAdvance, ...(p.breakdown ? { breakdown: p.breakdown } : {}), by: p._by || 'owner', reason: p.reason || '' } };
      months[next] = { ...(months[next] || {}), openingBalance: closing, advanceBalanceIn: Number(p.advanceCarry || 0) };
      const entry = { at: new Date().toISOString(), by: p._by || 'owner', code: p.code, name: e.name || p.code, month: p.month, field: 'lock', from: `payable ₹${payable}`, to: `paid ₹${paid} (cash ${cash}+acct ${account}); carry ₹${closing}`, reason: p.reason || '' };
      await ref.set({ months, decisions: [...(e.decisions || []), entry] }, { merge: true });
    }
    try {   // durable salary register snapshot (att_meta — worker only; idempotent by code)
      const regRef = db().collection('att_meta').doc('salary_register_' + p.month);
      const reg = (await regRef.get()).data() || { month: p.month, byCode: {} };
      reg.byCode = reg.byCode || {};
      reg.byCode[p.code] = { name: e.name || p.code, dept: e.dept || '', net: paid, cash, account, carry: closing, mode: 'lock', date, by: p._by || 'owner' };
      reg.total = Object.values(reg.byCode).reduce((s, x) => s + Number(x.net || 0), 0);
      reg.count = Object.keys(reg.byCode).length; reg.updatedAt = new Date().toISOString();
      await regRef.set(reg);
    } catch (e2) { console.error('register write failed:', e2.message); }
    await sendTelegram(`🔒 Locked <b>${e.name || p.code}</b> ${p.month}: paid ₹${paid.toLocaleString('en-IN')} (cash ${cash} + acct ${account})${closing ? ` · carry ₹${closing.toLocaleString('en-IN')} → next month` : ''} · by ${p._by || 'owner'}${p.reason ? ` · ${p.reason}` : ''}`).catch(() => {});
    return `locked ${p.month}: paid ${paid}, carry ${closing} (register+alert)`;
  }
  if (type === 'unlock_month') {   // reopen a locked month: clear the payment + revert the carried balance
    const ref = db().collection('att_salary').doc(p.code);
    const e = (await ref.get()).data(); const md = (e.months || {})[p.month] || {};
    if (!md.locked) return `not locked (${p.month})`;
    // STALE-REPLAY GUARD (2026-07-18, the akshay case — mirror of the lock_month guard): if the
    // owner LOCKED this month again AFTER this unlock was queued, the current lock is a NEWER
    // decision — replaying the old unlock here would silently wipe a recorded payment.
    if (md.lockedAt && p._createdAt && md.lockedAt > p._createdAt) {
      return `stale unlock skipped — ${p.month} was re-locked after this job was queued`;
    }
    const [y, m] = p.month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const months = { ...(e.months || {}) };
    months[p.month] = { ...md, locked: false, payment: null, unlockedAt: new Date().toISOString(), unlockedBy: p._by || 'owner' };
    months[next] = { ...(months[next] || {}), openingBalance: Number(md.payment?.prevNextOpening || 0), advanceBalanceIn: Number(md.payment?.prevNextAdvance || 0) };
    const entry = { at: new Date().toISOString(), by: p._by || 'owner', code: p.code, name: e.name || p.code, month: p.month, field: 'unlock', from: 'locked', to: 'reopened', reason: p.reason || '' };
    await ref.set({ months, decisions: [...(e.decisions || []), entry] }, { merge: true });
    return `unlocked ${p.month}`;
  }
  if (type === 'finalize_hisab') {   // owner finalizes a whole month: lock + carry advances forward
    const mk = p.month;
    const [y, m] = mk.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const sal = await db().collection('att_salary').get();
    let batch = db().batch(), n = 0, locked = 0, total = 0;
    const reg = { month: mk, byCode: {} };
    for (const d of sal.docs) {
      const e = d.data(); const md = (e.months || {})[mk];
      if (!md || !md.payment) continue;           // per-worker rule: only close PAID people (never an unpaid straggler)
      const months = { ...(e.months || {}) };
      months[mk] = { ...md, hisabFinalized: true, locked: true, finalizedAt: new Date().toISOString(), finalizedBy: p._by || 'owner' };
      // carry the LEFTOVER advance forward — ONLY now, at finalize
      months[next] = { ...(months[next] || {}), advanceBalanceIn: Number(md.approvedCarry || 0) };
      batch.set(d.ref, { months }, { merge: true });
      const net = Number(md.payment ? md.payment.net : md.approvedNet || 0);
      reg.byCode[d.id] = { name: e.name || d.id, dept: e.dept || '', net, carry: Number(md.approvedCarry || 0), paid: !!md.payment };
      total += net; locked++;
      if (++n >= 400) { await batch.commit(); batch = db().batch(); n = 0; }   // await every chunk — never a fire-and-forget payroll write
    }
    if (n) await batch.commit();
    reg.total = total; reg.count = locked; reg.finalizedAt = new Date().toISOString(); reg.finalizedBy = p._by || 'owner';
    await db().collection('att_meta').doc('hisab_' + mk).set(reg);   // durable monthly hisab register
    await sendTelegram(`🔒 <b>Hisab finalized — ${mk}</b>: ${locked} staff, total ₹${Math.round(total).toLocaleString('en-IN')}. Leftover advances carried to ${next}.`);
    return `hisab finalized ${mk}: ${locked} staff, ₹${Math.round(total)}`;
  }
  if (type === 'add_advance') {  // manager-created; applied with admin SDK (bypasses rules)
    const ref = db().collection('att_salary').doc(p.code);
    const snap = await ref.get();
    // GUARD (2026-07-17): never record an advance whose month is LOCKED — the month's payment
    // is frozen, so the advance would be handed out but never deducted from any salary (money leak).
    // This is the authoritative check; the app's own check is best-effort UX only.
    const dateMk = String(p.advance.date || '').slice(0, 7);
    // An advance with no usable date belongs to no month, so no salary run can ever deduct it —
    // same leak, different cause. The app rejects this (BADDATE); the manager queue must too, or
    // the two paths this guard was unified across would disagree again (2026-07-31).
    if (!/^\d{4}-\d{2}$/.test(dateMk)) {
      await sendTelegram(`🚫 Advance ₹${p.advance.amount} to ${(snap.exists && snap.data().name) || p.code} NOT saved — it has no valid date ("${p.advance.date || ''}"), so it could never be deducted from a salary. Re-enter it with a date. (by ${p.advance.paidBy || '?'})`);
      return `REJECTED — advance has no valid date; not recorded`;
    }
    // OWNER RULE (13-08-2026): while the worker's PREVIOUS month is still unlocked, a new advance
    // belongs to that previous month (it is netted off the salary being settled); once locked,
    // advances belong to their own calendar month. Must mirror data.js attributeAdvanceMk exactly.
    const empData = snap.exists ? snap.data() : {};
    if (!p.advance.mk) {
      const [ay, am] = dateMk.split('-').map(Number);
      const prevMk = am === 1 ? (ay - 1) + '-12' : ay + '-' + String(am - 1).padStart(2, '0');
      const joined = String(empData.joinDate || '').slice(0, 7);
      const prevMd = (empData.months || {})[prevMk] || {};
      p.advance.mk = (joined && joined > prevMk) || prevMd.locked || prevMd.payment ? dateMk : prevMk;
    }
    const advMk = p.advance.mk;
    const allMonths = (empData.months || {});
    const mdAdv = allMonths[advMk] || {};
    if (mdAdv.locked || mdAdv.payment) {
      await sendTelegram(`🚫 Advance ₹${p.advance.amount} to ${(snap.exists && snap.data().name) || p.code} NOT saved — ${advMk} salary is already paid & locked. Date it in the current month instead. (by ${p.advance.paidBy || '?'})`);
      return `REJECTED — ${advMk} is locked; advance not recorded`;
    }
    // ...and never BEFORE a locked month either (2026-07-31): that month's carry already accounts for
    // this worker's history, so a back-dated advance would never be recovered. Delete has always
    // checked this; add did not.
    const laterLocked = Object.entries(allMonths).find(([m, d]) => m > advMk && d && (d.locked || d.payment));
    if (laterLocked) {
      await sendTelegram(`🚫 Advance ₹${p.advance.amount} to ${(snap.exists && snap.data().name) || p.code} NOT saved — a LATER month (${laterLocked[0]}) is already paid & locked, so this advance could never be deducted. Date it in the current month instead. (by ${p.advance.paidBy || '?'})`);
      return `REJECTED — later month ${laterLocked[0]} is locked; advance not recorded`;
    }
    // SETTLE-CASH DOUBLE-ENTRY WARNING (owner 2026-08-23) — mirrors data.js settleCashClash. Cash paid
    // AT a settle is already the lock's cash leg; recorded again as an advance it becomes a debt the
    // worker never took (radhey shyam press, ₹4,500, 13-08-2026). Flag it on the alert; never reject.
    const advDay = String(p.advance.date || '').slice(0, 10);
    const advLeg = String(p.advance.mode || 'cash') === 'account' ? 'account' : 'cash';
    const clashMk = Object.keys(allMonths).find((m) => {
      const pay = (allMonths[m] || {}).payment;
      return pay && String(pay.date || allMonths[m].lockedAt || '').slice(0, 10) === advDay
        && Math.round(Number(pay[advLeg]) || 0) === Math.round(Number(p.advance.amount) || 0);
    });
    const clashWarn = clashMk
      ? `\n⚠ CHECK THIS: ${clashMk} salary was settled the SAME DAY paying ₹${Math.round(Number((allMonths[clashMk].payment || {})[advLeg]) || 0)} by ${advLeg}. If this advance is that same money, delete it — otherwise he will show owing money he never took.`
      : '';
    const advances = (snap.exists && snap.data().advances) || [];
    const already = p.advance.id && advances.some((a) => a.id === p.advance.id);
    // notifyOnly (2026-07-22): the OWNER app already wrote this advance directly (addAdvanceDirect)
    // for instant display; this job exists only to fire the Telegram alert in the background.
    if (p.notifyOnly) {
      await sendTelegram(`💸 Advance ₹${p.advance.amount} to ${p.code} (${p.advance.mode}) by ${p.advance.paidBy || '?'}.${clashWarn}`);
      return already ? 'advance already applied — notified' : 'advance notified';
    }
    // DEDUPE (fix 2026-07-18): a stale-recovery re-run (runner killed after the write, before
    // 'done') must not record the same advance twice — worker would be double-deducted at salary.
    if (already) {
      return `advance ${p.advance.id} already recorded — duplicate ignored`;
    }
    advances.push(p.advance);
    await ref.set({ advances }, { merge: true });
    await sendTelegram(`💸 Advance ₹${p.advance.amount} to ${p.code} (${p.advance.mode}) by ${p.advance.paidBy || '?'}.${clashWarn}`);
    return 'advance added';
  }
  if (type === 'monthly_download') {
    const scope = p.scope === 'all' ? 'all' : p.scope === 'dept' ? 'dept:' + p.value : 'emp:' + p.value;
    const env = { MONTH: String(p.month || 0), SCOPE: scope };
    if (p.from && p.to) { env.FROM = p.from; env.TO = p.to; }      // custom date range (dd/MM/yyyy)
    if (p.report) env.REPORT = p.report;                            // which Realtime report button
    const out = run('monthlyDownload.js', env);
    const m = out.match(/DOWNLOADED (\S+)/);
    const range = p.from && p.to ? ` ${p.from}–${p.to}` : '';
    if (m) { await sendTelegramDocument(path.join(DL, m[1]), `📋 Monthly attendance (${scope})${range}`); return 'sent file ' + m[1]; }
    return 'generated but no file matched';
  }
  if (type === 'payslip') {
    const { computePay } = require('./salaryCalc');
    const fdb = db();
    const [empDoc, attDoc] = await Promise.all([
      fdb.collection('att_salary').doc(p.code).get(),
      fdb.collection('att_attendance').doc(p.code).get(),
    ]);
    const emp = empDoc.exists ? empDoc.data() : null;
    if (!emp || !(emp.amount || emp.wage)) { await sendTelegram(`🧾 Payslip: no salary set for ${p.code}.`); return 'no salary config'; }
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const mk = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
    let att;
    if (emp.appOnly) {  // daily-wager: attendance from manual hours log
      const log = (emp.attendanceLog && emp.attendanceLog[mk]) || [];
      att = { presentDays: log.length, equivalentDays: log.reduce((s, d) => s + Math.min(Number(d.hours || 0), 11) / 11, 0), otHrs: 0, lateHrs: 0, earlyHrs: 0, absentDays: 0 };
    } else {
      att = attDoc.exists ? attDoc.data() : { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };
    }
    const md = (emp.months && emp.months[mk]) || {};
    const adv = (emp.advances || []).filter(a => ((a.mk) || (a.date || '').slice(0, 7)) === mk).reduce((s, a) => s + Number(a.amount || 0), 0);
    // Apply the owner's manual override (days / OT) exactly as the app does — without this the
    // Telegram payslip reports different figures from the screen (Codex review 2026-07-30).
    const { applyOverride } = require('./lib/applyOverride');
    att = applyOverride(att, md, yest.getDate());
    const pay = computePay({
      emp, att, daysInMonth: last.getDate(), elapsedDays: yest.getDate(), fullMonth: false, monthStart: first, toDate: yest,
      advancesThisMonth: adv, advanceBalanceIn: Number(md.advanceBalanceIn || 0),
      // owner rule: deduct the FULL outstanding advance by default (override per month if needed)
      advanceRecover: md.advanceRecover != null ? Number(md.advanceRecover) : adv + Number(md.advanceBalanceIn || 0),
      fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0), bonus: Number(md.bonus || 0),
      payPerfectBonus: !!md.perfectBonusPaid,   // full-attendance bonus: owner adds/rejects per worker
      openingBalance: Number(md.openingBalance || 0),   // carried balance — else Telegram payslip over/under-states payable
    });
    const r = n => '₹' + Number(n || 0).toLocaleString('en-IN');
    const lines = [`🧾 <b>Payslip — ${emp.name || p.code} (${mk})</b>`,
      `Rate ${r(pay.effectiveRate)} ${emp.type === 'daily' ? '/day' : '/mo'}  ·  Present ${pay.presentDays} / Absent ${pay.absentDays}`,
      `Base ${r(pay.base)} + OT ${r(pay.otPay)}${pay.perfectBonus ? ' + bonus ' + r(pay.perfectBonus) : ''}`,
      `${pay.fines ? '− Fine ' + r(pay.fines) + '  ' : ''}${pay.loanInstallment ? '− Loan ' + r(pay.loanInstallment) + '  ' : ''}${pay.advanceRecovered ? '− Advance ' + r(pay.advanceRecovered) : ''}`,
      `<b>NET ${r(pay.net)}</b>${pay.advanceBalanceCarried ? '  (advance bal ' + r(pay.advanceBalanceCarried) + ')' : ''}`,
      // `payable` = this month's net PLUS the balance carried from last month. Printing `net` alone
      // hid the carried balance for 40 workers (Codex review 2026-07-30).
      pay.openingBalance ? `Previous balance ${r(pay.openingBalance)}  →  <b>PAYABLE ${r(pay.payable)}</b>` : ''];
    await sendTelegram(lines.filter(Boolean).join('\n'));
    return 'payslip sent';
  }
  return 'unknown job type';
}

// Self-heal the floor snapshot. Owner rule (2026-07-22): pull the floor only ~4×/day (everyone is
// inside by ~10:00, so 15-min polling is wasteful) — morning 10:00, afternoon 15:00, before food
// 17:40, night 21:00 IST. publish-state's cron does these, but GitHub's cron is unreliable (it
// silently stopped overnight 2026-07-21 → owner saw "21 Jul" at 10 AM). The worker's own */5 cron is
// an INDEPENDENT schedule, so each cycle we check: for the most recent target that is already due
// today, did a publish land SINCE it? If not, GitHub missed that slot → re-trigger publish-state via
// a `refresh_floor` repository_dispatch, and (only if it stays missed) ping the owner. Relies on
// DISPATCH_PAT (same token the old heartbeat used).
const FLOOR_TARGETS = [
  { min: 10 * 60,      label: 'morning (10:00)' },
  { min: 15 * 60,      label: 'afternoon (15:00)' },
  { min: 17 * 60 + 40, label: 'before-food (17:40)' },
  { min: 21 * 60,      label: 'night (21:00)' },
];
async function selfHealFloor() {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const nowMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const today = istNow.toISOString().slice(0, 10);
  const due = [...FLOOR_TARGETS].reverse().find((t) => nowMin >= t.min);  // most recent slot that's due
  if (!due) return;                                    // before the morning pull — nothing due yet
  const snap = await db().collection('att_daily_stats').doc('today').get();
  const v = snap.exists ? snap.data() : {};
  const pubAt = Date.parse(v.publishedAt || 0) || 0;
  const pubIst = pubAt ? new Date(pubAt + 5.5 * 3600 * 1000) : null;
  const pubToday = pubIst && pubIst.toISOString().slice(0, 10) === today;
  const pubMin = pubToday ? pubIst.getUTCHours() * 60 + pubIst.getUTCMinutes() : -1;
  if (pubToday && pubMin >= due.min) return;           // already pulled since the most recent due slot
  // The due slot has no pull since it → GitHub cron missed it. Re-trigger (throttled 1/12min).
  const ref = db().collection('att_alert_state').doc('floor_selfheal');
  const s = (await ref.get()).data() || {};
  const now = Date.now();
  const patch = {};
  if (now - (Date.parse(s.lastDispatch || 0) || 0) > 12 * 60 * 1000) {
    const repo = process.env.GITHUB_REPOSITORY || 'nishanttmittal/nsp-attendance';
    const pat = process.env.DISPATCH_PAT;
    if (pat) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
          body: JSON.stringify({ event_type: 'refresh_floor' }),
        });
        patch.lastDispatch = new Date(now).toISOString();
        console.log(`self-heal: ${due.label} pull missing → refresh_floor dispatch HTTP ${r.status}`);
      } catch (e) { console.error('self-heal dispatch failed:', e.message); }
    } else { console.error('self-heal: DISPATCH_PAT missing — cannot re-trigger publish-state'); }
  }
  // Only ping the owner if the slot has been missed for >30 min (i.e. the re-trigger isn't working —
  // token dead / portal down), throttled to 1/hour, so a normal cron-miss self-heals silently.
  if (nowMin - due.min > 30 && now - (Date.parse(s.lastAlert || 0) || 0) > 60 * 60 * 1000) {
    const last = pubAt ? new Date(pubAt + 5.5 * 3600 * 1000).toISOString().slice(11, 16) + ' IST' : 'never today';
    await sendTelegram(`⚠️ The ${due.label} floor update didn't run (last pull ${last}). Auto-retry isn't taking — check the biometric device / the app's data token.`).catch(() => {});
    patch.lastAlert = new Date(now).toISOString();
  }
  if (Object.keys(patch).length) await ref.set(patch, { merge: true });
}

async function main() {
  // Keep the live floor fresh even when GitHub's publish-state cron silently dies (self-heal).
  try { await selfHealFloor(); } catch (e) { console.error('self-heal failed:', e.message); }

  // record any self-punch taps (Radhey/Dinesh link) before processing the job queue
  try { const n = await drainSelfPunch(); if (n) console.log(`self-punch: recorded ${n} tap(s)`); }
  catch (e) { console.error('self-punch drain failed:', e.message); }
  try { const n = await captureLate(); if (n) console.log(`late-log: captured ${n}`); }
  catch (e) { console.error('late capture failed:', e.message); }
  try { const n = await alertLate(); if (n) console.log(`late-alert: messaged ${n}`); }
  catch (e) { console.error('late alert failed:', e.message); }

  // time-aware dispatcher: fire the daily/weekly jobs at their IST time (replaces dead cron)
  try { const r = await runDueTasks(); if (r.length) console.log(`scheduler ran: ${r.join(', ')}`); }
  catch (e) { console.error('scheduler failed:', e.message); }

  // Mirror paid/unpaid status into the manager-readable payout docs (att_meta/payout_YYYY-MM).
  // REWRITTEN 2026-07-17: the old mirror only included md.approved months, but the approve/tick
  // flow was retired (owner locks directly) — so the docs sat empty, which silently killed both
  // the manager's salary view AND the app's advance-after-paid guard. Now mirrors EVERY active
  // salary worker with paid-status only (no amounts — manager view is read-only).
  try {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    const cur = ist.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const sal = await db().collection('att_salary').get();
    for (const mk of [prev, cur]) {
      const items = {};
      sal.forEach(d => {
        const e = d.data();
        if (e.active === false || !(e.amount || e.wage)) return;   // active salary workers only
        const md = (e.months || {})[mk] || {};
        const pmt = md.payment;
        items[d.id] = { name: e.name || d.id, nickname: e.nickname || '', dept: e.dept || '',
          paid: pmt ? { mode: pmt.cash > 0 && pmt.account > 0 ? 'split' : pmt.account > 0 ? 'account' : 'cash', date: (md.lockedAt || '').slice(0, 10) } : null };
      });
      await db().collection('att_meta').doc('payout_' + mk).set({ month: mk, items, updatedAt: new Date().toISOString() });
    }
    // Salary-FREE advance balances for the manager Advances page. att_meta is staff-readable, so this
    // MUST NOT contain any pay figure — only the advance owed = balance brought forward + this month's
    // advances. The manager can see who owes what without ever reading att_salary (which stays owner-only).
    const advItems = {};
    sal.forEach(d => {
      const e = d.data();
      if (e.active === false) return;
      // Owner rule 19-08-2026: the account starts at the balance the LAST LOCK carried out, and counts
      // every advance given SINCE that lock. Keep in step with web/src/lib/data.js advanceStatement().
      // Was: bf from the running month + advances dated in the running calendar month — that hid an
      // unlocked month's advances entirely AND lost its carry-in, under-reporting ₹1.09L over 7 workers
      // (raju showed ₹6,000 against a real ₹61,555). Under-reporting money owed is the dangerous way to
      // be wrong, so this counts from the last settled point instead of the calendar month.
      const months = e.months || {};
      const lockedMks = Object.keys(months).filter(m => (months[m] || {}).locked).sort();
      const bfMonth = lockedMks.length ? lockedMks[lockedMks.length - 1] : '';
      const after = bfMonth ? nextMonthKey(bfMonth) : '';
      const bf = after ? Number((months[after] || {}).openingBalance || 0) : 0;   // − = owes us
      const advMk = a => a.mk || String(a.date || '').slice(0, 7);
      const sinceAdv = (e.advances || [])
        .filter(a => !bfMonth || advMk(a) > bfMonth)
        .reduce((t, a) => t + Number(a.amount || 0), 0);
      advItems[d.id] = {
        name: e.name || d.id, nickname: e.nickname || '', dept: e.dept || '',
        bfOwed: Math.round(bf < 0 ? -bf : 0), bfCredit: Math.round(bf > 0 ? bf : 0),
        thisMonth: Math.round(sinceAdv), totalOwed: Math.round(-bf + sinceAdv),   // + = worker owes; − = credit
        sinceLock: bfMonth || null,
      };
    });
    await db().collection('att_meta').doc('advance_balances').set({ month: cur, items: advItems, updatedAt: new Date().toISOString() });
  } catch (e) { console.error('payout/advance sync failed:', e.message); }

  // once-a-day: scan the in-out report for missed punches (for the app's Punch tab list)
  try {
    const sref = db().collection('att_alert_state').doc('missed_scan');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if ((await sref.get()).data()?.date !== today) {
      const { scanMissed } = require('./missedPunchScan');
      const n = await scanMissed();
      await sref.set({ date: today, count: n, at: new Date().toISOString() });
      console.log(`missed-punch scan: ${n}`);
    }
  } catch (e) { console.error('missed scan failed:', e.message); }

  // once-a-day: weekly-off audit (worked Saturdays in unearned weeks → unpaidWorkedSat, OT-only)
  try {
    const wref = db().collection('att_alert_state').doc('weeklyoff_audit');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if ((await wref.get()).data()?.date !== today) {
      const { audit } = require('./weeklyOffAudit');
      const r = await audit(0);
      await wref.set({ date: today, flagged: r.flagged, at: new Date().toISOString() });
      console.log(`weekly-off audit: ${r.flagged} flagged`);
    }
  } catch (e) { console.error('weekly-off audit failed:', e.message); }

  // once-a-day: LOD grace engine (owner rule 2026-08-11) — recompute loading daily-wagers'
  // equivalentDays from punches with the 15-min both-ways grace (current + last month).
  try {
    const gref = db().collection('att_alert_state').doc('lod_grace');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if ((await gref.get()).data()?.date !== today) {
      const { graceAdjust } = require('./lodGrace');
      const rows = await graceAdjust([0, 1]);
      await gref.set({ date: today, updated: rows.length, at: new Date().toISOString() });
      console.log(`LOD grace: ${rows.length} worker-months recomputed`);
    }
  } catch (e) { console.error('LOD grace failed:', e.message); }

  // once-a-day: "To handle" attendance review (owner 2026-08-12) — early-but-paid-full days +
  // broken-day patterns → att_meta/attendance_review_{mk} for the Problems tab.
  try {
    const rref = db().collection('att_alert_state').doc('attendance_review');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if ((await rref.get()).data()?.date !== today) {
      const { buildReview } = require('./attendanceReview');
      const r = await buildReview([0, 1]);
      await rref.set({ date: today, result: r, at: new Date().toISOString() });
      console.log('attendance review:', JSON.stringify(r));
    }
  } catch (e) { console.error('attendance review failed:', e.message); }

  // Pending jobs + any job STUCK in 'running' past a safe timeout (GitHub Actions
  // killed mid-run would otherwise sit 'running' forever) — P2-6 stale recovery.
  const pend = await db().collection('att_job_requests').where('status', '==', 'pending').limit(10).get();
  const runningSnap = await db().collection('att_job_requests').where('status', '==', 'running').limit(10).get();
  const STALE_MS = 15 * 60 * 1000;
  const now = Date.now();
  const stale = runningSnap.docs.filter(d => now - Date.parse(d.data().startedAt || 0) > STALE_MS);
  const docs = [...pend.docs, ...stale];
  if (!docs.length) { console.log('no pending jobs'); return; }
  for (const doc of docs) {
    const { type, payload, requestedBy } = doc.data();
    // AUTHORIZE before doing anything privileged (P1-1).
    const auth = await authorizeJob(requestedBy, type);
    if (!auth.ok) {
      await doc.ref.update({ status: 'error', error: 'unauthorized: ' + auth.reason, finishedAt: new Date().toISOString() });
      await sendTelegram(`🚫 Rejected job <b>${type}</b> from ${requestedBy || '?'} — ${auth.reason}`).catch(() => {});
      console.log(`[rejected] ${type}: ${auth.reason}`);
      continue;
    }
    await doc.ref.update({ status: 'running', startedAt: new Date().toISOString() });
    try {
      const result = await handle(type, { ...(payload || {}), _by: requestedBy || '', _createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || '' });
      await doc.ref.update({ status: 'done', result, finishedAt: new Date().toISOString() });
      console.log(`[done] ${type}: ${result}`);
    } catch (e) {
      // Owner rule (2026-06-14): if the MACHINE is unreachable, don't fail the job — requeue it
      // to retry on a later cycle the same day. Only give up (status 'error') after the cap or
      // for a non-transient error (bad data etc.).
      const msg = String(e.message || e).split('\n')[0];
      const attempts = Number(doc.data().attempts || 0) + 1;
      const transient = /timeout|login|net::|ECONN|ETIMEDOUT|socket|download did not start|not found on machine|navigation/i.test(msg);
      if (transient && attempts < 40) {                  // ~retry through the day while the machine/runner is down
        await doc.ref.update({ status: 'pending', attempts, lastError: msg.slice(0, 300), retriedAt: new Date().toISOString() });
        console.log(`[retry ${attempts}] ${type}: ${msg}`);
      } else {
        await doc.ref.update({ status: 'error', attempts, error: msg.slice(0, 500), finishedAt: new Date().toISOString() });
        await sendTelegram(`⚠️ Job ${type} failed${transient ? ' (gave up after ' + attempts + ' tries)' : ''}: ${msg}`).catch(() => {});
        console.log(`[error] ${type}: ${msg}`);
      }
    }
  }
}

// only run the queue loop when executed directly (node worker.js / GitHub Actions);
// when required by a test we just expose handle() so it can be driven in isolation.
if (require.main === module) main();
module.exports = { handle, main, authorizeJob };
