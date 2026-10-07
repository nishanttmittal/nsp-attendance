// MORNING DIGEST — one short WhatsApp message at 10:30 (owner 07-10-2026). Replaces morningSummary.
// If the Realtime portal still shows yesterday, the hold goes to the TECH channel only (the owner
// was getting "Present 0 · Absent 0" — that was this case leaking through as a report).
const { session } = require('./lib/realtime');
const { gatherState } = require('./getState');
const { sendPlain: sendTelegram, sendTech } = require('./lib/notify'); // plain text: WA as-is, Telegram escaped
const { clip, dmy } = require('./lib/simple');
(async () => {
  const { browser, page } = await session();
  try {
    const s = await gatherState(page);
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (s.dataDate && s.dataDate !== todayIST) {
      await sendTech(`morning digest held — portal still on ${s.dataDate} (today ${todayIST})`);
      console.error(`held — portal date ${s.dataDate}`); return;
    }
    const present = s.counts?.totalPresent ?? 0, absent = s.counts?.totalAbsent ?? 0, late = s.lateCount ?? 0;
    if (!present && !absent) { await sendTech('morning digest held — portal returned 0 present / 0 absent'); return; }
    const L = [`☀️ Aaj — ${dmy(todayIST)}`, `Present ${present} · Absent ${absent} · Late ${late}`];
    if (s.late?.length) L.push('Late: ' + clip(s.late.map(l => l.name), 6));
    const under = Object.entries(s.deptRatio || {}).filter(([, r]) => r.total > 0 && r.pct < 50).map(([d, r]) => `${d} ${r.present}/${r.total}`);
    if (under.length) L.push('Kam staff: ' + under.join(', '));
    if (process.env.DRY) { console.log(L.join('\n')); return; }
    await sendTelegram(L.join('\n')); console.error('morning digest sent');
  } finally { await browser.close(); }
})();
