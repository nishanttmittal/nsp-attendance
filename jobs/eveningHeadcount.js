// 17:45 food headcount alert: how many to order for tonight (still in, minus welders),
// plus present count, per-dept, and the day's late-comers. Run by GH Actions cron ~17:40.
const { session } = require('./lib/realtime');
const { pullAndProcessToday } = require('./lib/deviceLog');
const { gatherState } = require('./getState');
const { sendPlain: sendTelegram, sendTech } = require('./lib/notify').channel('attendance'); // plain text: WA as-is, Telegram escaped

function composeMessage(s) {
  // owner 07-10-2026: simple — one line for the kitchen, one for the floor
  return [
    `🍽️ Khana order: ${s.mealHeadcount} (welders chhod kar)`,
    `Present ${s.counts.totalPresent ?? s.presentTotal} · Absent ${s.counts.totalAbsent ?? '—'} · Late ${s.lateCount}`,
  ].join('\n');
}

if (require.main === module) {
  (async () => {
    const once = require('./lib/onceADay');
    if (await once.alreadySent('foodHeadcount')) { console.log('food headcount already sent today — skipped'); return; }
    const { browser, page } = await session();
    try {
      // 16-10-2026: punches reach the portal late (13-10: 48 not 63; 16-10: 2 not 62). Pull today's punches
      // from the machine and process today first, in this same login, so the food count includes everyone.
      await pullAndProcessToday(page);
      const state = await gatherState(page);
      if (!(state.counts?.totalPresent ?? state.presentTotal) && !state.counts?.totalAbsent) { await sendTech('food headcount held — portal returned 0 present / 0 absent'); console.error('held: zeros'); return; }
      const msg = composeMessage(state);
      await sendTelegram(msg);
      await once.markSent('foodHeadcount');
    } finally { await browser.close(); }
  })();
}

module.exports = { composeMessage };
