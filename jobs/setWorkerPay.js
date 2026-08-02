// Set a worker's PAY TYPE and RATE — the one field pair that decides what they earn.
//
//   CODE=00000051 TYPE=daily   WAGE=700   node jobs/setWorkerPay.js            # rehearse (default)
//   CODE=00000051 TYPE=daily   WAGE=700   DRY=false node jobs/setWorkerPay.js  # write it
//   CODE=00000xxx TYPE=monthly AMOUNT=20000 DRY=false node jobs/setWorkerPay.js
//
// WHY THIS EXISTS: Ravi ahmed (00000051) was clocking in daily on the LOD shift and had been given a
// Rs 3,500 cash advance, but his record carried only name/dept/shift — no `type`, no `wage`. The
// engine therefore paid him Rs 0.00 base and showed him owing the whole advance. Nothing warned
// anybody: an unset wage is indistinguishable from a worker who earned nothing.
//
// GUARDS — it refuses to:
//   · touch a worker who does not exist
//   · change pay when ANY month is locked/paid (that month's payment is frozen around the old rate)
//   · overwrite a rate that is already set, unless FORCE=true (prevents a silent re-rate)
//   · accept a non-numeric / zero / absurd rate
// It always reads the record back and re-computes the current month's pay so the effect is visible.
const { db } = require('./lib/firestore');

const CODE = (process.env.CODE || '').trim();
const TYPE = (process.env.TYPE || '').trim().toLowerCase();
const DRY = process.env.DRY !== 'false';
const FORCE = process.env.FORCE === 'true';
const RAW = TYPE === 'daily' ? process.env.WAGE : process.env.AMOUNT;

const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (!CODE) die('set CODE=<employee code>');
if (TYPE !== 'daily' && TYPE !== 'monthly') die('set TYPE=daily or TYPE=monthly');
const rate = Number(RAW);
if (!Number.isFinite(rate) || rate <= 0) die(`set ${TYPE === 'daily' ? 'WAGE' : 'AMOUNT'}=<number greater than 0> (got "${RAW}")`);
// Sanity ceilings — a slipped digit here is a payroll incident, not a typo.
if (TYPE === 'daily' && rate > 10000) die(`WAGE ${rate} looks wrong for a daily rate. Re-check.`);
if (TYPE === 'monthly' && rate > 500000) die(`AMOUNT ${rate} looks wrong for a monthly salary. Re-check.`);

(async () => {
  const ref = db().collection('att_salary').doc(CODE);
  const snap = await ref.get();
  if (!snap.exists) die(`no worker ${CODE} in att_salary`);
  const e = snap.data() || {};

  console.log(`${e.name || CODE}  (${e.dept || 'no dept'}, shift ${e.shift || 'none'})`);
  console.log(`  BEFORE: type=${e.type ?? '(unset)'}  wage=${e.wage ?? '(unset)'}  amount=${e.amount ?? '(unset)'}`);

  const locked = Object.entries(e.months || {}).filter(([, m]) => m && (m.locked || m.payment)).map(([k]) => k);
  if (locked.length) die(`REFUSING — month(s) already paid & locked: ${locked.join(', ')}. Their payment is frozen around the OLD rate; changing it now would make a settled month unexplainable. Unlock first if this is deliberate.`);

  const cur = e.type === 'daily' ? e.wage : e.amount;
  if (e.type && Number(cur) > 0 && !FORCE)
    die(`REFUSING — ${CODE} already has ${e.type} rate ${cur}. This would silently re-rate them. Re-run with FORCE=true if that is intended.`);

  const patch = TYPE === 'daily' ? { type: 'daily', wage: rate } : { type: 'monthly', amount: rate };
  console.log(`  AFTER : type=${patch.type}  ${TYPE === 'daily' ? 'wage' : 'amount'}=${rate}`);

  const advTotal = (e.advances || []).reduce((s, a) => s + Number(a.amount || 0), 0);
  if (advTotal) console.log(`  note  : Rs ${advTotal.toLocaleString('en-IN')} of advances already recorded against this worker`);

  if (DRY) { console.log('\nDRY RUN — nothing written. Re-run with DRY=false to apply.'); process.exit(0); }

  await ref.set(patch, { merge: true });          // additive: touches only these two fields

  const back = (await ref.get()).data() || {};
  const okType = back.type === patch.type;
  const okRate = Number(TYPE === 'daily' ? back.wage : back.amount) === rate;
  if (!okType || !okRate) { console.error(`\n🚨 READ-BACK MISMATCH — type=${back.type} wage=${back.wage} amount=${back.amount}. Check by hand.`); process.exit(3); }
  console.log('\n  ✅ written and read back: type=' + back.type + '  rate=' + (TYPE === 'daily' ? back.wage : back.amount));

  // Show what this actually means for the current month.
  const mk = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  const attDoc = await db().collection('att_attendance').doc(CODE).get();
  const a = attDoc.exists ? attDoc.data() : null;
  if (!a) { console.log('  (no attendance doc yet — nothing to compute)'); process.exit(0); }
  const { computePay } = require('./salaryCalc');
  const [y, m] = mk.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const advThis = (back.advances || []).filter((x) => String(x.date || '').startsWith(mk)).reduce((s, x) => s + Number(x.amount || 0), 0);
  const p = computePay({
    emp: back, att: a, daysInMonth: dim, elapsedDays: dim, fullMonth: true,
    monthStart: new Date(y, m - 1, 1), toDate: new Date(y, m - 1, dim),
    advancesThisMonth: advThis, openingBalance: Number(((back.months || {})[mk] || {}).openingBalance || 0),
  });
  console.log(`\n  ${mk}: present ${p.presentDays}  hours ${a.workHrs ?? '-'}  ->  base Rs ${p.base.toFixed(2)}  advances Rs ${advThis}  NET Rs ${p.net.toFixed(2)}  PAYABLE Rs ${p.payable.toFixed(2)}`);
  process.exit(0);
})().catch((err) => { console.error('ERR', err.message); process.exit(2); });
