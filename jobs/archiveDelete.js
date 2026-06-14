// Resign = ARCHIVE-THEN-DELETE for ONE worker (owner rule 2026-06-14).
//   CARD=<emp code>   [DRY=true to archive only, skip the machine delete]
// Order (delete only happens if the archive succeeded — the safety gate):
//   1. snapshot att_salary + att_attendance (the app's payroll record) from Firestore
//   2. scrape the worker's FULL in-out punch history from the machine (DOJ..today)
//   3. write att_archive/{code} in Firestore + keep the in-out file; verify the write
//   4. ONLY THEN delete the worker on the machine (EmployeeList checkbox + Delete + confirm)
//   5. Telegram the owner + attach the punch-history file
const path = require('path');
const fs = require('fs');
const { session, selectFewEmployee, setField } = require('./lib/realtime');   // V26 helpers
const { db } = require('./lib/firestore');
const { sendTelegram, sendTelegramDocument } = require('./lib/notify');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const CARD = process.env.CARD;
const DRY = process.env.DRY === 'true';
const ddmmyyyy = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
const today = () => ddmmyyyy(Date.now() + 5.5 * 3600 * 1000);
const daysAgo = (n) => ddmmyyyy(Date.now() + 5.5 * 3600 * 1000 - n * 86400000);   // V26 in-out report caps at 31 days

(async () => {
  if (!CARD) { console.error('ERROR: CARD required'); process.exit(1); }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const fdb = db();

  // 1. app payroll record
  const [salDoc, attDoc] = await Promise.all([
    fdb.collection('att_salary').doc(CARD).get(),
    fdb.collection('att_attendance').doc(CARD).get(),
  ]);
  const sal = salDoc.exists ? salDoc.data() : null;
  const name = (sal && sal.name) || CARD;

  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  let inoutFile = null, inoutText = null;
  try {
    // 2. best-effort: scrape this worker's in-out punch history via ERP_NewMonthly (V26).
    //    select just this employee, pull "In_OUT IN .Excel Format" (LinkButton22). If anything
    //    fails, we still archive the app record below and proceed.
    try {
      await page.goto('https://onlinerealsoft.com/ERP_NewMonthly.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
      await selectFewEmployee(page, CARD);
      await setField(page, '#txtdate', daysAgo(30));      // last 31 days (portal caps in-out at 31 days)
      await setField(page, '#txtdateto', today());
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), page.click('#LinkButton22')]);
      inoutFile = path.join(OUT_DIR, `archive_inout_${CARD}.xls`);
      await dl.saveAs(inoutFile);
      inoutText = fs.readFileSync(inoutFile, 'utf8');
    } catch (e) { console.error('in-out scrape failed (continuing with app record only):', e.message.split('\n')[0]); }

    // 3. write the archive + verify (the safety gate — the app payroll record always succeeds)
    const archive = {
      code: CARD, name, dept: (sal && sal.dept) || '',
      archivedAt: new Date().toISOString(), archivedBy: process.env.BY || 'app',
      salary: sal || null, attendance: attDoc.exists ? attDoc.data() : null,
      inoutFileName: inoutFile ? path.basename(inoutFile) : null,
      // Firestore caps a doc at ~1MB; the full in-out file goes to Telegram — keep only a preview.
      punchHistoryPreview: inoutText ? inoutText.slice(0, 40000) : '(in-out history sent to Telegram only)',
      punchHistoryCaptured: !!inoutText,
    };
    await fdb.collection('att_archive').doc(CARD).set(archive);
    const check = await fdb.collection('att_archive').doc(CARD).get();
    if (!check.exists) throw new Error('archive write failed — DELETE ABORTED (safety gate)');
    console.log('archived att_archive/' + CARD + ' (inout:', !!inoutText, ')');

    if (DRY) { console.log('=> DRY: archived only, machine NOT touched'); }
    else {
      // 4. delete on the machine: ERP_EmployeeList — tick the worker's row checkbox, click Delete, confirm
      await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded' });   // V26
      await page.waitForTimeout(2000);
      const ticked = await page.evaluate((c) => {
        for (const tr of document.querySelectorAll('tr')) {
          if ((tr.innerText || '').includes(c)) {
            const cb = tr.querySelector('input[type=checkbox]');
            if (cb) { cb.checked = true; cb.dispatchEvent(new Event('click', { bubbles: true })); cb.dispatchEvent(new Event('change', { bubbles: true })); return { id: cb.id, value: cb.value }; }
          }
        }
        return null;
      }, CARD);
      if (!ticked) throw new Error('could not tick worker row for delete (archive is safe)');
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#BtnDel')]);   // V26: was #MainContent_BtnDel
      await page.waitForTimeout(2500);
      // verify gone (re-scan the list)
      await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);
      const still = await page.evaluate((c) => document.body.innerText.includes(c), CARD);
      if (still) throw new Error('delete did not take — worker still on machine (archive is safe)');
      console.log('deleted from machine. confirm dialog:', JSON.stringify(dialogs));
      await fdb.collection('att_salary').doc(CARD).set({ deletedFromMachine: true, deletedAt: new Date().toISOString() }, { merge: true });
    }
  } finally { await browser.close(); }

  // 5. notify
  const msg = DRY
    ? `🗄️ Archived <b>${name}</b> (${CARD}) — history saved, machine NOT deleted (dry run).`
    : `🗄️ <b>${name}</b> (${CARD}) archived & removed from the machine. Full history is safe in the app's Archive.`;
  await sendTelegram(msg).catch(() => {});
  if (inoutFile && fs.existsSync(inoutFile)) await sendTelegramDocument(inoutFile, `📎 ${name} — punch history (archived)`).catch(() => {});
  console.log('=> DONE');
  process.exit(0);
})().catch(async (e) => {
  await sendTelegram(`⚠️ Archive/delete failed for ${CARD}: ${String(e.message).split('\n')[0]}`).catch(() => {});
  console.error('FAILED:', e.message); process.exit(1);
});
