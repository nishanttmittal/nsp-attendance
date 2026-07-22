// Salary PDFs (jspdf) + share via the phone's native share sheet (-> WhatsApp etc.).
// Uses "Rs" (jspdf's default font has no ₹ glyph).
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN');

// advance split by payment mode for a list of advances (handles 'both' with bank+cash fields)
export function advanceSplit(advances = []) {
  let bank = 0, cash = 0;
  for (const a of advances) {
    if (a.mode === 'account') bank += Number(a.amount || 0);
    else if (a.mode === 'cash') cash += Number(a.amount || 0);
    else { bank += Number(a.bank || 0); cash += Number(a.cash || 0); } // 'both'
  }
  return { bank, cash };
}

// Monthly attendance detail (in/out per day) — hand a worker their full month's timings.
const DOW_PDF = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RESULT_PDF = { full: 'Full', half: 'Half', absent: 'Absent', 'weekly-off': 'Weekly-off', 'sat-worked': 'Sat worked (OT)', 'sat-absent': 'Sat cut' };
export function attendanceDetailPdf(emp, monthLabel, app, grace) {
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text('NSP ENTERPRISES', 14, 18);
  doc.setFontSize(12); doc.text('Attendance Detail  ' + monthLabel, 14, 26);
  doc.setFontSize(10);
  doc.text(`Name: ${emp.name || emp.code}`, 14, 36);
  doc.text(`Code: ${emp.code}`, 130, 36);
  doc.text(`Shift: ${emp.shift || 'GEN'}`, 14, 42);
  doc.text(`Grace: ${grace ? '15 min' : 'off'}`, 130, 42);
  doc.text(`Present ${app.present}  |  Absent ${app.absent}  |  Half ${app.half}  |  Weekly-off ${app.weeklyOff}${app.weeklyOffPresent ? ` (+${app.weeklyOffPresent} worked)` : ''}`, 14, 50);
  const body = (app.detail || []).map((d) => {
    const dt = new Date(d.ymd + 'T00:00:00');
    const hrs = d.worked != null ? d.worked.toFixed(2) + 'h' : (d.single ? 'single' : '');
    return [d.ymd.slice(8) + '/' + d.ymd.slice(5, 7), DOW_PDF[dt.getDay()], d.in || '-', d.out || (d.in ? 'no out' : '-'), hrs, RESULT_PDF[d.kind] || d.kind];
  });
  autoTable(doc, { startY: 56, head: [['Date', 'Day', 'In', 'Out', 'Hours', 'Result']], body, theme: 'grid', styles: { fontSize: 9 }, headStyles: { fillColor: [185, 28, 28] } });
  doc.setFontSize(8); doc.text('Computed by NSP Attendance from biometric punches. In = first punch, Out = last punch.', 14, 288);
  return doc;
}

export function payslipOnePdf(emp, pay, monthLabel) {
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text('NSP ENTERPRISES', 14, 18);
  doc.setFontSize(11); doc.text('Salary Slip  ' + monthLabel, 14, 26);
  doc.setFontSize(10);
  doc.text(`Name: ${emp.name || emp.code}`, 14, 38);
  doc.text(`Code: ${emp.code}`, 130, 38);
  doc.text(`Dept: ${emp.dept || '-'}`, 14, 44);
  doc.text(`Type: ${emp.appOnly ? 'Daily-wager' : (emp.type || '-')}`, 130, 44);
  doc.text(`Present / Absent: ${pay.presentDays} / ${pay.absentDays}`, 14, 50);
  doc.text(`OT (net): ${pay.otHrsNet} h`, 130, 50);
  if (!emp.appOnly && pay.saturdaysInPeriod > 0)
    doc.text(`Saturdays: ${pay.weeklyOff} paid / ${pay.weeklyOffPresent} worked / ${pay.saturdaysCut} cut (of ${pay.saturdaysInPeriod})`, 14, 56);
  const body = [
    ['Base', rs(pay.base)],
    ['Overtime', rs(pay.otPay)],
    ['Attendance bonus', rs(pay.perfectBonus)],
    ...(pay.gracePay > 0 ? [[`15-min grace (${pay.graceDays} day)`, rs(pay.gracePay)]] : []),
    ...(pay.restoreSaturdayPay > 0 ? [[`${pay.restoreSaturdayDays} Saturday goodwill`, rs(pay.restoreSaturdayPay)]] : []),
    ['Bonus', rs(pay.bonus)],
    ...(pay.fines > 0 ? [['Fine', '- ' + rs(pay.fines)]] : []),
    ...(pay.advanceRecovered > 0 ? [['Advance recovered (full)', '- ' + rs(pay.advanceRecovered)]] : []),
  ];
  autoTable(doc, { startY: 62, head: [['Component', 'Amount']], body, theme: 'grid', styles: { fontSize: 10 } });
  let y = (doc.lastAutoTable?.finalY || 110) + 10;
  doc.setFontSize(14); doc.text('NET PAY:  ' + rs(pay.net), 14, y);
  doc.setFontSize(9); doc.text('Authorised signature: ____________________', 14, 285);
  return doc;
}

