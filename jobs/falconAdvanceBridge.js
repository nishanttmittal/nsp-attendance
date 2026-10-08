// FALCON → ATTENDANCE / WELDER advance bridge (owner 08-10-2026 23:09: "the advances he is writing in this app are
// not pushed to the attendance app or the welder app").
//
// Every Queue-worker cycle (≈15 min) this takes each Falcon advance line that is active, OK'd (worker lines wait for
// the owner / Anshul ji's OK; staff lines are OK at save) and not yet pushed, and:
//   • a factory worker  → applies it to att_salary through the SAME handler the Attendance app uses
//                         (worker.js 'add_advance': locked-month guards, dedupe by id, Telegram alert) → Falcon line
//                         becomes "Attendance mein ✓ (auto)".
//   • a welder contractor (name says weld / वेल्ड) → hisab_advance_outbox, the inbox the Welder app already has
//                         (owner taps Accept there) → Falcon line becomes entered once accepted.
//   • no clear match (name not in the Attendance list, or two workers match) → flagged on the line; the owner's manual
//                         "Attendance mein daal diya" stays the fallback. Tech channel gets one line per flagged advance.
// Never writes money in Falcon (advStatus / advPush are flags only). Idempotent: a line is pushed once (advPush set).
//   node jobs/falconAdvanceBridge.js --dry   → shows what it would do
const { db } = require('./lib/firestore');
const { handle } = require('./worker');
const { sendTech } = require('./lib/notify');

const WELD = /weld|वेल्ड/i;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // names are phone-typed → never raw in Telegram HTML

/** Pure: pick the target for one advance name. roster = [{code,name,active}], welders = ['Naveen','Jitender',…]. */
function resolveTarget(advFor, roster, welders) {
  const name = norm(advFor?.name), code = String(advFor?.code || '');
  // the code comes from a phone, so it is honoured only when it still names the same worker (a renamed or tampered line
  // falls back to name matching) — security review 08-10
  const byCode = code ? roster.find(r => r.code === code && r.active !== false) : null;
  if (byCode && norm(byCode.name) === name) return { target: 'attendance', code, name: byCode.name };
  if (!name) return { target: 'none', why: 'naam khali' };
  if (WELD.test(name)) {
    const w = welders.find(w => name.includes(norm(w))) || welders.find(w => name.startsWith(norm(w).slice(0, 3)));
    // Hindi names: जितेंद्र / नवीन map on the first letters of the Latin name only if the owner keeps the welder list to these two
    const hindi = /जितेंद्र|जितेन्द्र/.test(name) ? 'Jitender' : /नवीन|नविन/.test(name) ? 'Naveen' : '';
    const pick = w || (hindi && welders.includes(hindi) ? hindi : '');
    return pick ? { target: 'welder', name: pick } : { target: 'none', why: 'welder ka naam nahi pehchana' };
  }
  const active = roster.filter(r => r.active !== false);
  const exact = active.filter(r => norm(r.name) === name);
  if (exact.length === 1) return { target: 'attendance', code: exact[0].code, name: exact[0].name };
  const prefix = active.filter(r => norm(r.name).startsWith(name + ' '));
  if (exact.length === 0 && prefix.length === 1) return { target: 'attendance', code: prefix[0].code, name: prefix[0].name };
  if (exact.length + prefix.length > 1) return { target: 'none', why: `ek se zyada worker: ${[...exact, ...prefix].map(r => r.name).join(' / ')}` };
  return { target: 'none', why: 'Attendance list mein yeh naam nahi' };
}

