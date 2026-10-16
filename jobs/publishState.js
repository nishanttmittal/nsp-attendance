// Scrapes the live floor state and publishes it to Firestore att_daily_stats/today,
// which the PWA dashboard reads. Run on a schedule (every few minutes during work hours).
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { db } = require('./lib/firestore');
const { checkMachine } = require('./lib/machineHealth');
const { sendPlain } = require('./lib/notify').channel('attendance');

(async () => {
  const { browser, page } = await session();
  try {
    const state = await gatherState(page);
    await db().collection('att_daily_stats').doc('today').set({ ...state, publishedAt: new Date().toISOString() });
    console.log(`published att_daily_stats/today — present ${state.counts?.totalPresent}, meal ${state.mealHeadcount}, late ${state.lateCount}, absent ${state.absentCount}, depts ${Object.keys(state.deptRatio || {}).length}`);
    // 16-10-2026: same session → machine Online/Offline + today's punches; alerts owner once if stuck
    if (process.env.MACHINE_CHECK !== 'off') await checkMachine(page, { send: sendPlain });
  } finally { await browser.close(); }
})();
