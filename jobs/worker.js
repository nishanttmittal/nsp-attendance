// Queue worker: processes pending att_job_requests created by the PWA (manual punch,
// onboard, resign, monthly download, payslip). Runs on a frequent GitHub Actions cron.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');
const { sendTelegram, sendTelegramDocument } = require('./lib/notify');

const DL = path.resolve(__dirname, 'downloads');

function run(file, env) {
  return execFileSync('node', [path.resolve(__dirname, file)], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 260000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function handle(type, p) {
  if (type === 'manual_punch') {
    run('manualPunch.js', { EMP: p.emp, DATE: p.date, IN: p.in || '', OUT: p.out || '', REMARK: p.remark || 'app', DRY: 'false' });
    await sendTelegram(`✏️ Manual punch added for ${p.emp} on ${p.date} (in ${p.in || '—'}/out ${p.out || '—'}).`);
    return 'punch inserted + day reprocessed';
  }
  if (type === 'onboard_employee') {
    run('onboardEmployee.js', { NAME: p.name, CARDNO: p.cardno, DEPT: p.dept, SHIFT: p.shift, GENDER: p.gender, DRY: 'false' });
    await sendTelegram(`🧑‍🏭 New employee added: ${p.name} (${p.cardno}) · ${p.dept} · ${p.shift}.`);
    return 'employee created on machine';
  }
  if (type === 'resign_employee') {
    await sendTelegram(`👋 ${p.code} marked resigned.`);
    return 'resigned (app); disable on device if needed';
  }
  if (type === 'reprocess_period') {
    run('reprocessRange.js', { FROM: p.from, TO: p.to });
    await sendTelegram(`🔄 Reprocessed attendance ${p.from} → ${p.to}.`);
    return 'reprocessed ' + p.from + '..' + p.to;
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
    const out = run('monthlyDownload.js', { MONTH: String(p.month || 0), SCOPE: scope });
    const m = out.match(/DOWNLOADED (\S+)/);
    if (m) { await sendTelegramDocument(path.join(DL, m[1]), `📋 Monthly attendance (${scope})`); return 'sent file ' + m[1]; }
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
      advancesThisMonth: adv, advanceBalanceIn: Number(md.advanceBalanceIn || 0), advanceRecover: Number(md.advanceRecover || 0),
      fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0),
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

(async () => {
  const snap = await db().collection('att_job_requests').where('status', '==', 'pending').limit(10).get();
  if (snap.empty) { console.log('no pending jobs'); return; }
  for (const doc of snap.docs) {
    const { type, payload } = doc.data();
    await doc.ref.update({ status: 'running', startedAt: new Date().toISOString() });
    try {
      const result = await handle(type, payload || {});
      await doc.ref.update({ status: 'done', result, finishedAt: new Date().toISOString() });
      console.log(`[done] ${type}: ${result}`);
    } catch (e) {
      await doc.ref.update({ status: 'error', error: String(e.message || e).slice(0, 500), finishedAt: new Date().toISOString() });
      await sendTelegram(`⚠️ Job ${type} failed: ${String(e.message || e).split('\n')[0]}`).catch(() => {});
      console.log(`[error] ${type}: ${e.message}`);
    }
  }
})();
