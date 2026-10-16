// Reprocess attendance for a date range (all employees). FROM/TO in dd/MM/yyyy.
const { session, reprocessRange } = require('./lib/realtime');
const { pullDeviceLog } = require('./lib/deviceLog');

(async () => {
  const { FROM, TO } = process.env;
  if (!FROM || !TO) { console.error('FROM and TO required'); process.exit(1); }
  const { browser, page } = await session();
  try {
    // PULL=1 (16-10-2026): first pull each day's punches from the machine into the portal — punches
    // reach the portal late and a reprocess alone misses them (13-10 and 16-10 counts came out short).
    if (process.env.PULL === '1') {
      const [fd, fm, fy] = FROM.split('/').map(Number), [td, tm, ty] = TO.split('/').map(Number);
      const days = [];
      for (let d = new Date(Date.UTC(fy, fm - 1, fd)); d <= new Date(Date.UTC(ty, tm - 1, td)) && days.length < 7; d = new Date(d.getTime() + 86400000))
        days.push(d.toISOString().slice(0, 10).split('-').reverse().join('/'));
      for (const day of days) {
        try { console.log(`device log ${day}: ${(await pullDeviceLog(page, day)).length} punches pulled`); }
        catch (e) { console.error(`device pull ${day} skipped: ${e.message}`); }
      }
    }
    await reprocessRange(page, FROM, TO); console.log('reprocessed ' + FROM + ' .. ' + TO); }
  finally { await browser.close(); }
})();
