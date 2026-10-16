// Biometric machine raw log on the portal (ERP_AttendanceLog.aspx). Clicking #Button3 for a date
// pulls that day's punches FROM THE MACHINE INTO THE PORTAL and shows them. 16-10-2026 proof: the
// 17:40 reprocess alone left the count at 1; after #Button3 + reprocess it was 62 (13-10 the same).
// So any count that matters (food, samosa) must do: pullDeviceLog → reprocessDay → count.
const { readGrid, reprocessDay } = require('./realtime');

const LOG_URL = 'https://onlinerealsoft.com/ERP_AttendanceLog.aspx';

async function pullDeviceLog(page, dmy) {
  await page.goto(LOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  page.on('dialog', d => d.accept().catch(() => {}));
  // Changing the date / device fields can post the page back — do each step, then let it settle.
  const settle = async () => { await page.waitForLoadState('domcontentloaded').catch(() => {}); await page.waitForTimeout(2000); };
  for (const id of ['txtdate', 'txttodate']) {
    await page.evaluate(([id, v]) => {
      const el = document.getElementById(id); if (!el) return;
      if (el._flatpickr) el._flatpickr.setDate(v, true, 'd/m/Y');
      el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
    }, [id, dmy]).catch(() => {});
    await settle();
  }
  await page.evaluate(() => {
    const dl = document.getElementById('Device_List');
    if (dl) { for (const o of dl.options) o.selected = true; dl.dispatchEvent(new Event('change', { bubbles: true })); }
  }).catch(() => {});
  await settle();
  const got = await page.evaluate(() => [document.getElementById('txtdate')?.value, document.getElementById('txttodate')?.value]).catch(() => []);
  if (got[0] !== dmy || got[1] !== dmy) throw new Error(`date fields not set (${got.join('..')}), wanted ${dmy}`);
  // #Button3 may answer with a file download instead of a grid — swallow it, read the grid.
  page.once('download', d => d.cancel().catch(() => {}));
  await page.click('#Button3').catch(() => {});
  // The page posts back (sometimes twice) before the grid shows — poll until the row count holds steady.
  const isPunch = r => /^\d{5,}$/.test(r[0] || '') && /\d{1,2}:\d{2}/.test(r[1] || '');
  let rows = [], prevN = -1, steady = 0;
  for (let i = 0; i < 20 && steady < 2; i++) {
    await page.waitForTimeout(4000);
    const g = await readGrid(page).catch(() => null);
    if (!g) { steady = 0; continue; }                  // mid-navigation, try again
    rows = g.filter(isPunch);
    steady = rows.length === prevN ? steady + 1 : 0; prevN = rows.length;
  }
  return rows;
}

const todayDmy = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10).split('-').reverse().join('/');

// Pull today's punches from the machine, then process today. Never throws; returns the punch rows count.
async function pullAndProcessToday(page) {
  const dmy = todayDmy();
  let n = null;
  try { n = (await pullDeviceLog(page, dmy)).length; console.log(`device log ${dmy}: ${n} punches pulled`); }
  catch (e) { console.error('device pull skipped:', e.message); }
  try { await reprocessDay(page, dmy); console.log(`reprocessed ${dmy}`); }
  catch (e) { console.error('reprocess skipped:', e.message); }
  return n;
}

module.exports = { LOG_URL, pullDeviceLog, pullAndProcessToday };