// rows: { name, days, ot, advBank, advCash, net, carried }
export function payslipAllPdf(rows, monthLabel) {
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFontSize(14); doc.text('NSP ENTERPRISES  -  Salary Register  -  ' + monthLabel, 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [['Name', 'Days', 'OT (h)', 'Advance Bank', 'Advance Cash', 'Net Payable', 'Adv. Carried']],
    body: rows.map(r => [r.name, r.days, r.ot, rs(r.advBank), rs(r.advCash), rs(r.net), rs(r.carried)]),
    theme: 'striped', styles: { fontSize: 8 }, headStyles: { fillColor: [192, 57, 43] },
  });
  const tot = rows.reduce((a, r) => ({ net: a.net + Number(r.net || 0), bank: a.bank + Number(r.advBank || 0), cash: a.cash + Number(r.advCash || 0) }), { net: 0, bank: 0, cash: 0 });
  const y = (doc.lastAutoTable?.finalY || 30) + 8;
  doc.setFontSize(11);
  doc.text(`Totals  -  Net: ${rs(tot.net)}   Advance Bank: ${rs(tot.bank)}   Advance Cash: ${rs(tot.cash)}`, 14, y);
  return doc;
}

// LOCKED-MONTH register: for every worker whose salary is LOCKED for the month, one row with
// Days · OT · Advance · Payable · Net · Cash paid · Account paid · Carried forward.
// rows: { name, salary, days, ot, advance, payable, net, cash, account, carried }
export function lockedRegisterPdf(rows, monthLabel) {
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFontSize(14); doc.text('NSP ENTERPRISES  -  Salary & Payments (Locked)  -  ' + monthLabel, 14, 16);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`Locked workers: ${rows.length}   ·   generated ${new Date().toLocaleString('en-IN')}`, 14, 21);
  doc.setTextColor(0);
  autoTable(doc, {
    startY: 26,
    head: [['Name', 'Salary', 'Days', 'OT (h)', 'Advance', 'Payable', 'Net', 'Cash paid', 'Account paid', 'Carried fwd']],
    body: rows.map(r => [r.name, rs(r.salary), r.days, r.ot, rs(r.advance), rs(r.payable), rs(r.net), rs(r.cash), rs(r.account), rs(r.carried)]),
    theme: 'striped', styles: { fontSize: 8 }, headStyles: { fillColor: [192, 57, 43] },
  });
  const t = rows.reduce((a, r) => ({
    salary: a.salary + Number(r.salary || 0),
    payable: a.payable + Number(r.payable || 0), net: a.net + Number(r.net || 0),
    cash: a.cash + Number(r.cash || 0), account: a.account + Number(r.account || 0),
    advance: a.advance + Number(r.advance || 0), carried: a.carried + Number(r.carried || 0),
  }), { salary: 0, payable: 0, net: 0, cash: 0, account: 0, advance: 0, carried: 0 });
  const y = (doc.lastAutoTable?.finalY || 30) + 8;
  doc.setFontSize(10);
  doc.text(`TOTALS  -  Payable ${rs(t.payable)}   Net ${rs(t.net)}   Cash paid ${rs(t.cash)}   Account paid ${rs(t.account)}   Advance ${rs(t.advance)}   Carried ${rs(t.carried)}`, 14, y);
  return doc;
}

