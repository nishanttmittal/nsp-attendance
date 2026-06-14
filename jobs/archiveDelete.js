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
const { execFileSync } = require('child_process');
const { session, findEmployeeRowId } = require('./lib/realtime');
const { db } = require('./lib/firestore');
const { sendTelegram, sendTelegramDocument } = require('./lib/notify');

const OUT_DIR = path.resolve(__dirname, 'downloads');
const CARD = process.env.CARD;
const DRY = process.env.DRY === 'true';
const today = () => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };

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
  let inoutFile = null, inoutText = null, doj = null;
  try {
    const rowid = await findEmployeeRowId(page, CARD);
    if (!rowid) throw new Error(`worker ${CARD} not found on machine — aborting (nothing deleted)`);
    await page.goto('https://onlinerealsoft.com/Employee.aspx?RowId=' + rowid, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    doj = await page.locator('#MainContent_TxtDOJ').inputValue().catch(() => null);

    // 2. scrape full in-out punch history (DOJ..today). Separate process = its own browser session.
    try {
      const from = doj && /\d{2}\/\d{2}\/\d{4}/.test(doj) ? doj : '01/01/2024';
      const out = execFileSync('node', [path.resolve(__dirname, 'monthlyDownload.js')], {
        env: { ...process.env, SCOPE: 'emp:' + CARD, REPORT: 'Button15', FROM: from, TO: today() },
        encoding: 'utf8', timeout: 200000,
      });
      const m = out.match(/DOWNLOADED (\S+)/);
      if (m) { inoutFile = path.join(OUT_DIR, m[1]); inoutText = fs.readFileSync(inoutFile, 'utf8'); }
    } catch (e) { console.error('in-out scrape failed (continuing with app record only):', e.message); }

    // 3. write the archive + verify (the gate)
    const archive = {
      code: CARD, name, dept: (sal && sal.dept) || '', doj: doj || '',
      archivedAt: new Date().toISOString(), archivedBy: process.env.BY || 'app',
      salary: sal || null, attendance: attDoc.exists ? attDoc.data() : null,
      inoutFileName: inoutFile ? path.basename(inoutFile) : null,
      // Firestore caps a doc at ~1MB, and the full in-out report can exceed that — the COMPLETE
      // history is sent to the owner's Telegram as a file. Here we keep only a small preview.
      punchHistoryPreview: inoutText ? inoutText.slice(0, 40000) : '(in-out history sent to Telegram only)',
      punchHistoryCaptured: !!inoutText,
    };
    await fdb.collection('att_archive').doc(CARD).set(archive);
    const check = await fdb.collection('att_archive').doc(CARD).get();
    if (!check.exists) throw new Error('archive write failed — DELETE ABORTED (safety gate)');
    console.log('archived att_archive/' + CARD + ' (inout:', !!inoutText, ')');

    if (DRY) { console.log('=> DRY: archived only, machine NOT touched'); }
    else {
      // 4. delete on the machine via the list page (tick row checkbox, click Delete, confirm)
      await page.goto('https://onlinerealsoft.com/EmployeeList.aspx', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const ticked = await page.evaluate((c) => {
        for (const tr of document.querySelectorAll('tr')) {
          if ((tr.innerText || '').includes(c)) {
            const cb = tr.querySelector('input[type=checkbox]');
            if (cb) { cb.checked = true; cb.dispatchEvent(new Event('click', { bubbles: true })); return { id: cb.id, value: cb.value }; }
          }
        }
        return null;
      }, CARD);
      if (!ticked) throw new Error('could not tick worker row for delete (archive is safe)');
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}), page.click('#MainContent_BtnDel')]);
      await page.waitForTimeout(2500);
      const still = await page.evaluate((c) => document.body.innerText.includes(c), CARD);
      if (still) throw new Error('delete did not take — worker still on machine (archive is safe)');
      console.log('deleted from machine. confirm dialog:', JSON.stringify(dialogs));
      await fdb.collection('att_salary').doc(CARD).set({ archivedToMachine: false, deletedFromMachine: true, deletedAt: new Date().toISOString() }, { merge: true });
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
