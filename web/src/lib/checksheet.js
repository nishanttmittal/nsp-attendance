// "Days & OT verification sheet" — the pre-payday muster the owner shares on WhatsApp.
// Staff check their Days + OT and write their Advance; owner verifies, then pays. Built from the
// APP's own numbers (present days + net OT), NOT the portal, so it's exactly what the app would pay.
// xlsx (~430 KB) is loaded ON DEMAND, only when the owner actually taps "Check-sheet".
// It used to be a static import, so every worker paid for it on every app open even
// though only the owner ever presses that one button. Behaviour is unchanged — the
// only consumer (shareCheckSheet) was already async.
const loadXLSX = () => import('xlsx');

// One check-sheet row. Days = PAID days (paid Saturdays INCLUDED — owner 2026-08-12: don't show
// them separately). ± Day = owner-added bonus (+1) / dock-fine converted to days (−N).
export function checkRow(r) {
  const perDay = Number(r.pay.perDay) || 0;
  const plus = (r.pay.perfectBonus || 0) > 0 ? 1 : 0;
  const minus = perDay > 0 ? Math.round(((Number(r.md?.fine) || 0) / perDay) * 2) / 2 : 0;
  // ASCII minus only — U+2212 renders as garbage/nothing in jsPDF's built-in fonts
  const pm = [plus ? `+${plus}` : '', minus ? `-${minus}` : ''].filter(Boolean).join(' ');
  const days = r.pay.paidDays != null ? r.pay.paidDays : (r.pay.presentDays || 0);
  return [r.emp.name || r.emp.code, r.emp.dept || '', days, pm, r.pay.otHrsNet || 0, '', ''];
}

// rows = the Salary screen's computed rows [{ emp, pay, ... }]. mk = 'YYYY-MM'.
export async function buildCheckSheet(rows, mk) {
  const XLSX = await loadXLSX();
  const sorted = [...rows].sort((a, b) =>
    (a.emp.dept || '').localeCompare(b.emp.dept || '') || (a.emp.name || '').localeCompare(b.emp.name || ''));
  const header = ['Name', 'Dept', 'Days', '± Day', 'OT (hrs)', 'Advance', 'OK'];
  const body = sorted.map(checkRow);
  const aoa = [[`NSP — Days & OT check-sheet · ${mk}`], [], header, ...body];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 12 }, { wch: 6 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Check');
  return wb;
}

// Build the .xlsx and hand it to the WhatsApp/share sheet (download fallback on desktop).
export async function shareCheckSheet(rows, mk) {
  const XLSX = await loadXLSX();
  const wb = await buildCheckSheet(rows, mk);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `days-OT-check-${mk}.xlsx`;
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}

// ── Give-salary register (owner 2026-08-12): Name · Rate · Days · OT hrs · Adv c/f ·
// Adv paid (month) · Total adv · Payable · Cash · Account. Locked rows carry the actual
// cash/account paid; unpaid rows leave them blank to fill while distributing. ──
export function registerRow(r) {
  const emp = r.emp, pay = r.pay || {}, md = r.md || {}, p = md.payment || {};
  const locked = !!(md.locked || md.payment);
  const opening = Number(pay.openingBalance || 0);
  const advCarry = opening < 0 ? Math.round(-opening) : 0;          // old advance the worker owes
  const balDue = opening > 0 ? Math.round(opening) : 0;             // owner owed the worker from before
  const advM = Math.round(Number(r.advancesThisMonth || 0));
  return {
    Dept: emp.dept || '',
    Name: emp.name || emp.code,
    Rate: emp.type === 'daily' ? (Number(emp.wage) || 0) + '/day' : Math.round(Number(emp.amount) || 0),
    Days: pay.paidDays != null ? pay.paidDays : (pay.presentDays || 0),
    'OT hrs': Math.round((pay.otHrsNet || 0) * 10) / 10,
    'Adv c/f': advCarry || (balDue ? '(+' + balDue + ' due)' : ''),
    'Adv paid': advM || '',
    'Total adv': (advCarry + advM) || '',
    Payable: locked ? Math.round(p.payable != null ? p.payable : (p.net || 0)) : Math.round(pay.payable || 0),
    Cash: locked ? Math.round(p.cash || 0) : '',
    Account: locked ? Math.round(p.account || 0) : '',
    Status: locked ? 'PAID' : '',
  };
}

export async function shareSalaryRegisterXlsx(rows, mk) {
  const XLSX = await loadXLSX();
  const sorted = [...rows].sort((a, b) =>
    (a.emp.dept || '').localeCompare(b.emp.dept || '') || (a.emp.name || '').localeCompare(b.emp.name || ''));
  const body = sorted.map(registerRow);
  const num = (k) => body.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  body.push({ Dept: '', Name: 'TOTAL', Rate: '', Days: '', 'OT hrs': '', 'Adv c/f': num('Adv c/f'),
    'Adv paid': num('Adv paid'), 'Total adv': num('Total adv'), Payable: num('Payable'), Cash: num('Cash'), Account: num('Account'), Status: '' });
  const ws = XLSX.utils.json_to_sheet(body);
  ws['!cols'] = [{ wch: 11 }, { wch: 26 }, { wch: 9 }, { wch: 6 }, { wch: 7 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 6 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Salary ' + mk);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = 'salary-register-' + mk + '.xlsx';
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
