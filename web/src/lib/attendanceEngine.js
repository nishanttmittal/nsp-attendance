// APP-SIDE attendance engine — computes present / half / absent / weekly-off from RAW punches,
// applying the owner's rules directly (clean Full/Half/Absent, no portal fractions). The rules
// live HERE, uniformly, so changing one recomputes every month instantly — no portal reprocess.
//
// Rules (owner rulebook + 15-min grace):
//  • single punch (forgot out) = FULL
//  • worked < absent-line -> ABSENT ; < full-line -> HALF ; else FULL   (weekdays only)
//  • Saturday = weekly-off: worked it -> weekly-off-present (OT, not a day);
//    not worked -> paid weekly-off IF the week earned it (>=4 present-days), else ABSENT
//  • grace on: absent-line 4:00->3:45, full-line -15min per shift

export const SHIFT_FULLCUT = { GEN: 7, '10H': 9, '12H': 10.5, wir: 9 };
// Shift DURATION (gross span incl. lunch) — used for app-side OT = worked − shift hours.
export const SHIFT_HOURS = { GEN: 8.5, '10H': 10.5, '12H': 12, wir: 10.5, DSG: 10 };
export const WEEKLY_OFF_NEEDS = 4;

const hoursOf = (hhmm) => { if (!hhmm || !/^\d/.test(hhmm)) return null; const [h, m] = String(hhmm).split(':').map(Number); return h + (m || 0) / 60; };
export const hhmmOf = (h) => (h == null ? null : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function workedHours(inH, outH) { let w = outH - inH; if (w < 0) w += 24; return w; } // cross-midnight

function absLine(grace) { return grace ? 3.75 : 4; }
function fullLine(shift, grace) { return (SHIFT_FULLCUT[shift] || 7) - (grace ? 0.25 : 0); }

// classify one weekday from its punch record {i,o} -> {status, worked}
export function classifyDay(shift, rec, grace) {
  const inH = hoursOf(rec && rec.i), outH = hoursOf(rec && rec.o);
  if (inH == null && outH == null) return { status: 'absent', worked: 0 };
  if (inH != null && outH == null) return { status: 'full', worked: null, single: true }; // single punch
  const worked = workedHours(inH, outH);
  if (worked < absLine(grace)) return { status: 'absent', worked };
  if (worked < fullLine(shift, grace)) return { status: 'half', worked };
  return { status: 'full', worked };
}

const wkKey = (ymd) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); };

