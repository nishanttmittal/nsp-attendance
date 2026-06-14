// One-off local drainer for att_job_requests (used when the GitHub worker is stuck). Reuses
// worker.handle(). ONLY_TYPE=manual_punch|resign_employee|... to restrict; default = all.
// Marks each running→done/error like the real worker; concurrent GitHub worker will skip
// anything already 'running'/'done'.
const { handle } = require('./worker');
const { db } = require('./lib/firestore');

const ONLY = process.env.ONLY_TYPE || '';
const LIMIT = parseInt(process.env.MAX || '200', 10);

(async () => {
  let done = 0, err = 0;
  while (done + err < LIMIT) {
    let q = db().collection('att_job_requests').where('status', '==', 'pending');
    const snap = await q.limit(20).get();
    if (snap.empty) break;
    let any = false;
    for (const doc of snap.docs) {
      const { type, payload, requestedBy } = doc.data();
      if (ONLY && type !== ONLY) continue;
      any = true;
      await doc.ref.update({ status: 'running', startedAt: new Date().toISOString() });
      try {
        const r = await handle(type, { ...(payload || {}), _by: requestedBy || '' });
        await doc.ref.update({ status: 'done', result: r, finishedAt: new Date().toISOString() });
        done++; console.log(`[done ${done}] ${type} ${JSON.stringify(payload)} → ${r}`);
      } catch (e) {
        const msg = String(e.message || e).split('\n')[0];
        await doc.ref.update({ status: 'error', error: msg.slice(0, 500), finishedAt: new Date().toISOString() });
        err++; console.log(`[error] ${type} ${JSON.stringify(payload)} → ${msg}`);
      }
    }
    if (!any) break; // only non-matching types left
  }
  console.log(`\nDRAIN COMPLETE: ${done} done, ${err} error`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
