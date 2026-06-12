// One-time repair: reprocess 01/05/2026 .. 12/06/2026 in 7-day chunks (NEVER April —
// April is clean/paid). Run after GEN shift txtmaxrate was restored to 10:00.
const { session, reprocessRange } = require('./lib/realtime');

const chunks = [
  ['01/05/2026', '07/05/2026'],
  ['08/05/2026', '14/05/2026'],
  ['15/05/2026', '21/05/2026'],
  ['22/05/2026', '28/05/2026'],
  ['29/05/2026', '31/05/2026'],
  ['01/06/2026', '07/06/2026'],
  ['08/06/2026', '12/06/2026'],
];

(async () => {
  const { browser, page } = await session();
  try {
    for (const [from, to] of chunks) {
      const t0 = Date.now();
      await reprocessRange(page, from, to);
      console.log(`reprocessed ${from} .. ${to}  (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  } finally { await browser.close(); }
})();
