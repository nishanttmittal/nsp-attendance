// Read-only dump of GEN policy + GEN shift pages (all fields incl. select options).
// Output: downloads/genfix_<tag>.json   (TAG env, default "before")
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');

const PAGES = [
  { key: 'policy_GEN', url: 'https://onlinerealsoft.com/EmployeePolicy.aspx?RowId=2' },
  { key: 'shift_GEN',  url: 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=2' },
];
const TAG = process.env.TAG || 'before';

(async () => {
  const { browser, page } = await session();
  const out = {};
  try {
    for (const p of PAGES) {
      await page.goto(p.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      out[p.key] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input, select, textarea'))
          .filter(n => n.id && n.id.startsWith('MainContent_'))
          .map(n => ({
            id: n.id, type: n.type || n.tagName.toLowerCase(),
            value: n.value,
            checked: (n.type === 'checkbox' || n.type === 'radio') ? n.checked : undefined,
            selectedLabel: n.tagName === 'SELECT' ? (n.options[n.selectedIndex] || {}).text : undefined,
            options: n.tagName === 'SELECT' ? Array.from(n.options).map(o => o.text.trim()) : undefined,
          }))
      );
    }
    const file = path.join(__dirname, 'downloads', `genfix_${TAG}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    console.log('saved', file);
    // quick human summary of the interesting bits
    for (const k of Object.keys(out)) {
      console.log('==', k);
      out[k].filter(f => f.type !== 'submit' && f.type !== 'button')
        .forEach(f => console.log('  ', f.id.replace('MainContent_', ''),
          f.checked !== undefined ? (f.checked ? '[x]' : '[ ]') : '',
          f.selectedLabel !== undefined ? `= ${f.selectedLabel}  options:[${f.options.join(' | ')}]` : `= ${JSON.stringify(f.value)}`));
    }
  } finally { await browser.close(); }
})();
