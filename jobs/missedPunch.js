// Missed-punch alert. Computed from the present list's In/Out (clean), not the
// messy ReportViewer. MODE=morning flags missing IN-punch; MODE=evening flags missing OUT-punch.
// Scheduled by GH Actions: morning run after grace, evening run after the latest shift ends.
const { session, setField } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');

const MODE = (process.env.MODE || 'evening').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

// EVENING: punched in, no out (today, after shift). Computed from the present list.
function composeEvening(list) {
  const body = list.length ? list.map(r => `  • ${r.name} (${r.dept})  in ${r.inT || '—'} / out —`).join('\n') : '  • none 🎉';
  return `🌙 <b>Evening missed punch</b> (punched in, never punched OUT)\n${body}\n\n<i>Fix via the app's manual-punch entry.</i>`;
}

// MORNING (runs next day): employees who missed a punch YESTERDAY (single-punch). From the
// Missing-Punch report for yesterday — a missing IN is ambiguous same-day, so reviewed next day.
async function yesterdayMisses(page) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  await page.goto('https://onlinerealsoft.com/NewMonthly.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
  if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) await page.uncheck('#MainContent_chknewwindow').catch(() => {});
  await setField(page, '#MainContent_txtdate', fmtDate(y));
  await setField(page, '#MainContent_txttodate', fmtDate(y));
  await page.click('#MainContent_Button6'); await page.waitForTimeout(3500);   // Missing Punch report
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  // report repeats each employee as two "Emp.Name:-" tokens (code, then name+detail); "Miss N" = missed
  const parts = text.split('Emp.Name:-').slice(1);
  const seen = new Set(); const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = (parts[i] || '').trim().split(/\s/)[0];
    const rest = parts[i + 1] || '';
    if (!code || seen.has(code)) continue;
    if (/Miss\s+\d+/.test(rest)) {
      const name = rest.split('Dept')[0].trim();
      const dept = (rest.match(/Dept:-:?\s*([A-Za-z ]+?)\s+Desig/) || [])[1] || '';
      seen.add(code); out.push({ code, name, dept: dept.trim() });
    }
  }
  return { date: fmtDate(y), list: out };
}

if (require.main === module) {
  (async () => {
    const { browser, page } = await session();
    try {
      if (MODE === 'morning') {
        const { date, list } = await yesterdayMisses(page);
        const body = list.length ? list.map(r => `  • ${r.name} (${r.dept})`).join('\n') : '  • none 🎉';
        await sendTelegram(`⏰ <b>Missed punch — ${date}</b> (single punch yesterday; review & correct)\n${body}\n\n<i>Fix via the app's manual-punch entry.</i>`);
        console.error(`[morning] yesterday ${date}: ${list.length} missed`);
      } else {
        const s = await gatherState(page);
        const list = (s.presentRows || []).filter(r => (r.inT && r.inT.trim()) && !(r.outT && r.outT.trim()));
        await sendTelegram(composeEvening(list));
        console.error(`[evening] flagged ${list.length} of ${(s.presentRows || []).length} present`);
      }
    } finally { await browser.close(); }
  })();
}

module.exports = { composeEvening };
