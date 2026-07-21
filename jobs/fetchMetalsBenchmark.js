// Daily world-metal benchmark (LME prices in INR) for the costing app's Live Rates tab.
// Fetches metals.dev once, writes costing_material_rates/_benchmark. Free-tier safe (~1 call/day).
// Key: env METALS_DEV_API_KEY, else jobs/metals.local.json (git-ignored, mode 600).
const fs = require('fs');
const path = require('path');
const { db, FieldValue } = require('./lib/firestore');

let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'metals.local.json'), 'utf8')); } catch { /* none */ }
const KEY = process.env.METALS_DEV_API_KEY || local.METALS_DEV_API_KEY;

async function main() {
  if (!KEY) throw new Error('METALS_DEV_API_KEY missing (env or jobs/metals.local.json)');
  const url = `https://api.metals.dev/v1/latest?api_key=${KEY}&currency=INR&unit=g`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`metals.dev HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 'success' || !j.metals) throw new Error(`metals.dev bad payload: ${j.status || 'no status'}`);

  const m = j.metals;
  const perKg = (g) => (typeof g === 'number' && isFinite(g) ? Math.round(g * 1000 * 100) / 100 : null);
  // Only the basket metals that have a world price. Keys match the frontend basket keys.
  const metals = { copper: perKg(m.copper), aluminium: perKg(m.aluminum), zinc: perKg(m.zinc), nickel: perKg(m.nickel) };
  // Drop nulls so a missing metal never overwrites a good prior value.
  for (const k of Object.keys(metals)) if (metals[k] == null) delete metals[k];
  if (Object.keys(metals).length === 0) throw new Error('no usable base-metal prices returned');

  await db().collection('costing_material_rates').doc('_benchmark').set({
    key: '_benchmark',
    metals,
    unit: '₹/kg',
    source: 'metals.dev (LME world price, INR)',
    asOf: String(j.timestamp || j.date || ''),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log('metals benchmark written:', JSON.stringify(metals));
}

main().catch((e) => { console.error('fetchMetalsBenchmark failed:', e.message || e); process.exit(1); });
