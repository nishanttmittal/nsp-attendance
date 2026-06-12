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
  const body = [
    ['Base', rs(pay.base)],
    ['Overtime', rs(pay.otPay)],
    ['Attendance bonus', rs(pay.perfectBonus)],
    ['Bonus', rs(pay.bonus)],
    ['Fine', '- ' + rs(pay.fines)],
    ['Loan installment', '- ' + rs(pay.loanInstallment)],
    ['Advance recovered', '- ' + rs(pay.advanceRecovered)],
  ];
  autoTable(doc, { startY: 58, head: [['Component', 'Amount']], body, theme: 'grid', styles: { fontSize: 10 } });
  let y = (doc.lastAutoTable?.finalY || 110) + 10;
  doc.setFontSize(14); doc.text('NET PAY:  ' + rs(pay.net), 14, y);
  if (pay.advanceBalanceCarried > 0) { y += 8; doc.setFontSize(9); doc.text('Advance balance carried forward: ' + rs(pay.advanceBalanceCarried), 14, y); }
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
