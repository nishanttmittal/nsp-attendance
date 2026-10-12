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
const { FieldValue } = require('firebase-admin/firestore');
const { sendTech } = require('./lib/notify').channel('advance');

const WELD = /weld|वेल्ड/i;
const CONTRACTOR_FROM = '2026-10-08'; // Karigar / thekedar lines are bridged from the day the tile went live, never older ones
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // names are phone-typed → never raw in Telegram HTML

/** Pure: pick the target for one advance name. roster = [{code,name,active}], welders = ['Naveen','Jitender',…]. */
function resolveTarget(advFor, roster, welders) {
  const name = norm(advFor?.name), code = String(advFor?.code || '');
  // the code comes from a phone, so it is honoured only when it still names the same worker (a renamed or tampered line
  // falls back to name matching) — security review 08-10
  // A welding contractor's own man (Attendance dept WELDING, name carries the contractor: "pradeep welder naveen"):
  // owner 13-10-2026 "IF AMOUNT IS PAID TO WELDER STAFF IT LANDS TO WELDER APP WITH THEIR NAME AS ADVANCE" → it is cut
  // from the CONTRACTOR's account in the Welder app (the man's name rides in the note), never from an Attendance salary.
  const staffOf = (r) => {
    if (String(r.dept || '').toUpperCase() !== 'WELDING') return null;
    const boss = welders.filter(w => norm(r.name).split(' ').includes(norm(w)));
    if (!boss.length) return null;   // a welder with no contractor in his name (rakesh singh welder …) is the factory's own man → Attendance
    return boss.length === 1 ? { target: 'welder', name: boss[0], staff: r.name } : { target: 'none', why: `${r.name}: do thekedar ke naam hain — owner dekhe` };
  };
  const byCode = code ? roster.find(r => r.code === code && r.active !== false) : null;
  // a welding contractor picked from the list (roster row written by falconRoster.js with `welder`) → his Welder-app
  // account, never Attendance (owner 13-10-2026 "add welder names")
  if (byCode && byCode.welder) return norm(byCode.name) === name && welders.includes(byCode.welder) ? { target: 'welder', name: byCode.welder } : { target: 'none', why: 'welder ka naam list se dobara chuno' };
  if (byCode && norm(byCode.name) === name) return staffOf(byCode) || { target: 'attendance', code, name: byCode.name };
  if (!name) return { target: 'none', why: 'naam khali' };
  // "Naveen" / "Jitender ji" typed by hand: the contractor, or the factory worker of the same first name? Money is
  // never sent on a guess (before 13-10-2026 a bare "Naveen" matched "naveen press" and went to his salary) — the line
  // is held and the owner is told; the pick list has both, each unmistakable.
  const bare = name.replace(/\b(ji|bhai|sir)\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ')[0];
  const sameAsWelder = welders.find(w => norm(w) === bare);
  if (sameAsWelder && !WELD.test(name)) return { target: 'none', why: `${sameAsWelder} welder (thekedar) ya factory ka ${sameAsWelder}? Naam list se chuno` };
  if (WELD.test(name)) {
    const w = welders.find(w => name.includes(norm(w))) || welders.find(w => name.startsWith(norm(w).slice(0, 3)));
    // Hindi names: जितेंद्र / नवीन map on the first letters of the Latin name only if the owner keeps the welder list to these two
    const hindi = /जितेंद्र|जितेन्द्र/.test(name) ? 'Jitender' : /नवीन|नविन/.test(name) ? 'Naveen' : '';
    const pick = w || (hindi && welders.includes(hindi) ? hindi : '');
    return pick ? { target: 'welder', name: pick } : { target: 'none', why: 'welder ka naam nahi pehchana' };
  }
  const active = roster.filter(r => r.active !== false && !r.welder);
  const exact = active.filter(r => norm(r.name) === name);
  if (exact.length === 1) return staffOf(exact[0]) || { target: 'attendance', code: exact[0].code, name: exact[0].name };
  const prefix = active.filter(r => norm(r.name).startsWith(name + ' '));
  if (exact.length === 0 && prefix.length === 1) return staffOf(prefix[0]) || { target: 'attendance', code: prefix[0].code, name: prefix[0].name };
  if (exact.length + prefix.length > 1) return { target: 'none', why: `ek se zyada worker: ${[...exact, ...prefix].map(r => r.name).join(' / ')}` };
  return { target: 'none', why: 'Attendance list mein yeh naam nahi' };
}

/** Atomically CLAIM one passed line before any money is posted for it (Codex review 11-10-2026: a plain re-read left a
 *  gap — a cancel / edit landing between the read and the post). The transaction re-checks the line and writes
 *  advPush.status 'posting'; the Falcon rules lock a 'posting' line against cancel and edit, exactly like a queued one.
 *  A line already 'posting' (an earlier run died mid-way) may be claimed again: every step after this is idempotent.
 *  same(cur) → is the line still what we read? Returns true when the claim is ours. */
async function claim(f, ref, target, same) {
  return f.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== 'active' || cur.hisab != null || cur.approval !== 'ok' || !same(cur)) return false;
    // the owner pressed "Attendance mein daal diya" after this run read the list → it is done by hand, post nothing
    // (Codex final review 12-10-2026: the claim did not look at advStatus)
    if (cur.kind === 'adv' && cur.advStatus !== 'pending') return false;
    const p = cur.advPush;
    if (p && p.status !== 'posting') return false;
    // resuming an earlier claim: it must be the SAME claim — same target, same worker, same money, same date. If the
    // line was changed after that claim (possible only while a phone still runs rules without the 'posting' lock),
    // nothing is posted; the line is parked for the owner (security check 12-10-2026: no posting on a drifted line).
    if (p && (p.target !== target.target || (p.code || '') !== (target.code || '') || (p.name || '') !== (target.name || '')
      || Number(p.amount) !== Number(cur.amount) || p.date !== cur.date)) {
      tx.update(ref, { advPush: { ...p, status: 'mismatch', error: 'Line badal gayi jab advance ja raha tha — owner dekhe' } });
      return false;
    }
    if (!p) tx.update(ref, { advPush: { ...target, amount: Number(cur.amount), date: cur.date, status: 'posting', at: new Date().toISOString() } });
    return true;
  });
}

