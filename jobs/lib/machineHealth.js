// Biometric machine health (owner 16-10-2026: "build the machine offline alert").
// 15-10-2026 the machine went Offline after 09:25 and held the late-comers' + all evening punches;
// the food count came 4 short and nobody knew until night. This reads the machine's live status
// from the portal's raw-log page INSIDE the floor pull's existing session (no extra login — the
// portal throttles after ~12 automated logins/day) and sends ONE plain WhatsApp line when:
//   - the machine is Offline (re-read 60 s later to skip a one-off blip), or
//   - it is a working day and no punch has reached the portal by the morning check, or
//   - from 20:30 the machine has morning punches but zero evening out-punches (the 15-10 case),
// and one "back" line once it recovers. Its #Button3 click also pulls the machine's punches into the portal
// (see deviceLog.js) — that is wanted; it changes no settings and deletes nothing.
const { pullDeviceLog, LOG_URL } = require('./deviceLog');
const { db } = require('./firestore');


function istNow() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { ymd: ist.toISOString().slice(0, 10), dmy: ist.toISOString().slice(0, 10).split('-').reverse().join('/'),
    min: ist.getUTCHours() * 60 + ist.getUTCMinutes(), hhmm: ist.toISOString().slice(11, 16), wday: ist.getUTCDay() };
}

// Device_List option text looks like "RSS20231068699-T304F Mini / realtime - Online"
async function readStatus(page) {
  await page.goto(LOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const devs = await page.evaluate(() => {
    const dl = document.getElementById('Device_List');
    return dl ? Array.from(dl.options).map(o => o.text.trim()) : [];
  });
  const offline = devs.filter(t => /offline/i.test(t));
  const status = !devs.length ? 'unknown' : offline.length ? 'Offline' : devs.every(t => /online/i.test(t)) ? 'Online' : 'unknown';
  return { status, devs };
}

// Today's punches as the portal sees them (it reads the device's memory live; 0 rows while Offline).
async function readTodayPunches(page, dmy) {
  const rows = await pullDeviceLog(page, dmy);
  const mins = rows.map(r => {
    const m = String(r[1]).match(/(\d{1,2}):(\d{2}):\d{2}(?::\d+)?\s*(AM|PM)/i);
    if (!m) return null;
    let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12;
    return h * 60 + +m[2];
  }).filter(x => x !== null);
  return { punches: rows.length, cards: new Set(rows.map(r => r[0])).size,
    lastMin: mins.length ? Math.max(...mins) : null, eveningPunches: mins.filter(x => x >= 17 * 60).length };
}

const fmt = m => m == null ? '-' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Called from publishState.js after the floor is published. Never throws (floor pull must not fail).
async function checkMachine(page, { send } = {}) {
  try {
    const t = istNow();
    let st = await readStatus(page);
    if (st.status === 'Offline') { await page.waitForTimeout(60000); st = await readStatus(page); }
    const p = st.status === 'Online' ? await readTodayPunches(page, t.dmy) : { punches: 0, cards: 0, lastMin: null, eveningPunches: 0 };

    const hol = (((await db().collection('att_meta').doc('holidays').get()).data() || {}).dates || {})[t.ymd];
    const workday = t.wday !== 6 && !hol;                       // Saturday = weekly off

    const problems = [];
    const floorHours = t.min >= 8 * 60 + 30 && t.min <= 21 * 60 + 15;   // machine may be switched off at night / weekly off
    if (st.status === 'Offline' && workday && floorHours) problems.push('offline');
    if (st.status === 'Online' && workday && t.min >= 10 * 60 && p.punches === 0) problems.push('no-punches');
    if (st.status === 'Online' && workday && t.min >= 20 * 60 + 30 && p.punches >= 15 && p.eveningPunches === 0) problems.push('no-evening');

    const ref = db().collection('att_alert_state').doc('machine_health');
    const prev = (await ref.get()).data() || {};
    const sent = prev.day === t.ymd ? (prev.sent || {}) : {};
    const open = prev.day === t.ymd ? (prev.open || []) : [];

    const msgs = [];
    for (const k of problems) {
      if (sent[k]) continue;                                    // one message per problem per day
      if (k === 'offline') msgs.push(`⚠️ Attendance machine OFFLINE at ${t.hhmm}.\nPunches are not reaching the portal, so the food count and attendance will be short.\nAt the machine: check Wi-Fi and power. Punches stay saved in the machine and come in once it is back.`);
      if (k === 'no-punches') msgs.push(`⚠️ Attendance machine: no punch has reached the portal today (checked ${t.hhmm}).\nCheck the machine's Wi-Fi, power and date/time.`);
      if (k === 'no-evening') msgs.push(`⚠️ Attendance machine: ${p.cards} people punched in today but no evening OUT punch has reached the portal (checked ${t.hhmm}).\nCheck the machine's Wi-Fi and date/time.`);
      sent[k] = t.hhmm;
    }
    const nowOpen = problems;
    const recovered = open.filter(k => !nowOpen.includes(k));
    if (recovered.includes('offline') && st.status === 'Online') msgs.push(`✅ Attendance machine is back online (${t.hhmm}). ${p.cards} people punched today, last punch ${fmt(p.lastMin)}.`);

    const dry = process.env.MACHINE_DRY === 'true';               // test: print, send nothing, save nothing
    if (dry) { console.log('[MACHINE_DRY] would send:', msgs.length ? msgs : 'nothing'); }
    else for (const m of msgs) await send(m).catch(e => console.error('machine alert send failed:', e.message));

    const check = { at: new Date().toISOString(), ist: t.hhmm, status: st.status, punches: p.punches, cards: p.cards, last: fmt(p.lastMin), evening: p.eveningPunches, problems };
    if (!dry) await ref.set({ day: t.ymd, sent, open: nowOpen, last: check, devs: st.devs,
      checks: [...(prev.day === t.ymd ? prev.checks || [] : []), check].slice(-20) });
    console.log(`machine: ${st.status} · ${p.cards} people / ${p.punches} punches today · last ${fmt(p.lastMin)} · evening ${p.eveningPunches}${problems.length ? ' · PROBLEM ' + problems.join(',') : ''}${msgs.length ? ' · sent ' + msgs.length : ''}`);
    return check;
  } catch (e) {
    console.error('machine check skipped:', String(e.message || e).split('\n')[0], process.env.MACHINE_DRY === 'true' ? e.stack : '');
    return null;
  }
}

// Hard cap: the floor pull runs under the worker's 5-min timeout — a slow portal must skip the
// machine check, never fail the floor update.
function checkMachineCapped(page, opts, ms = 100000) {
  return Promise.race([checkMachine(page, opts),
    new Promise(r => setTimeout(() => { console.error('machine check skipped: over ' + ms / 1000 + ' s'); r(null); }, ms).unref())]);
}

module.exports = { checkMachine: checkMachineCapped, checkMachineRaw: checkMachine, readStatus, readTodayPunches };