// punchesByDate: { 'YYYY-MM-DD': {i,o} } spanning at least the target window's weeks.
// window: { start:'YYYY-MM-DD', to:'YYYY-MM-DD' } inclusive. Returns totals + per-day detail (in-window).
export function computeMonth(shift, punchesByDate, window, opts = {}) {
  const grace = opts.grace !== false;                      // default grace ON
  const start = window.start, to = window.to;
  const shiftHours = SHIFT_HOURS[shift] || 8.5;            // for app-side OT = worked − shift hours
  const r2 = (n) => Math.round(n * 100) / 100;
  const dates = Object.keys(punchesByDate).sort();
  // median in/out from complete weekday records — to estimate OT on missing-punch days
  const insArr = [], outsArr = [];
  for (const ymd of dates) {
    if (new Date(ymd + 'T00:00:00').getDay() === 6) continue;
    const r = punchesByDate[ymd]; const ih = hoursOf(r && r.i), oh = hoursOf(r && r.o);
    if (ih != null && oh != null && ih < 14) { insArr.push(ih); outsArr.push(oh); }
  }
  const medIn = median(insArr), medOut = median(outsArr);
  // group all available dates by week so first-week earning can see the prior month
  const weeks = {};
  for (const ymd of dates) (weeks[wkKey(ymd)] = weeks[wkKey(ymd)] || []).push(ymd);

  let present = 0, absent = 0, half = 0, weeklyOff = 0, weeklyOffPresent = 0, otHrs = 0;
  const detail = [];
  for (const wk of Object.keys(weeks)) {
    let wdPresent = 0;                                      // full-week weekday presence -> earning
    for (const ymd of weeks[wk]) {
      if (new Date(ymd + 'T00:00:00').getDay() === 6) continue;
      const c = classifyDay(shift, punchesByDate[ymd], grace);
      if (c.status === 'full') wdPresent += 1; else if (c.status === 'half') wdPresent += 0.5;
    }
    const earned = wdPresent >= WEEKLY_OFF_NEEDS;
    for (const ymd of weeks[wk]) {
      if (ymd < start || ymd > to) continue;               // count only in-window days
      const isSat = new Date(ymd + 'T00:00:00').getDay() === 6;
      const rec = punchesByDate[ymd];
      const io = { in: (rec && rec.i) || null, out: (rec && rec.o) || null };
      if (isSat) {
        if (rec && rec.i) {
          weeklyOffPresent += 1;
          const w = rec.o ? workedHours(hoursOf(rec.i), hoursOf(rec.o)) : null;
          if (w != null) otHrs += w;                       // worked weekly-off: ALL hours are OT
          let missing = null, otIfFixed = 0;
          if (w == null) {                                 // Saturday single punch
            const t = hoursOf(rec.i);
            if (t != null && t < 14 && medOut != null) { missing = 'out'; otIfFixed = workedHours(t, medOut); }
            else if (t != null && medIn != null) { missing = 'in'; otIfFixed = workedHours(medIn, t); }
          }
          detail.push({ ymd, ...io, kind: 'sat-worked', worked: w, ot: r2(w || 0), missing, otIfFixed: r2(otIfFixed) });
        }
        else if (earned) { weeklyOff += 1; detail.push({ ymd, ...io, kind: 'weekly-off' }); }
        else { absent += 1; detail.push({ ymd, ...io, kind: 'sat-absent' }); }
      } else {
        const c = classifyDay(shift, rec, grace);
        if (c.status === 'full') present += 1;
        else if (c.status === 'half') { present += 0.5; absent += 0.5; half += 1; }
        else absent += 1;
        let dayOt = 0, missing = null, otIfFixed = 0;
        if (c.worked != null) { dayOt = Math.max(0, c.worked - shiftHours); otHrs += dayOt; }  // weekday OT
        else if (rec && rec.i) {                           // single punch — one side missing
          const t = hoursOf(rec.i);
          if (t != null && t < 14 && medOut != null) { missing = 'out'; otIfFixed = Math.max(0, workedHours(t, medOut) - shiftHours); }
          else if (t != null && medIn != null) { missing = 'in'; otIfFixed = Math.max(0, workedHours(medIn, t) - shiftHours); }
        }
        detail.push({ ymd, ...io, kind: c.status, worked: c.worked, single: c.single, ot: r2(dayOt), missing, otIfFixed: r2(otIfFixed), medIn: hhmmOf(medIn), medOut: hhmmOf(medOut) });
      }
    }
  }
  return { present: r2(present), absent: r2(absent), half, weeklyOff, weeklyOffPresent, otHrs: r2(otHrs), detail: detail.sort((a, b) => a.ymd.localeCompare(b.ymd)) };
}

// App-side OT for a month from an att_punches doc (worked − shift hours; worked Saturdays = all hours).
export function monthOt(shift, punchDoc, mk, curMonth) {
  if (!punchDoc) return 0;
  const pbd = punchesByDateFor(punchDoc, mk), win = monthWindow(mk, curMonth);
  return computeMonth(shift || 'GEN', pbd, win, { grace: true }).otHrs;
}
// Full per-day detail for a month (in/out/worked/ot + missing-punch flag with otIfFixed estimate).
export function monthDetail(shift, punchDoc, mk, curMonth) {
  if (!punchDoc) return { otHrs: 0, detail: [] };
  const pbd = punchesByDateFor(punchDoc, mk), win = monthWindow(mk, curMonth);
  return computeMonth(shift || 'GEN', pbd, win, { grace: true });
}

// --- helpers to drive the engine from an att_punches doc for a given month ---
const prevMonthKey = (mk) => { const [y, m] = mk.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
export function punchesByDateFor(punchDoc, mk) {
  const months = (punchDoc && punchDoc.months) || {};
  const out = {};
  for (const key of [prevMonthKey(mk), mk]) { const days = months[key] || {}; for (const dd of Object.keys(days)) out[`${key}-${dd}`] = days[dd]; }
  return out;
}
export function monthWindow(mk, curMonth) {
  const [y, m] = mk.split('-').map(Number);
  const start = `${mk}-01`;
  if (mk === curMonth) { const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000); const yest = new Date(Date.UTC(y, m - 1, nowIst.getUTCDate() - 1)); return { start, to: yest.toISOString().slice(0, 10) }; }
  const last = new Date(Date.UTC(y, m, 0)); return { start, to: last.toISOString().slice(0, 10) };
}
// extra PRESENT days a worker gains from the 15-min grace this month (0 if no punches / no near-miss)
export function graceDeltaDays(shift, punchDoc, mk, curMonth) {
  if (!punchDoc) return 0;
  const pbd = punchesByDateFor(punchDoc, mk), win = monthWindow(mk, curMonth);
  const on = computeMonth(shift || 'GEN', pbd, win, { grace: true }).present;
  const off = computeMonth(shift || 'GEN', pbd, win, { grace: false }).present;
  return Math.round((on - off) * 100) / 100;
}
