// Morning attendance summary (~10:30 IST): present/absent/late counts + late names +
// understaffed departments (<50% present/total). One Telegram message.
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');

(async () => {
  const { browser, page } = await session();
  try {
    const s = await gatherState(page);
    // Date guard: the Realtime portal can still be showing YESTERDAY in the late
    // morning (it rolls over to the new day around midday). If so, the live lists
    // are yesterday's — sending them as "today" is the wrong-feedback bug. Send a
    // short heads-up instead of a misleading summary; it'll be right once synced.
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (s.dataDate && s.dataDate !== todayIST) {
      await sendTelegram(
        `☀️ <b>Morning attendance</b>\n` +
        `⚠️ Realtime portal is still showing <b>${s.dataDate}</b>, not today (${todayIST}). ` +
        `Today's punches haven't synced yet — holding the summary so it doesn't report yesterday's data. ` +
        `It will be accurate once the portal updates.`);
      console.error(`morning summary held — portal date ${s.dataDate} != today ${todayIST}`);
      return;
    }
    const understaffed = Object.entries(s.deptRatio || {})
      .filter(([, r]) => r.total > 0 && r.pct < 50)
      .sort((a, b) => a[1].pct - b[1].pct);
    const lines = [
      `☀️ <b>Morning attendance — ${new Date().toLocaleDateString('en-IN')}</b>`,
      `Present ${s.counts.totalPresent} · Absent ${s.counts.totalAbsent} · Late ${s.lateCount}`,
      '',
      `<b>Late (${s.lateCount}):</b>`,
      ...(s.late.length ? s.late.map(l => `  • ${l.name} (${l.dept})`) : ['  • none']),
      '',
      `<b>Understaffed &lt;50% (${understaffed.length}):</b>`,
      ...(understaffed.length ? understaffed.map(([d, r]) => `  • ${d}: ${r.present}/${r.total} (${r.pct}%)`) : ['  • none 🎉']),
    ];
    await sendTelegram(lines.join('\n'));
    console.error('morning summary sent');
  } finally { await browser.close(); }
})();
