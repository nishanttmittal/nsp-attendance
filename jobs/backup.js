// Exports all att_* app data from Firestore to a JSON file and sends it to Telegram
// as an off-site backup. Runs daily + before each month's salary approval.
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/firestore');
const { sendTelegramDocument } = require('./lib/notify');

const COLS = ['att_employees', 'att_salary', 'att_attendance', 'att_advances', 'att_increments', 'att_loans', 'att_fines', 'att_month_locks', 'att_users', 'att_meta'];
const REASON = process.env.REASON || 'daily';

(async () => {
  const out = { app: 'nsp-attendance', version: 1, exportedAt: new Date().toISOString(), reason: REASON, collections: {} };
  for (const c of COLS) {
    const s = await db().collection(c).get();
    out.collections[c] = Object.fromEntries(s.docs.map(d => [d.id, d.data()]));
  }
  const dir = path.resolve(__dirname, 'downloads'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const f = path.join(dir, `nsp-attendance-backup-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  await sendTelegramDocument(f, `🗄️ Attendance data backup (${REASON}) — salary/advances/attendance/etc.`);
  console.log('backup sent:', path.basename(f));
})();
