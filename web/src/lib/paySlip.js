// The pay slip shown on the pay sheet — pure arithmetic over the SAME `pay` object the amount comes from
// (payroll.js computePay). No pay rule lives here; anything the engine applied that is not itemised below
// lands in `other`, so the lines always add up to the net.
//   gross = base + overtime + bonuses;  net (before PF) = gross − advance − cuts + last month's balance
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;

export function slipLines(pay, { bonusDayAdd = 0, pfTyped = null } = {}) {
  const pfWas = n(pay.pfCut);                                   // PF already inside pay.payable
  const pf = pfTyped == null ? pfWas : Math.max(0, Math.round(n(pfTyped)));
  const beforePf = r2(n(pay.payable) + pfWas + n(bonusDayAdd));
  const extras = r2(n(pay.perfectBonus) + n(pay.bonus) + n(pay.gracePay) + n(pay.restoreSaturdayPay) + n(bonusDayAdd));
  const gross = r2(n(pay.base) + n(pay.otPay) + extras);
  const advCut = n(pay.advanceRecovered);
  const cuts = r2(n(pay.fines) + n(pay.latePenalty) + n(pay.weeklyOffDock));
  const opening = n(pay.openingBalance);
  const other = r2(beforePf - (gross - advCut - cuts + opening));
  return { gross, extras, advCut, cuts, opening, other, beforePf, pf, inHand: r2(beforePf - pf) };
}

// "Why" lines a worker asks about, from the month's day-by-day detail (attendanceEngine.monthDetail)
// and this month's advance entries. Dates as day numbers; display only.
export function slipWhy(detail = [], advs = []) {
  const day = (d) => String(d.ymd || '').slice(8);
  const absent = detail.filter((d) => d.kind === 'absent' || d.kind === 'sat-absent').map(day);
  const half = detail.filter((d) => d.kind === 'half').map((d) => `${day(d)} (${d.in || '—'}→${d.out || '—'})`);
  const single = detail.filter((d) => d.single).map((d) => `${day(d)} (${d.in || d.out})`);
  const holidays = detail.filter((d) => d.kind === 'holiday').map((d) => `${day(d)}${d.name ? ' ' + d.name : ''}`);
  const advances = [...advs].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .map((a) => ({ date: String(a.date || '').slice(5).split('-').reverse().join('-'), amount: n(a.amount), note: a.note || a.remark || '' }));
  return { absent, half, single, holidays, advances };
}
