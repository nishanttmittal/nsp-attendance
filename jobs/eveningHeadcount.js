// 17:45 food headcount alert: how many to order for tonight (still in, minus welders),
// plus present count, per-dept, and the day's late-comers. Run by GH Actions cron ~17:40.
const { session, reprocessDay } = require('./lib/realtime');
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
    const { browser, page } = await session();
    try {
      // 16-10-2026: punches can reach the portal after its own processing (13-10: 48 not 63; 16-10: 2 not 62).
      // Process TODAY first, in this same login, so the food count includes every punch.
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10).split('-').reverse().join('/');
      try { await reprocessDay(page, ist); } catch (e) { console.error('reprocess skipped:', e.message); }
      const state = await gatherState(page);
      if (!(state.counts?.totalPresent ?? state.presentTotal) && !state.counts?.totalAbsent) { await sendTech('food headcount held — portal returned 0 present / 0 absent'); console.error('held: zeros'); return; }
      const msg = composeMessage(state);
      await sendTelegram(msg);
    } finally { await browser.close(); }
  })();
}

module.exports = { composeMessage };
