// 17:45 food headcount alert: how many to order for tonight (still in, minus welders),
// plus present count, per-dept, and the day's late-comers. Run by GH Actions cron ~17:40.
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');

function composeMessage(s) {
  const dept = Object.entries(s.perDept).sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `  • ${d}: ${n}`).join('\n');
  const late = s.late.length
    ? s.late.map(l => `  • ${l.name} (${l.dept}) in ${l.inT}`).join('\n')
    : '  • none';
  return [
    `<b>🍽️ Evening headcount — order food for ${s.mealHeadcount}</b>`,
    `(still in, excluding ${s.mealExcludes}; ${s.stillInCount} total still in)`,
    ``,
    `<b>Present now:</b> ${s.counts.totalPresent ?? s.presentTotal}  ·  Absent: ${s.counts.totalAbsent ?? '—'}`,
    `<b>By department:</b>`,
    dept,
    ``,
    `<b>Late today (${s.lateCount}):</b>`,
    late,
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
