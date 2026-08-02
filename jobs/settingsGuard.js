// Daily guard against silent Realtime settings drift. In June 2026 GEN shift's
// "max late window" (txtmaxrate) was silently changed to 16:00, which made the day
// window swallow the NEXT morning's IN punch as the day's OUT and inflated OT ~4x
// across May/June. This compares the live shift/policy pages to a known-good
// baseline and Telegrams the owner on any difference.
//   CAPTURE=true node settingsGuard.js   -> rewrite shiftBaseline.json from live pages
//   node settingsGuard.js                -> compare live vs baseline, alert on drift
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');
const { sendTelegram } = require('./lib/notify');

const BASELINE = path.resolve(__dirname, 'shiftBaseline.json');
const PAGES = [
  { key: 'shift_GEN',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=2' },
  { key: 'shift_10H',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=3' },
  { key: 'shift_12H',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=4' },
  { key: 'shift_wir',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=5' },
  // DSG (designer, 09:00–19:00) and LOD (loading, 09:00–20:30) were NEVER watched — a silent change
  // to either raised no alert. RowIds confirmed from SiftDetailsList 2026-07-29. See portal-shift-table.
  { key: 'shift_DSG',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=6' },
  { key: 'shift_LOD',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=7' },
  { key: 'policy_GEN', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=2' },
  { key: 'policy_10H', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=3' },
  { key: 'policy_12H', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=4' },
  { key: 'policy_wir', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=5' },
  // DSG policy CREATED 2026-07-30 (RowId 6) — full-day line 08:15, derived from the formula every
  // other policy obeys: shift span − 1:30 − 0:15 grace (DSG span 10:00). It decides whether the
  // designer's day counts full or half, so it is watched from the moment it existed.
  { key: 'policy_DSG', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=6' },
  // LOD policy CREATED 2026-08-01 (RowId 7, confirmed from EmployeePolicyList) — full-day line 09:45
  // from the same house formula (LOD span 11:30 − 1:30 lunch − 0:15 grace). Before this the 4 LOD
  // loading staff sat on the GEN policy (line 06:45), which is why the portal reported 13-20 h of
  // phantom OT for them off an 8.5 h basis. Measured cost of the move: Rs 0.00 for three of them and
  // +Rs 15.91-31.81 for one (in his favour) — see payroll-daily-wagers.
  { key: 'policy_LOD', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=7' },
];
// fields that change how punches are turned into attendance (the dangerous ones)
const WATCH = {
  // txtnoofweek added 2026-07-30: it is the portal field that decides whether a worker EARNS that
  // week's paid Saturday. It was unwatched, so a change to it would have silently altered pay.
  shift: ['txtsftstarttime', 'txtsiftendtime', 'txtsiftduration', 'cboisnightshift',
    'txtchekmin', 'txtmaxearly', 'txtmaxrate', 'txtnoofweek', 'chk2', 'cboFWOff', 'DropDownList1'],
  policy: ['cboRequiredpunchinday', 'cbosinglepunchonly', 'txtdurationformakingpresent',
    'txtmaxabsentsortday', 'txtmaxworkinghour', 'txtmaxworkinghourhalf', 'IgnoreOTSetting',
    'txtlatearrival', 'txtearlydeparture',
    'txtlate1', 'cbolateded1', 'txtlate2', 'cbolateded2', 'txtlate3', 'cbolateded3', 'txtlate4', 'cbolateded4',
    'txtEalry1', 'cboEarlyded1', 'txtEalry2', 'cboEarlyded2', 'txtEalry3', 'cboEarlyded3', 'txtEalry4', 'cboEarlyded4',
    'chkroundclock', 'chkLateactive', 'Cbonooflate', 'DropDownList1'],
};

async function readPage(page, url, ids) {
  // Was: domcontentloaded + a fixed 1200 ms sleep. On a slow night that returned a page whose form
  // had not rendered, so EVERY field read as '<missing>' — and CAPTURE wrote those placeholders
  // over the baseline (2026-08-01). Wait for the form to actually exist instead of guessing a delay.
  // 'domcontentloaded', not 'networkidle': this ASP.NET portal keeps connections busy long after the
  // form is usable, so networkidle made a 12-page sweep exceed its own timeout and get killed mid-run
  // (twice on 2026-08-02). Correctness here comes from WAITING FOR THE FIELD below — which is what
  // the original bug lacked — not from waiting on the network.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // FAIL FAST ON A DEAD PAGE (2026-08-02). The vendor migrated the portal to ERP_-prefixed pages,
  // so these URLs now return the ASP.NET 404 — and waiting 60 s for a field that will never appear,
  // twelve times over, made the guard take longer than its own timeout and get killed before it
  // could report anything. A monitor that cannot finish failing is a monitor that says nothing.
  const title = await page.title().catch(() => '');
  if (/resource cannot be found|not found|unauthor/i.test(title))
    throw new Error(`${url} returned "${title}" — the page no longer exists. The portal moved to ERP_-prefixed pages on 2026-08-02; this watcher needs porting before it can check anything.`);
  await page.locator('#MainContent_' + ids[0]).waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  return page.evaluate((wanted) => {
    const out = {};
    for (const id of wanted) {
      const n = document.getElementById('MainContent_' + id);
      if (!n) { out[id] = '<missing>'; continue; }
      out[id] = n.tagName === 'SELECT'
        ? ((n.options[n.selectedIndex] || {}).text || '').trim()
        : (n.type === 'checkbox' ? String(n.checked) : n.value.trim());
    }
    return out;
  }, ids);
}

async function readAll() {
  const { browser, page } = await session();
  const live = {};
  try {
    for (const p of PAGES) {
      live[p.key] = await readPage(page, p.url, p.key.startsWith('policy') ? WATCH.policy : WATCH.shift);
    }
  } finally { await browser.close(); }
  return live;
}

async function guard() {
  const live = await readAll();
  if (process.env.CAPTURE === 'true') {
    // REFUSE TO CAPTURE A BROKEN READ (2026-08-01). readPage() writes '<missing>' for any field it
    // cannot find, and this used to write that straight into the baseline. It happened for real:
    // a capture run where most pages failed to render replaced almost every reference value with
    // '<missing>', which would then have made the guard compare against nothing and report "no
    // drift" forever — the reference destroyed by the very command meant to refresh it.
    // A baseline is a security reference. An incomplete read is not a new baseline.
    const broken = [];
    for (const [pageKey, fields] of Object.entries(live))
      for (const [f, v] of Object.entries(fields || {}))
        if (v === '<missing>' || v === '' || v == null) broken.push(`${pageKey}.${f}="${v}"`);
    if (broken.length) {
      console.error(`\n🚨 REFUSING TO CAPTURE — ${broken.length} field(s) did not read. The existing baseline is UNCHANGED.`);
      console.error('   The portal was probably slow or a page did not render. Just run it again.');
      broken.slice(0, 12).forEach((b) => console.error('   ' + b));
      if (broken.length > 12) console.error(`   …and ${broken.length - 12} more`);
      return 2;
    }
    // Never shrink the reference either: a page that silently dropped out of PAGES would quietly
    // stop being watched, and nothing would say so.
    if (fs.existsSync(BASELINE)) {
      const prev = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      const lost = Object.keys(prev).filter((k) => !(k in live));
      if (lost.length) {
        console.error(`\n🚨 REFUSING TO CAPTURE — would stop watching: ${lost.join(', ')}. Baseline UNCHANGED.`);
        return 2;
      }
    }
    fs.writeFileSync(BASELINE, JSON.stringify(live, null, 1));
    console.log(`baseline captured (${Object.keys(live).length} pages, all fields read) ->`, BASELINE);
    return 0;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  // COULD-NOT-READ is not DRIFT (2026-08-01). If a page fails to render, every field comes back
  // '<missing>' and this would have shouted "235 settings changed" — a false alarm that trains the
  // reader to ignore the alert. Report the outage as an outage; it still fails loudly.
  const unread = [];
  for (const pageKey of Object.keys(base))
    for (const f of Object.keys(base[pageKey]))
      if ((live[pageKey] || {})[f] === '<missing>') unread.push(`${pageKey}.${f}`);
  if (unread.length) {
    await sendTelegram(`⚠️ <b>Settings guard could not READ the portal</b> — ${unread.length} field(s) did not render (e.g. ${unread.slice(0, 3).join(', ')}). Settings were <b>not checked</b> this run. This is "unknown", not "ok".`).catch(() => {});
    console.error(`could not read ${unread.length} field(s) — settings NOT checked this run`);
    return 2;
  }
  const drift = [];
  for (const pageKey of Object.keys(base)) {
    for (const f of Object.keys(base[pageKey])) {
      const want = base[pageKey][f], got = (live[pageKey] || {})[f];
      if (got !== want) drift.push(`${pageKey}.${f}: "${want}" → "${got}"`);
    }
  }
  if (drift.length) {
    await sendTelegram(
      '🚨 <b>Realtime settings changed!</b> Attendance/OT can go wrong (like the May–June OT bug).\n' +
      drift.map(d => '• ' + d).join('\n') +
      '\nIf you did not change this, restore it before the daily reprocess.');
    console.log('DRIFT:\n' + drift.join('\n'));
  } else {
    console.log('settings OK (no drift)');
  }
  return drift.length;
}

module.exports = { guard };
if (require.main === module) guard().catch(e => { console.error(e); process.exit(1); });
