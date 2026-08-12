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
