// Reprocess yesterday for all employees so attendance/OT/salary stay current "till previous day".
const { session, reprocessDay } = require('./lib/realtime');
const pad = n => String(n).padStart(2, '0');

(async () => {
  const { browser, page } = await session();
  try {
    const y = new Date(); y.setDate(y.getDate() - 1);
    const d = `${pad(y.getDate())}/${pad(y.getMonth() + 1)}/${y.getFullYear()}`;
    await reprocessDay(page, d);
    console.log('reprocessed ' + d);
  } finally { await browser.close(); }
})();
