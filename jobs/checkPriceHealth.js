// Daily health check for the costing Live Rates tracker. Runs ~30 min after the
// price grab (fetchDelhiPrices.js). Reads the last two snapshots and pings Telegram
// ONLY when something needs attention — a source went silently stale/missing, or a
// price moved sharply. Silent when all is well. Runs in GitHub Actions (has secrets +
// Firestore + Telegram token) — the piece the cloud PRICE CHECK routine can't cover.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');

const BIG_MOVE_PCT = 6;                 // flag any tracked price that moved >= this
const istDate = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// tracked series for the big-move check: [label, path-getter]
const SERIES = [
  ['USD/INR', (s) => s.fx?.usdInr],
  ['Copper LME', (s) => s.lme?.copper],
  ['Aluminium LME', (s) => s.lme?.aluminium],
  ['Zinc LME', (s) => s.lme?.zinc],
  ['Nickel LME', (s) => s.lme?.nickel],
  ['Copper China', (s) => s.china?.copper],
  ['Aluminium China', (s) => s.china?.aluminium],
  ['SS304 China', (s) => s.china?.ss_304],
  ['HRC China', (s) => s.china?.hrc],
  ['Copper Delhi scrap', (s) => s.delhiScrap?.copper],
];

// expected sources that should be present in every daily snapshot
const SOURCES = [
  ['FX', (s) => s.fx?.usdInr != null],
  ['Bullion', (s) => s.bullion?.goldInr10g != null],
  ['LME', (s) => s.lme && Object.keys(s.lme).length > 0],
  ['China (SHFE)', (s) => s.china && Object.keys(s.china).length > 0],
  ['Delhi scrap', (s) => s.delhiScrap && Object.keys(s.delhiScrap).length > 0],
];

const inr = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function main() {
  const today = istDate();
  const snap = await db().collection('costing_rate_snapshots').orderBy('date', 'desc').limit(2).get();
  const docs = snap.docs.map((d) => d.data());
  const latest = docs[0];
  const prev = docs[1];
  const alerts = [];

  // 1) grab freshness
  if (!latest) { await sendTelegram('⚠️ <b>Price health</b>: no snapshots at all in costing_rate_snapshots.'); return; }
  if (latest.date !== today) {
    alerts.push(`⚠️ <b>No price grab today</b> — latest snapshot is ${latest.date}. The daily job may have failed.`);
  }

  // 2) source presence (silent stale/missing)
  for (const [name, ok] of SOURCES) {
    if (!ok(latest)) alerts.push(`⚠️ <b>${name}</b> missing from today's grab — source may have broken.`);
  }

  // 3) big moves vs previous snapshot
  if (prev) {
    for (const [label, get] of SERIES) {
      const a = get(prev), b = get(latest);
      if (typeof a === 'number' && a > 0 && typeof b === 'number') {
        const pct = ((b - a) / a) * 100;
        if (Math.abs(pct) >= BIG_MOVE_PCT) {
          const arrow = pct > 0 ? '📈' : '📉';
          alerts.push(`${arrow} <b>${label}</b> ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%  (₹${inr(a)} → ₹${inr(b)})`);
        }
      }
    }
  }

  if (!alerts.length) { console.log(`price health OK (${today})`); return; }
  await sendTelegram(`📊 <b>Price health — ${today}</b>\n` + alerts.join('\n') + '\n\n<i>Live Rates tab · unico-costing.vercel.app</i>');
  console.log(`price health: ${alerts.length} alert(s) sent`);
}

main().catch((e) => { console.error('checkPriceHealth failed:', e.message || e); process.exit(1); });
