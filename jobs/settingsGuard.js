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
  { key: 'policy_GEN', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=2' },
];
// fields that change how punches are turned into attendance (the dangerous ones)
const WATCH = {
  shift: ['txtsftstarttime', 'txtsiftendtime', 'txtsiftduration', 'cboisnightshift',
    'txtchekmin', 'txtmaxearly', 'txtmaxrate', 'chk2', 'cboFWOff', 'DropDownList1'],
  policy: ['cboRequiredpunchinday', 'cbosinglepunchonly', 'txtdurationformakingpresent',
    'txtmaxabsentsortday', 'txtmaxworkinghour', 'txtmaxworkinghourhalf', 'IgnoreOTSetting'],
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
