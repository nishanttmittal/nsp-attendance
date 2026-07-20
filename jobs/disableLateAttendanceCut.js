// Turns OFF the "late-coming -> Deduct From Attendance" rule on EVERY policy, so a late
// arrival NO LONGER cuts present days. (Owner rule 2026-06-17: late time hits OVERTIME, not
// present days — the app already does net OT = OT - late - early. See memory payroll-late-early-policy.)
// The late-coming HOURS keep being reported (driven by txtlatearrival grace), so the app can still
// subtract them from OT — we only disable the day-deduction (chkLateactive).
//
// SAFE: DRY_RUN=true (default) reads + backs up + screenshots, saves NOTHING.
//       DRY_RUN=false unchecks chkLateactive, clicks Save, reloads, and verifies it stuck.
// Backup of every policy's before-state is written to rules_backup/ regardless.
const fs = require('fs');
const path = require('path');
const { session } = require('./lib/realtime');

const DRY = process.env.DRY_RUN !== 'false';
const S = '#MainContent_';
const POLICY = 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=';
const PAGES = [
  { key: 'GEN', url: POLICY + '2', expect: 'GEN' },
  { key: '10H', url: POLICY + '3', expect: '10H' },
  { key: '12H', url: POLICY + '4', expect: '12H' },
  { key: 'amarjeet', url: POLICY + '5', expect: 'amarjeet' },
];

const OUT = path.resolve(__dirname, 'apply_output'); fs.mkdirSync(OUT, { recursive: true });
const BK = path.resolve(__dirname, 'rules_backup'); fs.mkdirSync(BK, { recursive: true });

const isChk = (page, sel) => page.locator(sel).isChecked().catch(() => null);
const selText = (page, sel) => page.locator(sel).evaluate(n => (n.options[n.selectedIndex] || {}).text || '').catch(() => '?');
const inpVal = (page, sel) => page.locator(sel).inputValue().catch(() => '?');

async function snapshot(page) {
  return {
    chkLateactive: await isChk(page, S + 'chkLateactive'),
    RdCutDays: await isChk(page, S + 'RdCutDays'),
    RdCutLeave: await isChk(page, S + 'RdCutLeave'),
    Cbonooflate: await selText(page, S + 'Cbonooflate'),
    txtequaltoday: await inpVal(page, S + 'txtequaltoday'),
    txtlatearrival: await inpVal(page, S + 'txtlatearrival'),   // late-report grace (must stay)
  };
}

(async () => {
  const { browser, page } = await session();
  const report = [];
  const backup = { when: new Date().toISOString(), dry: DRY, policies: {} };
  try {
    for (const P of PAGES) {
      await page.goto(P.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
      const id = (await inpVal(page, S + 'txtpolicyname')).trim();
      if (id.toLowerCase() !== P.expect.toLowerCase()) { report.push(`${P.key}: ABORT — page shows "${id}" not "${P.expect}"`); continue; }

      const before = await snapshot(page);
      backup.policies[P.key] = { before };

      if (before.chkLateactive === false) {
        report.push(`${P.key} (${id}): already OFF — nothing to do. ${JSON.stringify(before)}`);
        await page.screenshot({ path: path.join(OUT, `latecut_${P.key}_alreadyoff.png`), fullPage: true });
        continue;
      }

      // uncheck the master late-deduction switch
      await page.locator(S + 'chkLateactive').uncheck({ force: true }).catch(async () => {
        await page.locator(S + 'chkLateactive').evaluate(n => { n.checked = false; n.dispatchEvent(new Event('click', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
      });
      await page.waitForTimeout(1200);   // in case of AutoPostBack
      const afterEdit = await isChk(page, S + 'chkLateactive');
      await page.screenshot({ path: path.join(OUT, `latecut_${P.key}_${DRY ? 'dry' : 'presave'}.png`), fullPage: true });

      if (!DRY) {
        await page.click(S + 'cmdsave').catch(() => {});
        await page.waitForTimeout(2800);
        // reload and verify it stuck
        await page.goto(P.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
        const after = await snapshot(page);
        backup.policies[P.key].after = after;
        const ok = after.chkLateactive === false && after.txtlatearrival === before.txtlatearrival;
        report.push(`${P.key} (${id}) [SAVED] chkLateactive ${before.chkLateactive}→${after.chkLateactive}; late-grace ${after.txtlatearrival} ${ok ? 'OK' : '*** CHECK'}`);
      } else {
        report.push(`${P.key} (${id}) [DRY] chkLateactive ${before.chkLateactive}→(would be)${afterEdit}; rule was: cutFrom=${before.RdCutDays ? 'Attendance' : before.RdCutLeave ? 'Leave' : '?'} nooflate=${before.Cbonooflate} equalToDay=${before.txtequaltoday}`);
      }
    }
  } catch (e) { report.push('ERROR: ' + e.message); }
  finally { await browser.close(); }

  const bkFile = path.join(BK, `late_attendance_backup_${Date.now()}.json`);
  fs.writeFileSync(bkFile, JSON.stringify(backup, null, 2));
  console.log((DRY ? '=== DRY RUN (nothing saved) ===' : '=== SAVED ===') + '\n' + report.join('\n'));
  console.log('\nbackup written: ' + bkFile);
})();
