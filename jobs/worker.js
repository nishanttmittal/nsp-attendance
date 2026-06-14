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

function run(file, env) {
  return execFileSync('node', [path.resolve(__dirname, file)], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 260000, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    run('onboardEmployee.js', { NAME: p.name, CARDNO: p.cardno, DEPT: p.dept, SHIFT: p.shift, GENDER: p.gender, DRY: 'false' });
    await sendTelegram(`🧑‍🏭 New employee added: ${p.name} (${p.cardno}) · ${p.dept} · ${p.shift}.`);
    return 'employee created on machine';
  }
  if (type === 'push_employee_edit') {   // owner edited name/dept in app → push to the machine
    const env = { CARD: p.code, DRY: 'false' };
    if (p.name) env.NAME = p.name;
    if (p.dept) env.DEPT = p.dept;
    run('pushEmployeeEdit.js', env);
    await sendTelegram(`✏️ Updated on machine: ${p.code}${p.name ? ' · name “' + p.name + '”' : ''}${p.dept ? ' · dept ' + p.dept : ''}.`);
    return 'name/dept pushed to machine';
  }
  if (type === 'resign_employee') {      // archive full history, THEN delete from the machine
    run('archiveDelete.js', { CARD: p.code, BY: p._by || 'app' });   // archiveDelete.js sends its own Telegram + handles the safety gate
    return 'archived + deleted from machine';
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
  if (type === 'mark_paid') {    // manager marks an approved salary as handed over
    const ref = db().collection('att_salary').doc(p.code);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('no employee ' + p.code);
    const e = snap.data();
    const md = (e.months || {})[p.month] || {};
    if (!md.approved) throw new Error('not approved yet');
    const months = { ...(e.months || {}) };
    months[p.month] = { ...md, locked: true, payment: { date: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10), mode: p.mode || 'cash', net: md.approvedNet || 0, by: p._by || 'manager', remark: p.remark || '' } };
    // roll unrecovered advance into next month
    const [y, m] = p.month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    months[next] = { ...(months[next] || {}), advanceBalanceIn: Number(md.approvedCarry || 0) };
    await ref.set({ months }, { merge: true });
    await sendTelegram(`💵 Paid: <b>${e.name || p.code}</b> ₹${Number(md.approvedNet || 0).toLocaleString('en-IN')} (${p.mode}) · ${p.month}${p.remark ? ` · ${p.remark}` : ''} · by ${p._by || 'manager'}`);
    return 'marked paid';
  }
  if (type === 'add_advance') {  // manager-created; applied with admin SDK (bypasses rules)
    const ref = db().collection('att_salary').doc(p.code);
    const snap = await ref.get();
    const advances = (snap.exists && snap.data().advances) || [];
    advances.push(p.advance);
    await ref.set({ advances }, { merge: true });
    await sendTelegram(`💸 Advance ₹${p.advance.amount} to ${p.code} (${p.advance.mode}) by ${p.advance.paidBy || '?'}.`);
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
    const adv = (emp.advances || []).filter(a => (a.date || '').startsWith(mk)).reduce((s, a) => s + Number(a.amount || 0), 0);
    const pay = computePay({
      emp, att, daysInMonth: last.getDate(), elapsedDays: yest.getDate(), fullMonth: false, monthStart: first, toDate: yest,
      advancesThisMonth: adv, advanceBalanceIn: Number(md.advanceBalanceIn || 0),
      // owner rule: deduct the FULL outstanding advance by default (override per month if needed)
      advanceRecover: md.advanceRecover != null ? Number(md.advanceRecover) : adv + Number(md.advanceBalanceIn || 0),
      fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0), bonus: Number(md.bonus || 0),
    });
    const r = n => '₹' + Number(n || 0).toLocaleString('en-IN');
    const lines = [`🧾 <b>Payslip — ${emp.name || p.code} (${mk})</b>`,
      `Rate ${r(pay.effectiveRate)} ${emp.type === 'daily' ? '/day' : '/mo'}  ·  Present ${pay.presentDays} / Absent ${pay.absentDays}`,
      `Base ${r(pay.base)} + OT ${r(pay.otPay)}${pay.perfectBonus ? ' + bonus ' + r(pay.perfectBonus) : ''}`,
      `${pay.fines ? '− Fine ' + r(pay.fines) + '  ' : ''}${pay.loanInstallment ? '− Loan ' + r(pay.loanInstallment) + '  ' : ''}${pay.advanceRecovered ? '− Advance ' + r(pay.advanceRecovered) : ''}`,
      `<b>NET ${r(pay.net)}</b>${pay.advanceBalanceCarried ? '  (advance bal ' + r(pay.advanceBalanceCarried) + ')' : ''}`];
    await sendTelegram(lines.filter(Boolean).join('\n'));
    return 'payslip sent';
  }
  return 'unknown job type';
}

async function main() {
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

  // mirror approved salaries into the manager-readable payout docs (att_meta/payout_YYYY-MM)
  try {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    const cur = ist.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const sal = await db().collection('att_salary').get();
    for (const mk of [prev, cur]) {
      const items = {};
      sal.forEach(d => {
        const md = (d.data().months || {})[mk];
        if (!md || !md.approved || md.hold) return;  // held salaries never reach the manager's pay list
        items[d.id] = { name: d.data().name || d.id, nickname: d.data().nickname || '', dept: d.data().dept || '', net: Number(md.approvedNet || 0), paid: md.payment ? { mode: md.payment.mode, date: md.payment.date } : null };
      });
      await db().collection('att_meta').doc('payout_' + mk).set({ month: mk, items, updatedAt: new Date().toISOString() });
    }
  } catch (e) { console.error('payout sync failed:', e.message); }

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

  const snap = await db().collection('att_job_requests').where('status', '==', 'pending').limit(10).get();
  if (snap.empty) { console.log('no pending jobs'); return; }
  for (const doc of snap.docs) {
    const { type, payload, requestedBy } = doc.data();
    await doc.ref.update({ status: 'running', startedAt: new Date().toISOString() });
    try {
      const result = await handle(type, { ...(payload || {}), _by: requestedBy || '' });
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
module.exports = { handle, main };
