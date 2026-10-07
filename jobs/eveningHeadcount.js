// 17:45 food headcount alert: how many to order for tonight (still in, minus welders),
// plus present count, per-dept, and the day's late-comers. Run by GH Actions cron ~17:40.
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');

function composeMessage(s) {
  // owner 07-10-2026: simple — one line for the kitchen, one for the floor
  return [
    `🍽️ Khana order: ${s.mealHeadcount} (welders chhod kar)`,
    `Present ${s.counts.totalPresent ?? s.presentTotal} · Absent ${s.counts.totalAbsent ?? '—'} · Late ${s.lateCount}`,
  ].join('\n');
}

if (require.main === module) {
  (async () => {
    const { browser, page } = await session();
    try {
      const state = await gatherState(page);
      const msg = composeMessage(state);
      await sendTelegram(msg);
    } finally { await browser.close(); }
  })();
}

module.exports = { composeMessage };
