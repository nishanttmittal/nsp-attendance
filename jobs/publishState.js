// Scrapes the live floor state and publishes it to Firestore att_daily_stats/today,
// which the PWA dashboard reads. Run on a schedule (every few minutes during work hours).
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { db } = require('./lib/firestore');

(async () => {
  const { browser, page } = await session();
  try {
    const state = await gatherState(page);
    await db().collection('att_daily_stats').doc('today').set({ ...state, publishedAt: new Date().toISOString() });
    console.log(`published att_daily_stats/today — present ${state.counts?.totalPresent}, meal ${state.mealHeadcount}, late ${state.lateCount}, absent ${state.absentCount}, depts ${Object.keys(state.deptRatio || {}).length}`);
  } finally { await browser.close(); }
})();