async function run({ dry = false } = {}) {
  const f = db();
  const base = f.collection('apps').doc('falcon');
  const [adv, rosterSnap, weldSnap, users] = await Promise.all([
    base.collection('entries').where('kind', '==', 'adv').where('advStatus', '==', 'pending').get(),
    base.collection('roster').get(),
    f.collection('apps').doc('welder').collection('welders').get(),
    base.collection('users').get(),
  ]);
  const roster = rosterSnap.docs.map(d => d.data());
  const welders = weldSnap.docs.map(d => d.data().name).filter(Boolean);
  const nameOf = Object.fromEntries(users.docs.map(d => [d.id, d.data().name || d.id]));
  const out = { pushed: 0, queuedWelder: 0, accepted: 0, flagged: 0, waiting: 0, rejected: 0 };
  const now = new Date().toISOString();
  for (const d of adv.docs) {
    const e = d.data();
    if (e.status !== 'active' || e.hisab != null) continue;          // only live, open lines
    const push = e.advPush || null;
    // (b) a welder line already queued: has the Welder app accepted / dismissed it?
    if (push && push.target === 'welder' && push.ref) {
      const o = await f.collection('hisab_advance_outbox').doc(push.ref).get();
      const st = o.exists ? o.data().status : 'missing';
      if (st === 'accepted' && !dry) { await d.ref.update({ advStatus: 'entered', advDoneBy: 'welder-app', advDoneAt: new Date(), 'advPush.status': 'accepted', 'advPush.doneAt': now }); out.accepted++; }
      else if (st === 'dismissed' && push.status !== 'dismissed' && !dry) { await d.ref.update({ 'advPush.status': 'dismissed', 'advPush.error': 'Welder app mein dismiss kiya' }); out.flagged++; }
      else out.waiting++;
      continue;
    }
    if (push) { out.waiting++; continue; }                       // flagged / rejected earlier — the owner handles it by hand
    if (e.approval !== 'ok') { out.waiting++; continue; }         // a worker's line waits for the OK
    const who = nameOf[e.by] || e.by;
    const t = resolveTarget(e.advFor, roster, welders);
    const label = `₹${e.amount} ${e.advFor?.name || e.detail} (${who}, ${e.date})`;
    if (dry) { console.log(`[dry] ${label} → ${t.target}${t.code ? ' ' + t.code : ''}${t.name ? ' ' + t.name : ''}${t.why ? ' — ' + t.why : ''}`); continue; }
    if (t.target === 'attendance') {
      // already typed into Attendance by hand (same worker, same day, same amount)? then only mark the Falcon line — no second advance
      const existing = ((await f.collection('att_salary').doc(t.code).get()).data() || {}).advances || [];
      const dup = existing.find(a => String(a.date).slice(0, 10) === e.date && Number(a.amount) === Number(e.amount));
      if (dup) {
        // a same-day same-amount advance could be the same money typed by hand — or a real second advance. Never decide
        // money on a guess: push nothing, mark the line for the owner (security review 08-10: no fail-open dedupe)
        await d.ref.update({ advPush: { target: 'attendance', code: t.code, name: t.name, status: 'possible-duplicate', error: `Attendance mein ${e.date} ko ₹${e.amount} pehle se hai — wahi hai to "Attendance mein daal diya" dabao, alag hai to khud daalo`, at: now } });
        await sendTech(`Falcon advance ${esc(label)}: Attendance mein same din same amount pehle se hai — owner check kare`).catch((x) => console.error('tech alert failed:', x.message));
        out.flagged++; continue;
      }
      const advance = { id: `adv-${e.date}-falcon-${e.id}`, date: e.date, mode: 'cash', amount: Number(e.amount), remark: `Falcon: ${e.detail || ''}`.trim(), paidBy: e.by };
      const result = await handle('add_advance', { code: t.code, advance, _by: e.by });
      if (/^REJECTED/.test(result)) {
        // the handler's reason names salary-lock state → keep it in the log / tech channel, not on the worker's phone
        console.log('add_advance rejected:', label, result);
        await sendTech(`Falcon advance ${esc(label)} Attendance ne nahi liya: ${esc(result)}`).catch((x) => console.error('tech alert failed:', x.message));
        await d.ref.update({ advPush: { target: 'attendance', code: t.code, name: t.name, status: 'rejected', error: 'Attendance ne nahi liya — owner dekhe', at: now } });
        out.rejected++;
      } else {
        await d.ref.update({ advStatus: 'entered', advDoneBy: 'auto:attendance', advDoneAt: new Date(), advPush: { target: 'attendance', code: t.code, name: t.name, status: 'done', at: now } });
        out.pushed++;
      }
    } else if (t.target === 'welder') {
      // idempotent: a crash after the add and before the Falcon update must not queue it twice
      const prior = await f.collection('hisab_advance_outbox').where('falconId', '==', e.id).limit(1).get();
      const ref = prior.empty ? await f.collection('hisab_advance_outbox').add({ target: 'welder', name: t.name, code: '', amount: Number(e.amount), date: e.date, note: `Falcon (${who}): ${e.detail || ''}`.trim(), status: 'pending', source: 'falcon', falconId: e.id, createdAt: now }) : prior.docs[0].ref;
      await d.ref.update({ advPush: { target: 'welder', name: t.name, ref: ref.id, status: 'queued', at: now } });
      out.queuedWelder++;
    } else {
      await d.ref.update({ advPush: { target: 'none', status: 'unmatched', error: t.why, at: now } });
      await sendTech(`Falcon advance ${esc(label)} Attendance mein nahi gaya — ${esc(t.why)}. Owner Falcon mein "Attendance mein daal diya" dabaye ya naam theek kare.`).catch((x) => console.error('tech alert failed:', x.message));
      out.flagged++;
    }
  }
  console.log('falcon advance bridge:', JSON.stringify(out));
  return out;
}

module.exports = { run, resolveTarget };
if (require.main === module) run({ dry: process.argv.includes('--dry') }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