/** One inbox doc per Falcon line, whatever happens: fixed id (two runs at once cannot both add one — Codex 11-10-2026),
 *  after first looking for a doc queued by an older build under a random id. Returns the doc id. */
async function queueWelder(f, e, welder, who, staff = '') {
  const col = f.collection('hisab_advance_outbox');
  const prior = await col.where('falconId', '==', e.id).limit(1).get();
  if (!prior.empty) return prior.docs[0].id;
  const id = 'fx_' + e.id;
  try {
    await col.doc(id).create({ target: 'welder', name: welder, code: '', amount: Number(e.amount), date: e.date, note: (staff ? `Staff advance — ${staff} · Falcon (${who})` : `Falcon (${who}): ${e.detail || ''}`).trim(), status: 'pending', source: 'falcon', falconId: e.id, ts: Date.now() });
  } catch (x) { if (x.code !== 6 && !/already exists/i.test(x.message || '')) throw x; }
  return id;
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
  // the worker's own first names (his display name + selfNames): used when the name was typed by hand, or when no
  // selfCode is on file for him yet (Grok review 12-10-2026 — without it such a line carried no red mark at all)
  const first = (x) => norm(x).split(' ')[0] || '';
  const selfNamesOf = Object.fromEntries(users.docs.map(d => [d.id, [d.data().name, ...(d.data().selfNames || [])].map(first).filter(Boolean)]));
  const isOwnAdvance = (e, t) => roleOfUser[e.by] === 'spender' && (
    (t.target === 'attendance' && !!selfCodeOf[e.by] && t.code === selfCodeOf[e.by])
    || ((!selfCodeOf[e.by] || !(e.advFor && e.advFor.code)) && (selfNamesOf[e.by] || []).includes(first(e.advFor && e.advFor.name))));
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
    if (push && push.status !== 'posting') continue;
    if (e.approval !== 'ok') { out.waiting++; continue; }
    const t = resolveTarget({ name: e.detail, code: '' }, roster, welders);
    const exactWelder = welders.find(w => norm(w) === norm(e.detail));
    const welder = t.target === 'welder' ? t.name : exactWelder || '';
    if (!welder) continue;                                           // some other contractor — nothing to post
    const who = nameOf[e.by] || e.by;
    if (dry) { console.log(`[dry] Karigar tile ₹${e.amount} ${e.detail} (${who}, ${e.date}) → welder ${welder}`); continue; }
    if (!(await claim(f, d.ref, { target: 'welder', name: welder }, (c) => c.kind === 'other' && c.head === 'Contractor' && c.by === e.by && c.amount === e.amount && c.date === e.date && c.detail === e.detail))) { out.waiting++; continue; }
    const refId = await queueWelder(f, e, welder, who);
    await d.ref.update({ advPush: { target: 'welder', name: welder, ref: refId, status: 'queued', at: now } });
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
    const who = nameOf[e.by] || e.by;
    const t = resolveTarget(e.advFor, roster, welders);
    // 'unmatched' = nothing was posted, only the name was not found. Once the name is corrected ("Entry badlo") and now
    // resolves, the flag is taken off and the line goes through the normal path below (Codex final review 12-10-2026:
    // such a line stayed stuck for ever). Every other flag means a posting may have happened → the owner handles it.
    if (push && push.status === 'unmatched' && t.target !== 'none' && e.approval === 'ok' && !dry) {
      const freed = await f.runTransaction(async (tx) => {
        const c = (await tx.get(d.ref)).data();
        if (!c || c.status !== 'active' || c.hisab != null || c.kind !== 'adv' || c.advStatus !== 'pending' || !c.advPush || c.advPush.status !== 'unmatched'
          || (c.advFor?.name || '') !== (e.advFor?.name || '') || (c.advFor?.code || '') !== (e.advFor?.code || '')) return false;
        tx.update(d.ref, { advPush: FieldValue.delete() });
        return true;
      });
      if (!freed) { out.waiting++; continue; }
      delete e.advPush;
    } else if (push && push.status !== 'posting') { out.waiting++; continue; } // flagged / rejected earlier — the owner handles it by hand
    const fresh = !e.advPush;   // no flag on the line (never handled, or just freed above)
    if (e.approval !== 'ok') {
      // Still waiting for the OK. If this is the worker's OWN advance and the phone did not mark it (a name typed in a
      // way the app did not recognise, or an altered app), mark it here so whoever passes it sees the red "Khud ka adv"
      // (Codex review 11-10-2026). Only the mark is written — no money, no approval.
      if (!dry && fresh && e.selfAdv !== true && isOwnAdvance(e, t)) {
        await d.ref.update({ selfAdv: true, selfAdvBy: 'auto:bridge' });
      }
      out.waiting++; continue;
    }
    // passed, but it is the worker's OWN advance and the line never carried the red "Khud ka adv" mark (an old or altered
    // app, passed before this job could mark it): whoever passed it did not see what it was → nothing is posted, the
    // owner decides (Codex final review 12-10-2026)
    if (fresh && e.selfAdv !== true && isOwnAdvance(e, t)) {
      if (!dry) {
        await d.ref.update({ selfAdv: true, selfAdvBy: 'auto:bridge', advPush: { target: t.target === 'attendance' ? 'attendance' : 'none', code: t.code || '', name: t.name || '', status: 'self-needs-owner', error: 'Khud ka advance bina nishaan ke pass hua — Nishant ji dekhen', at: now } });
        await sendTech(`Falcon: ₹${e.amount} ${esc(e.advFor?.name || e.detail)} (${esc(who)}, ${e.date}) — khud ka advance bina "Khud ka adv" nishaan ke pass hua, Attendance mein nahi gaya. Owner dekhe.`).catch((x) => console.error('tech alert failed:', x.message));
      }
      out.flagged++; continue;
    }
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
    const sameAdv = (c) => c.kind === 'adv' && c.by === e.by && c.amount === e.amount && c.date === e.date && (c.advFor?.name || '') === (e.advFor?.name || '') && (c.advFor?.code || '') === (e.advFor?.code || '');
    if (t.target === 'none') {
      const cur = (await d.ref.get()).data();
      if (!cur || cur.status !== 'active' || cur.hisab != null || cur.approval !== 'ok' || cur.advStatus !== 'pending' || (cur.advPush && cur.advPush.status !== 'posting') || !sameAdv(cur)) { out.waiting++; continue; }
    } else if (!(await claim(f, d.ref, t.target === 'attendance' ? { target: 'attendance', code: t.code, name: t.name } : { target: 'welder', name: t.name }, sameAdv))) { out.waiting++; continue; }
    if (t.target === 'attendance') {
      // already typed into Attendance by hand (same worker, same day, same amount)? then only mark the Falcon line — no second advance
      const existing = ((await f.collection('att_salary').doc(t.code).get()).data() || {}).advances || [];
      const advId = `adv-${e.date}-falcon-${e.id}`;
      // our own earlier push (a run that died after the Attendance write, before marking the Falcon line — 09-10-2026,
      // Telegram unreachable from the factory network) is NOT a "possible duplicate": it is this very advance
      // any row this line ever posted — the id carries the date, so a line re-dated after a posting must still find it
      const mineRow = existing.find(a => a.id === advId) || existing.find(a => String(a.id || '').endsWith(`-falcon-${e.id}`));
      // our id is already in Attendance: it is this advance ONLY if the money matches too. Anything else (an amount
      // changed after an earlier posting) is never marked done on a guess — the owner looks at it (Codex 11-10-2026).
      if (mineRow && (Number(mineRow.amount) !== Number(e.amount) || String(mineRow.date).slice(0, 10) !== e.date)) {
        await d.ref.update({ advPush: { target: 'attendance', code: t.code, name: t.name, status: 'mismatch', error: `Attendance mein ₹${Number(mineRow.amount) || 0} hai, yahan ₹${Number(e.amount) || 0} — owner dekhe`, at: now } });
        await sendTech(`Falcon advance ${esc(label)}: Attendance mein ₹${Number(mineRow.amount) || 0} pehle se gaya hua hai, line ab ₹${Number(e.amount) || 0} hai — owner check kare`).catch((x) => console.error('tech alert failed:', x.message));
        out.flagged++; continue;
      }
      const mine = !!mineRow;
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
      const refId = await queueWelder(f, e, t.name, who, t.staff || '');
      await d.ref.update({ advPush: { target: 'welder', name: t.name, ...(t.staff ? { staff: t.staff } : {}), ref: refId, status: 'queued', at: now } });
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
