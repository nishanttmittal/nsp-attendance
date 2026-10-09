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
//   • a welder paid on the Karigar / thekedar tile (kind 'other', head 'Contractor') → the same Welder inbox (09-10-2026)
//   • no clear match (name not in the Attendance list, or two workers match) → flagged on the line; the owner's manual
//                         "Attendance mein daal diya" stays the fallback. Tech channel gets one line per flagged advance.
// Never writes money in Falcon (advStatus / advPush are flags only). Idempotent: a line is pushed once (advPush set).
//   node jobs/falconAdvanceBridge.js --dry   → shows what it would do
const { db } = require('./lib/firestore');
const { handle } = require('./worker');
const { sendTech } = require('./lib/notify');

const WELD = /weld|वेल्ड/i;
const CONTRACTOR_FROM = '2026-10-08'; // Karigar / thekedar lines are bridged from the day the tile went live, never older ones
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
  const [adv, con, rosterSnap, weldSnap, users] = await Promise.all([
    base.collection('entries').where('kind', '==', 'adv').where('advStatus', '==', 'pending').get(),
    base.collection('entries').where('head', '==', 'Contractor').get(),
    base.collection('roster').get(),
    f.collection('apps').doc('welder').collection('welders').get(),
    base.collection('users').get(),
  ]);
  const roster = rosterSnap.docs.map(d => d.data());
  const welders = weldSnap.docs.map(d => d.data().name).filter(Boolean);
  const nameOf = Object.fromEntries(users.docs.map(d => [d.id, d.data().name || d.id]));
  // Khud ka advance (owner 09-10-2026 "build b"): a worker's advance to HIMSELF reaches Attendance only on the OWNER's OK.
  // The Falcon rules already enforce this for a name picked from the list; this is the backstop for a name typed by hand.
  const selfCodeOf = Object.fromEntries(users.docs.map(d => [d.id, d.data().selfCode || '']));
  const roleOfUser = Object.fromEntries(users.docs.map(d => [d.id, d.data().active === true ? d.data().role : '']));
  // (owner 09-10-2026 23:24: Anshul ji may pass it too — the OK must come from staff, never from the worker himself)
  const isOwner = (email) => email === 'nspenterprises24@gmail.com' || ['owner', 'incharge'].includes(roleOfUser[email]);
  const out = { pushed: 0, queuedWelder: 0, accepted: 0, flagged: 0, waiting: 0, rejected: 0 };
  const now = new Date().toISOString();
  // (c) Karigar / thekedar tile (owner 09-10-2026: "yes welder tile"). Anshul ji writes a payment to a welder on that tile,
  // not on the Advance tile (e.g. "Naveen weld 1000", 08-10) — it must reach the Welder app's Incoming Advances too. Only a
  // name that clearly is a welder goes; any other contractor line is left alone, silently. Same inbox, owner Accepts there.
  // The Falcon line only gets the advPush flag (no money, no kind change).
  for (const d of con.docs) {
    const e = d.data();
    if (e.kind !== 'other' || e.status !== 'active' || e.hisab != null || e.date < CONTRACTOR_FROM) continue;
    const push = e.advPush || null;
    if (push && push.target === 'welder' && push.ref) {
      if (push.status !== 'queued') continue;                         // accepted / dismissed already recorded
      const o = await f.collection('hisab_advance_outbox').doc(push.ref).get();
      const st = o.exists ? o.data().status : 'missing';
      if (st === 'accepted' && !dry) { await d.ref.update({ 'advPush.status': 'accepted', 'advPush.doneAt': now }); out.accepted++; }
      else if (st === 'dismissed' && !dry) { await d.ref.update({ 'advPush.status': 'dismissed', 'advPush.error': 'Welder app mein dismiss kiya' }); out.flagged++; }
      else out.waiting++;
      continue;
    }
    if (push) continue;
    if (e.approval !== 'ok') { out.waiting++; continue; }
    const t = resolveTarget({ name: e.detail, code: '' }, roster, welders);
    const exactWelder = welders.find(w => norm(w) === norm(e.detail));
    const welder = t.target === 'welder' ? t.name : exactWelder || '';
    if (!welder) continue;                                           // some other contractor — nothing to post
    const who = nameOf[e.by] || e.by;
    if (dry) { console.log(`[dry] Karigar tile ₹${e.amount} ${e.detail} (${who}, ${e.date}) → welder ${welder}`); continue; }
    const cur = (await d.ref.get()).data();                          // read again just before acting (same guard as below)
    if (!cur || cur.status !== 'active' || cur.hisab != null || cur.approval !== 'ok' || cur.advPush || cur.amount !== e.amount || cur.date !== e.date || cur.detail !== e.detail) { out.waiting++; continue; }
    const prior = await f.collection('hisab_advance_outbox').where('falconId', '==', e.id).limit(1).get();
    const ref = prior.empty ? await f.collection('hisab_advance_outbox').add({ target: 'welder', name: welder, code: '', amount: Number(e.amount), date: e.date, note: `Falcon (${who}): ${e.detail || ''}`.trim(), status: 'pending', source: 'falcon', falconId: e.id, createdAt: now }) : prior.docs[0].ref;
    await d.ref.update({ advPush: { target: 'welder', name: welder, ref: ref.id, status: 'queued', at: now } });
    out.queuedWelder++;
  }
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
    if (t.target === 'attendance' && selfCodeOf[e.by] && t.code === selfCodeOf[e.by] && roleOfUser[e.by] === 'spender' && !isOwner(e.approvedBy || '')) {
      if (!dry && !e.advPush) {
        await d.ref.update({ advPush: { target: 'attendance', code: t.code, name: t.name, status: 'self-needs-owner', error: 'Khud ka advance — Nishant ji / Anshul ji pass karenge', at: now } });
        await sendTech(`Falcon: ₹${e.amount} ${esc(e.advFor?.name || e.detail)} (${esc(who)}, ${e.date}) — khud ka advance, staff ke OK ke bina Attendance mein nahi gaya`).catch((x) => console.error('tech alert failed:', x.message));
      }
      out.flagged++; continue;
    }
    const label = `₹${e.amount} ${e.advFor?.name || e.detail} (${who}, ${e.date})`;
    if (dry) { console.log(`[dry] ${label} → ${t.target}${t.code ? ' ' + t.code : ''}${t.name ? ' ' + t.name : ''}${t.why ? ' — ' + t.why : ''}`); continue; }
    // The list above was read a moment ago. Read THIS line again just before acting on it: if it was cancelled, edited,
    // closed or already handled in between, leave it for the next cycle — never push a line that has since changed
    // (review 09-10-2026: a cancel landing between the read and the push would leave the deduction without its line).
    const cur = (await d.ref.get()).data();
    if (!cur || cur.status !== 'active' || cur.hisab != null || cur.approval !== 'ok' || cur.advPush
      || cur.amount !== e.amount || cur.date !== e.date || (cur.advFor?.name || '') !== (e.advFor?.name || '')) { out.waiting++; continue; }
    if (t.target === 'attendance') {
      // already typed into Attendance by hand (same worker, same day, same amount)? then only mark the Falcon line — no second advance
      const existing = ((await f.collection('att_salary').doc(t.code).get()).data() || {}).advances || [];
      const advId = `adv-${e.date}-falcon-${e.id}`;
      // our own earlier push (a run that died after the Attendance write, before marking the Falcon line — 09-10-2026,
      // Telegram unreachable from the factory network) is NOT a "possible duplicate": it is this very advance
      const mine = existing.some(a => a.id === advId);
      const dup = !mine && existing.find(a => String(a.date).slice(0, 10) === e.date && Number(a.amount) === Number(e.amount));
      if (dup) {
        // a same-day same-amount advance could be the same money typed by hand — or a real second advance. Never decide
        // money on a guess: push nothing, mark the line for the owner (security review 08-10: no fail-open dedupe)
        await d.ref.update({ advPush: { target: 'attendance', code: t.code, name: t.name, status: 'possible-duplicate', error: `Attendance mein ${e.date} ko ₹${e.amount} pehle se hai — wahi hai to "Attendance mein daal diya" dabao, alag hai to khud daalo`, at: now } });
        await sendTech(`Falcon advance ${esc(label)}: Attendance mein same din same amount pehle se hai — owner check kare`).catch((x) => console.error('tech alert failed:', x.message));
        out.flagged++; continue;
      }
      const advance = { id: advId, date: e.date, mode: 'cash', amount: Number(e.amount), remark: `Falcon: ${e.detail || ''}`.trim(), paidBy: e.by };
      let result;
      if (mine) result = 'advance already recorded by an earlier run';
      else {
        try { result = await handle('add_advance', { code: t.code, advance, _by: e.by }); }
        catch (x) {
          // the handler writes the advance first and alerts after; an alert failure must not leave the line unmarked.
          // Trust only what is really in Attendance now.
          const after = ((await f.collection('att_salary').doc(t.code).get()).data() || {}).advances || [];
          if (!after.some(a => a.id === advId)) throw x;
          console.error('add_advance alert failed after the write (advance is recorded):', label, x.message);
          result = 'advance added (alert failed)';
        }
      }
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