// ADVANCES REGISTER — a running ledger per worker: the balance BROUGHT FORWARD from previous months
// (the carried openingBalance — negative = owes us) + advances given this month, ending in a
// "Total owed". Fixes the old register, which only listed itemised entries and so silently omitted a
// worker's carried leftover (e.g. someone owing ₹31,997 b/f showed only this month's new advance).
// groups: [{ name, code, dept, bf, entries: [{ date, mode, amount, remark, cash?, bank? }] }]
//   bf = signed running balance carried into the month (negative = owes us; positive = credit).
export function advancesPdf(groups, asOfLabel) {
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text('NSP ENTERPRISES', 14, 16);
  doc.setFontSize(12); doc.text('Advances Register  -  till ' + asOfLabel, 14, 24);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Brought-forward balance + advances given this month.  Generated ' + new Date().toLocaleString('en-IN'), 14, 30);
  doc.setTextColor(0);

  const B = (s) => ({ content: s, styles: { fontStyle: 'bold', fillColor: [245, 245, 245] } });
  const owedStr = (net) => (net >= 0 ? rs(Math.round(net)) + ' owed' : rs(Math.round(-net)) + ' CREDIT');
  const body = [];
  let gCash = 0, gAcct = 0, gCount = 0, gOwed = 0;
  for (const g of groups) {
    const bf = Number(g.bf || 0);                    // running balance carried in (neg = owes us)
    let eCash = 0, eAcct = 0;
    const entries = [...(g.entries || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    let nameShown = false;
    const nameCell = () => { if (nameShown) return ''; nameShown = true; return `${g.name}${g.dept ? ` (${g.dept})` : ''}`; };
    if (Math.round(bf) !== 0) {
      body.push([nameCell(), 'B/F', '', '', bf < 0 ? `Brought forward: ${rs(Math.round(-bf))} owed` : `Brought forward: ${rs(Math.round(bf))} credit`]);
    }
    entries.forEach((a) => {
      const cash = a.mode === 'cash' ? Number(a.amount || 0) : (a.mode === 'both' ? Number(a.cash || 0) : 0);
      const acct = a.mode === 'account' ? Number(a.amount || 0) : (a.mode === 'both' ? Number(a.bank || 0) : 0);
      eCash += cash; eAcct += acct; gCount++;
      const d = a.date ? `${a.date.slice(8)}/${a.date.slice(5, 7)}/${a.date.slice(0, 4)}` : '-';
      body.push([nameCell(), d, cash ? rs(cash) : '', acct ? rs(acct) : '', a.remark || '']);
    });
    const totalOwed = -bf + eCash + eAcct;   // -bf = owed(+) when bf<0, credit(-) when bf>0; + advances given
    body.push([B('Subtotal'), '', B(rs(eCash)), B(rs(eAcct)), B('Total ' + owedStr(totalOwed))]);
    gCash += eCash; gAcct += eAcct; gOwed += totalOwed;
  }
  autoTable(doc, {
    startY: 36,
    head: [['Name', 'Date', 'Cash', 'Account', 'Remark / Balance']],
    body,
    theme: 'grid', styles: { fontSize: 9 }, headStyles: { fillColor: [192, 57, 43] },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
  });
  const y = (doc.lastAutoTable?.finalY || 40) + 10;
  doc.setFontSize(11);
  doc.text(`Advances given this month  -  Cash: ${rs(gCash)}     Account: ${rs(gAcct)}`, 14, y);
  doc.setFontSize(12);
  doc.text(`TOTAL OUTSTANDING (incl. brought forward): ${owedStr(gOwed)}`, 14, y + 7);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`${groups.length} worker(s) · ${gCount} advance entr${gCount === 1 ? 'y' : 'ies'} this month · up to ${asOfLabel}`, 14, y + 14);
  return doc;
}

// Problems-tab export: a clean one-document summary of every attendance problem so the owner
// can show/brief staff. data = { monthLabel, missed, short, late, highOt, resigns }.
export function problemsPdf(data) {
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();
  doc.setFontSize(16); doc.text('NSP ENTERPRISES', 14, 16);
  doc.setFontSize(12); doc.text('Attendance Problems Report  -  ' + (data.monthLabel || ''), 14, 24);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Generated ' + new Date().toLocaleString('en-IN'), 14, 30);
  doc.setTextColor(0);
  let y = 36;

  const section = (title, head, body, note) => {
    if (y > 250) { doc.addPage(); y = 18; }
    doc.setFontSize(11); doc.text(title, 14, y); y += 2;
    if (note) { doc.setFontSize(8); doc.setTextColor(120); doc.text(note, 14, y + 3); doc.setTextColor(0); y += 4; }
    if (!body.length) { doc.setFontSize(9); doc.setTextColor(110); doc.text('None - well done.', 16, y + 6); doc.setTextColor(0); y += 12; return; }
    autoTable(doc, { startY: y + 4, head: [head], body, theme: 'striped', styles: { fontSize: 9 }, headStyles: { fillColor: [192, 57, 43] }, margin: { left: 14, right: 14 } });
    y = (doc.lastAutoTable?.finalY || y) + 10;
  };

  section('Missed punches (forgot to punch IN or OUT)',
    ['Name', 'Date', 'Missing', 'Punched'],
    (data.missed || []).map(m => [m.name, m.date, 'no ' + String(m.which).toUpperCase(), m.otherTime || '-']),
    'Always punch BOTH in and out. A missed punch needs a manual correction.');

  section('Late arrivals (3 or more days)',
    ['Name', 'Dept', 'Late days', 'Dates'],
    (data.late || []).map(l => [l.name, l.dept || '-', String(l.count), (l.days || []).map(d => `${d.date.slice(8)}:${d.inT}`).join(', ')]),
    'Reach on time. Repeated lateness is cut by the machine rules.');

  section('Short days (worked less than the shift)',
    ['Name', 'Date', 'Worked', 'Required', 'In-Out'],
    (data.short || []).map(s => [s.name, s.date, s.hours + 'h', s.need + 'h', `${s.in}-${s.out}`]),
    'Complete full shift hours.');

  section('Unusually high overtime (please verify)',
    ['Name', 'OT hours', 'Per day', 'Days'],
    (data.highOt || []).map(h => [h.name, h.ot + 'h', h.perDay + 'h/day', String(h.days)]),
    'Flagged for the owner to confirm these are genuine before paying.');

  section('Absent the full month',
    ['Name', 'Month'],
    (data.resigns || []).map(e => [e.name || e.code, (e.resignPrompt && e.resignPrompt.month) || '-']),
    'Decide whether to keep or resign these staff.');

  doc.setFontSize(8); doc.setTextColor(120);
  doc.text('Please punch both times daily, arrive on time, and complete full hours. - Management', 14, doc.internal.pageSize.getHeight() - 10);
  return doc;
}

export async function sharePdf(doc, filename) {
  const blob = doc.output('blob');
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
