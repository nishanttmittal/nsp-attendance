// Set ONE field on GEN shift page (SiftDetails RowId=2) with a from-value guard.
//   SEL=#MainContent_txtmaxrate FROMV=16:00 TOV=10:00 node genFixApply.js
const path = require('path');
const fs = require('fs');
const { session, setField } = require('./lib/realtime');

const URL = 'https://onlinerealsoft.com/SiftDetails.aspx?RowId=2';
const { SEL, FROMV, TOV } = process.env;
const OUT_DIR = path.join(__dirname, 'downloads');

(async () => {
  if (!SEL || !TOV) { console.error('SEL and TOV required'); process.exit(1); }
  const { browser, page } = await session();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const before = await page.locator(SEL).inputValue();
    if (FROMV && before.trim() !== FROMV) {
      console.error(`ABORT: ${SEL} expected "${FROMV}" found "${before}" — nothing saved`);
      return;
    }
    await setField(page, SEL, TOV);
    await page.screenshot({ path: path.join(OUT_DIR, 'genfix_filled.png'), fullPage: true });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.click('#MainContent_cmdsave'),
    ]);
    await page.waitForTimeout(2000);
    // verify persisted
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const after = await page.locator(SEL).inputValue();
    console.log(`${SEL}: "${before}" -> saved, re-read = "${after}" ${after.trim() === TOV ? 'OK' : 'MISMATCH!'}`);
  } finally { await browser.close(); }
})();
