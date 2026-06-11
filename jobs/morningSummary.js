// Morning attendance summary (~10:30 IST): present/absent/late counts + late names +
// understaffed departments (<50% present/total). One Telegram message.
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendTelegram } = require('./lib/notify');

(async () => {
  const { browser, page } = await session();
  try {
    const s = await gatherState(page);
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
