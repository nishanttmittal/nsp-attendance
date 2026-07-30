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
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
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
    fs.writeFileSync(BASELINE, JSON.stringify(live, null, 1));
    console.log('baseline captured ->', BASELINE);
    return 0;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
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
