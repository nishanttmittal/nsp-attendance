// LOADING HISAB — "cleared till which date" for the loading/unloading crew (owner 13-09-2026).
// The owner pays loaders once in a while (1–11 Aug, 12–25 Aug, 26 Aug–9 Sep …), not by calendar
// month, and could not remember up to which date their old account was cleared. Each clearance is now
// stored on the worker as an entry in `hisabClears[]` (additive field on att_salary, arrayUnion only):
//   { id, till:'YYYY-MM-DD', from, hours, earned, carryIn, paid, cashNow, carry, advIds[], payKeys[], by, at }
// This module is pure (no Firestore) so the figures can be checked outside the app.
//
// Earnings follow Anshul's slip, which was verified against the punches on 09-09-2026:
//   day hours = OUT − IN − 0.5 h lunch, ROUNDED TO THE NEAREST HOUR per day ("3 (+1)" = 11 h);
//   pay = hours × wage ÷ stdHours (10 h = 1 day, owner 2026-08-11 and re-confirmed 13-09-2026).
// A day with only one punch counts 0 hours and is flagged, never guessed.
// Cash is matched by the entry's DATE and by id, never by its `mk` month — an advance attributed to
// an older unlocked month is still money handed over in this hisab.

export const DAY_HOURS = 10;
const hoursOf = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return Number.isFinite(h) ? h + (m || 0) / 60 : null; };
export const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
export const isLoader = (e) => String((e && e.dept) || '').toUpperCase() === 'LOADING' && e.type === 'daily';
export const stdHoursOf = (e) => Number(e.stdHours) || Number(e.standardHours) || DAY_HOURS;
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function clearsOf(emp) {
  return (Array.isArray(emp.hisabClears) ? emp.hisabClears : []).filter((c) => c && c.till)
    .slice().sort((a, b) => String(a.till).localeCompare(String(b.till)) || String(a.at || '').localeCompare(String(b.at || '')));
}

// Newest date the machine has ANY punch for, across everyone — "punches synced till".
export function punchesSyncedTill(punchesByCode) {
  let max = '';
  for (const p of Object.values(punchesByCode || {})) {
    for (const [mk, days] of Object.entries((p && p.months) || {})) {
      for (const [dd, r] of Object.entries(days || {})) {
        if (r && (r.i || r.o)) { const ymd = `${mk}-${dd}`; if (ymd > max) max = ymd; }
      }
    }
  }
  return max;
}

// Every punched day in [from, to] for one worker.
export function daysInWindow(punchDoc, from, to) {
  const out = [];
  for (const [mk, days] of Object.entries((punchDoc && punchDoc.months) || {})) {
    for (const [dd, r] of Object.entries(days || {})) {
      const ymd = `${mk}-${dd}`;
      if (ymd < from || ymd > to || !r || !(r.i || r.o)) continue;
      const i = hoursOf(r.i), o = hoursOf(r.o);
      if (i != null && o != null) {
        let raw = o - i; if (raw < 0) raw += 24;
        raw = Math.max(0, raw - 0.5);
        out.push({ ymd, in: r.i, out: r.o, raw: r2(raw), hours: Math.round(raw), missing: null });
      } else {
        out.push({ ymd, in: r.i || null, out: r.o || null, raw: 0, hours: 0, missing: r.i ? 'out' : 'in' });
      }
    }
  }
  return out.sort((a, b) => a.ymd.localeCompare(b.ymd));
}

// Money handed over that no earlier clearance has used yet: advances + locked-month payments.
export function cashEntries(emp, seedTill) {
  const used = new Set(clearsOf(emp).flatMap((c) => [...(c.advIds || []), ...(c.payKeys || [])]));
  const list = [];
  for (const a of emp.advances || []) {
    if (!a || !a.date || !a.id || used.has(a.id)) continue;
    if (seedTill && a.date <= seedTill) continue;
    list.push({ key: a.id, kind: 'adv', date: a.date, amount: Number(a.amount) || 0, mode: a.mode || 'cash', remark: a.remark || '' });
  }
  for (const [mk, md] of Object.entries(emp.months || {})) {
    const p = md && md.payment;
    const amt = p ? (Number(p.cash) || 0) + (Number(p.account) || 0) : 0;
    const key = `pay:${mk}`;
    if (!p || !amt || !p.date || used.has(key)) continue;
    if (seedTill && p.date <= seedTill) continue;
    list.push({ key, kind: 'pay', date: p.date, amount: amt, mode: p.account && !p.cash ? 'account' : 'cash', remark: `Salary ${mk} settle` });
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// The open hisab for one loader, from the day after his last clearance up to `to`.
export function openHisab(emp, punchDoc, to) {
  const clears = clearsOf(emp);
  const last = clears[clears.length - 1] || null;
  const seedTill = clears.length ? clears[0].till : '';
  const from = last ? addDays(last.till, 1) : (emp.joinDate || '2026-06-01');
  const days = to >= from ? daysInWindow(punchDoc, from, to) : [];
  const hours = days.reduce((s, d) => s + d.hours, 0);
  const std = stdHoursOf(emp);
  const wage = Number(emp.wage) || 0;
  const earned = r2((hours * wage) / std);
  const cash = cashEntries(emp, seedTill);
  const paid = r2(cash.reduce((s, c) => s + c.amount, 0));
  const carryIn = r2(last ? last.carry : 0);   // + = we still owed him at the last clear, − = he had extra
  return {
    last, clears, from, to, days, hours, std, wage, earned, cash, paid, carryIn,
    balance: r2(carryIn + earned - paid),      // + = to pay him now, − = he has taken extra
    missing: days.filter((d) => d.missing).length,
    daysWorked: days.filter((d) => !d.missing).length,
  };
}

// "19 h" → "1 din 9 ghante" — the way Anshul writes it on the slip (10/8 = 10 days 8 h)
export function dinGhante(hours, std = DAY_HOURS) {
  const h = Math.round(Number(hours) || 0);
  const d = Math.floor(h / std), g = h - d * std;
  return `${d} din${g ? ` ${g} ghante` : ''}`;
}

// Last date this worker punched at all — hides a loader who has left (nothing open, no recent punches).
export function lastPunchDate(punchDoc) {
  return punchesSyncedTill(punchDoc ? { x: punchDoc } : {});
}
