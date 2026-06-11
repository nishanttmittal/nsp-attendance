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
  if (type === 'monthly_download') {
    const scope = p.scope === 'all' ? 'all' : p.scope === 'dept' ? 'dept:' + p.value : 'emp:' + p.value;
    const out = run('monthlyDownload.js', { MONTH: String(p.month || 0), SCOPE: scope });
    const m = out.match(/DOWNLOADED (\S+)/);
    if (m) { await sendTelegramDocument(path.join(DL, m[1]), `📋 Monthly attendance (${scope})`); return 'sent file ' + m[1]; }
    return 'generated but no file matched';
  }
  if (type === 'payslip') {
    // basic: compute current-month payslip from Firestore salary config + live attendance
    const { computePay } = require('./salaryCalc');
    const empDoc = await db().collection('att_salary').doc(p.code).get();
    const emp = empDoc.exists ? empDoc.data() : null;
    if (!emp) { await sendTelegram(`Payslip: no salary set for ${p.code}.`); return 'no salary config'; }
    // (attendance + full calc wired with the monthly job; here send the saved config summary)
    await sendTelegram(`🧾 Payslip request for ${p.code} (${emp.type} ${emp.amount || emp.wage}). Full payslip generation runs in the monthly job.`);
    return 'payslip acknowledged';
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
