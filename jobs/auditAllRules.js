// Read-only: dump ALL rules for every shift (SiftDetails RowId 2-5) and every
// office-time policy (EmployeePolicy, RowIds scanned 1-8). Output: JSON on stdout.
const { session } = require('./lib/realtime');

const SHIFT_FIELDS = ['txtsftname', 'txtSftCode', 'txtsftstarttime', 'txtsiftendtime', 'txtsiftduration',
  'cboisnightshift', 'txtbegen1time', 'txtend1time', 'txtbreak1duration', 'txtbegen2time', 'txtend2time',
  'txtbreak2duration', 'DropDownList1', 'cboFWOff', 'cboSWOff', 'cboSWOtype', 'cbohalfdayshift',
  'txtchekmin', 'txtmaxearly', 'txtmaxrate', 'txtnoofweek', 'chkaaa', 'chk2',
  'optout', 'optworking', 'optearly', 'rdcalallinout', 'RdCalFirstinLastOut', 'RdCalFirstInLastOutWithLunch',
  'ChkLunchDeduct_lunchbreakexceeds', 'ChkLunchDeductAccordingtopunch', 'Chkfix', 'chllal'];
const POLICY_FIELDS = ['txtpolicyname', 'txtlatearrival', 'txtearlydeparture', 'txtdurationformakingpresent',
  'txtmaxabsentsortday', 'txtmaxworkinghour', 'txtmaxworkinghourhalf',
  'txtlate1', 'cbolateded1', 'txtlate2', 'cbolateded2', 'txtlate3', 'cbolateded3', 'txtlate4', 'cbolateded4',
  'txtEalry1', 'cboEarlyded1', 'txtEalry2', 'cboEarlyded2', 'txtEalry3', 'cboEarlyded3', 'txtEalry4', 'cboEarlyded4',
  'chkroundclock', 'cboRequiredpunchinday', 'cbosinglepunchonly', 'chkLateactive', 'RdCutDays', 'RdCutLeave',
  'Cbonooflate', 'DropDownList1', 'ChkShowLunchAsOt', 'txtShowLunchAsOt', 'IgnoreOTSetting',
  'txtmoofhrs', 'txtequaltoday', 'txtotinmonth', 'chkativelate', 'chkshortleavemaking'];

async function readPage(page, url, ids) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
  return page.evaluate((wanted) => {
    const out = {};
    for (const id of wanted) {
      const n = document.getElementById('MainContent_' + id);
      if (!n) continue;
      out[id] = n.tagName === 'SELECT'
        ? ((n.options[n.selectedIndex] || {}).text || '').trim()
        : ((n.type === 'checkbox' || n.type === 'radio') ? (n.checked ? 'YES' : 'no') : n.value.trim());
    }
    return out;
  }, ids);
}

(async () => {
  const { browser, page } = await session();
  const out = { shifts: {}, policies: {} };
  try {
    for (let row = 2; row <= 5; row++) {
      const f = await readPage(page, `https://onlinerealsoft.com/SiftDetails.aspx?RowId=${row}`, SHIFT_FIELDS);
      if (f.txtSftCode) out.shifts[f.txtSftCode] = { rowId: row, ...f };
    }
    for (let row = 1; row <= 8; row++) {
      const f = await readPage(page, `https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=${row}`, POLICY_FIELDS);
      if (f.txtpolicyname) out.policies[f.txtpolicyname] = { rowId: row, ...f };
    }
    console.log(JSON.stringify(out, null, 1));
  } finally { await browser.close(); }
})();
