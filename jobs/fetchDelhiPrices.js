// Daily price grab for the costing "Live Rates" tab. Fetches everything server-side
// (so history is complete & keyed rates never touch the frontend) and writes:
//   costing_rate_snapshots/<YYYY-MM-DD>  — append-only daily history (old days kept forever)
//   costing_material_rates/_benchmark     — latest values the tab reads
// Sources: FX frankfurter.dev · bullion gold-api.com · LME metals.dev (key) · Delhi scraprates.in
// Fail-soft: any source that errors is simply omitted; a good prior value is never overwritten with null.
const fs = require('fs');
const path = require('path');
const { db, FieldValue } = require('./lib/firestore');

let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'metals.local.json'), 'utf8')); } catch { /* none */ }
const METALS_KEY = process.env.METALS_DEV_API_KEY || local.METALS_DEV_API_KEY;

const UA = 'Mozilla/5.0 (compatible; UnicoCosting/1.0)';
const OZ_G = 31.1034768;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fx() {
  const d = await getJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR,CNY');
  const usdInr = num(d?.rates?.INR), usdCny = num(d?.rates?.CNY);
  if (!usdInr || !usdCny) throw new Error('bad FX');
  return { usdInr: r2(usdInr), usdCny, cnyInr: r2(usdInr / usdCny) };
}

async function bullion(usdInr) {
  const [g, s] = await Promise.all([
    getJson('https://api.gold-api.com/price/XAU'),
    getJson('https://api.gold-api.com/price/XAG'),
  ]);
  const go = num(g?.price), si = num(s?.price);
  if (!go || !si || !usdInr) throw new Error('bad bullion');
  return { goldInr10g: r2((go * usdInr) / OZ_G * 10), silverInrKg: r2((si * usdInr) / OZ_G * 1000) };
}

async function lme() {
  if (!METALS_KEY) throw new Error('no metals.dev key');
  const j = await getJson(`https://api.metals.dev/v1/latest?api_key=${METALS_KEY}&currency=INR&unit=g`);
  if (j.status !== 'success' || !j.metals) throw new Error('bad metals.dev');
  const m = j.metals, kg = (g) => (num(m[g]) ? r2(m[g] * 1000) : null);
  const out = { copper: kg('copper'), aluminium: kg('aluminum'), zinc: kg('zinc'), nickel: kg('nickel') };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// SHFE (Shanghai Futures Exchange) via Sina Finance — free, no key. Continuous main
// contract, CNY/tonne. Field[8]=latest, field[10]=prev settlement (fallback).
// Keys map to the frontend basket. SHFE SS = 304-grade; RB rebar ≈ iron rod proxy.
const SHFE = { copper: 'CU0', aluminium: 'AL0', zinc: 'ZN0', nickel: 'NI0', ss_304: 'SS0', iron_rod_8mm: 'RB0' };
async function shfe(cnyInr) {
  if (!(cnyInr > 0)) throw new Error('no CNY/INR for SHFE conversion');
  const inr = {}, cny = {};
  for (const [key, sym] of Object.entries(SHFE)) {
    try {
      const res = await fetch(`https://hq.sinajs.cn/list=nf_${sym}`,
        { headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const m = (await res.text()).match(/="([^"]*)"/);
      if (!m) continue;
      const f = m[1].split(',');
      let ton = parseFloat(f[8]);            // latest price
      if (!(ton > 0)) ton = parseFloat(f[10]); // fallback: prev settlement
      if (ton > 0) { cny[key] = Math.round(ton); inr[key] = r2((ton * cnyInr) / 1000); }
    } catch { /* skip this metal */ }
  }
  if (!Object.keys(inr).length) throw new Error('SHFE all failed');
  return { inr, cny };
}

// scraprates.in/delhi — rate cards: "<Metal> Rate Today ... ₹</span><number>"
async function scrapDelhi() {
  const html = await getText('https://scraprates.in/delhi');
  const rx = /([A-Za-z]+) Rate Today<\/span>[\s\S]{0,200}?₹<\/span>([0-9.]+)/g;
  const raw = {}; let m;
  while ((m = rx.exec(html))) raw[m[1].toLowerCase()] = r2(parseFloat(m[2]));
  const out = {
    copper: num(raw.copper), aluminium: num(raw.aluminum),
    brass: num(raw.brass), iron_scrap: num(raw.iron),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  if (!Object.keys(out).length) throw new Error('scraprates parse empty');
  return out;
}

async function main() {
  const istDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const results = await Promise.allSettled([fx(), lme(), scrapDelhi()]);
  const fxV = results[0].status === 'fulfilled' ? results[0].value : null;
  const lmeV = results[1].status === 'fulfilled' ? results[1].value : null;
  const scrapV = results[2].status === 'fulfilled' ? results[2].value : null;
  // FX-dependent sources (bullion needs USD/INR; SHFE needs CNY/INR)
  let bullionV = null, shfeV = null;
  if (fxV) {
    try { bullionV = await bullion(fxV.usdInr); } catch { /* omit */ }
    try { shfeV = await shfe(fxV.cnyInr); } catch { /* omit */ }
  }

  const failed = results.map((r, i) => (r.status === 'rejected' ? ['fx', 'lme', 'scraprates'][i] : null)).filter(Boolean);
  if (!fxV && !lmeV && !scrapV) throw new Error('all sources failed: ' + failed.join(','));

  // 1) append-only daily snapshot (history — old days kept forever)
  const snap = { date: istDate, updatedAt: FieldValue.serverTimestamp() };
  if (fxV) snap.fx = fxV;
  if (bullionV) snap.bullion = bullionV;
  if (lmeV) snap.lme = lmeV;
  if (scrapV) snap.delhiScrap = scrapV;
  if (shfeV) { snap.china = shfeV.inr; snap.chinaCny = shfeV.cny; }
  await db().collection('costing_rate_snapshots').doc(istDate).set(snap, { merge: true });

  // 2) latest doc the tab reads (only overwrite the parts we actually got)
  const latest = { key: '_benchmark', asOf: istDate, unit: '₹/kg', updatedAt: FieldValue.serverTimestamp() };
  if (lmeV) latest.metals = lmeV;               // World (LME) column
  if (scrapV) latest.delhiScrap = scrapV;       // Delhi (ScrapRates) column
  if (shfeV) { latest.china = shfeV.inr; latest.chinaCny = shfeV.cny; } // China (SHFE) column
  latest.source = 'metals.dev (LME) + scraprates.in (Delhi) + SHFE/Sina (China)';
  await db().collection('costing_material_rates').doc('_benchmark').set(latest, { merge: true });

  console.log(`prices ${istDate} written. lme:${lmeV ? Object.keys(lmeV).length : 0} scrap:${scrapV ? Object.keys(scrapV).length : 0} china:${shfeV ? Object.keys(shfeV.inr).length : 0} fx:${!!fxV} bullion:${!!bullionV}` + (failed.length ? ` | FAILED: ${failed.join(',')}` : ''));
}

main().catch((e) => { console.error('fetchDelhiPrices failed:', e.message || e); process.exit(1); });
