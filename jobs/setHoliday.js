// Add / remove a CLOSED-factory holiday in the app's holiday list (att_meta/holidays.dates{ymd:name}).
// Owner rule 2026-09-10: a holiday must count as HOLIDAY in the app, never as absent.
//   DATE=2026-08-28 NAME="Raksha Bandhan" [REMOVE=true] DRY=true|false   node setHoliday.js
//   LIST=true node setHoliday.js        → print the current list
const { db } = require('./lib/firestore');
const { DATE, NAME } = process.env; const DRY = process.env.DRY !== 'false'; const REMOVE = process.env.REMOVE === 'true';
(async () => {
  const ref = db().collection('att_meta').doc('holidays');
  const cur = ((await ref.get()).data() || {}).dates || {};
  console.log('current:', JSON.stringify(cur));
  if (process.env.LIST === 'true') return process.exit(0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || '')) throw new Error('DATE=YYYY-MM-DD required');
  if (!REMOVE && !NAME) throw new Error('NAME required');
  const next = { ...cur }; if (REMOVE) delete next[DATE]; else next[DATE] = NAME;
  console.log('next   :', JSON.stringify(next));
  if (DRY) { console.log('DRY — not written'); return process.exit(0); }
  await ref.set({ dates: next, updatedAt: new Date().toISOString(), updatedBy: 'jobs/setHoliday.js' }, { merge: true });
  console.log('written, read back:', JSON.stringify(((await ref.get()).data() || {}).dates));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
