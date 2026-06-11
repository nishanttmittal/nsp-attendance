// Reprocess attendance for a date range (all employees). FROM/TO in dd/MM/yyyy.
const { session, reprocessRange } = require('./lib/realtime');

(async () => {
  const { FROM, TO } = process.env;
  if (!FROM || !TO) { console.error('FROM and TO required'); process.exit(1); }
  const { browser, page } = await session();
  try { await reprocessRange(page, FROM, TO); console.log('reprocessed ' + FROM + ' .. ' + TO); }
  finally { await browser.close(); }
})();
