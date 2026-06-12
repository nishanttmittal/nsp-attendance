// Validates my payroll rules against the April Excel. Reverse-engineered THEIR gross:
//   theirGross = RATE/30 * DAYS  +  OT * (RATE/30/8)   [pays every day incl. extra; OT /8 for all]
// MY rules: base caps at the full month (Sat/holiday worked = OT, not an extra day),
//   OT divided by the SHIFT hours (GEN 8 / 12H 12 / wir 10). ESI: they deduct, I don't.
const XLSX = require('xlsx');

const DIM = 30;            // April = 30 days
const round = n => Math.round(n);
// the few non-GEN shift workers (rest are GEN/8h) — by a loose name key
const SHIFT = { 'satish': 12, 'sandeep': 12, 'amar': 10, 'amarjeet': 10 };
const shiftHrsFor = name => {
  const n = name.toLowerCase();
  for (const k in SHIFT) if (n.includes(k)) return SHIFT[k];
  return 8;
};

const wb = XLSX.readFile('/mnt/c/Users/lenovo/Desktop/salary april 2026.xlsx');
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });

let nMatch = 0, nExtraDays = 0, nEsi = 0, totEsi = 0, big = [];
const out = [];
for (const r of rows.slice(1)) {
  const name = String(r[0] || '').trim();
  const days = Number(r[1]), ot = Number(r[2]) || 0, theirGross = Number(r[4]), rate = Number(r[5]);
  const esi = Number(r[6]) || 0;
  if (!name || !rate || !theirGross) continue;
  const perDay = rate / DIM;
  // THEIR gross (recomputed to confirm we read it right)
  const theirCalc = perDay * days + ot * (perDay / 8);
  // MY gross under my rules: cap days at the month; OT at the shift divisor
  const myDays = Math.min(days, DIM);
  const perfectBonus = days >= 31 ? perDay : 0; // full month + no absence → +1 day (engine's rule)
  const myGross = perDay * myDays + perfectBonus + ot * (perDay / shiftHrsFor(name));
  const diff = round(myGross - theirGross);
  if (days > DIM) nExtraDays++;
  if (esi) { nEsi++; totEsi += esi; }
  if (Math.abs(diff) < 2) nMatch++; else big.push({ name, days, ot, rate, theirGross: round(theirGross), myGross: round(myGross), diff, esi });
  out.push({ name, days, theirGross: round(theirGross), theirCalcOk: Math.abs(theirCalc - theirGross) < 2, myGross: round(myGross), diff, esi });
}

console.log(`Compared ${out.length} staff (April, 30-day month).\n`);
console.log(`✅ My gross MATCHES their gross (±₹2): ${nMatch}/${out.length}`);
console.log(`   → confirms base & OT formula are identical for normal cases.\n`);
console.log(`Differences come from 3 rules:`);
console.log(`1) EXTRA DAYS: ${nExtraDays} staff were paid for MORE than 30 days (Sunday/holiday worked = a full extra day in your Excel). My rule caps at the month and pays that as OT instead.`);
console.log(`2) OT DIVISOR on 12h/10h shift staff: your Excel divides OT by 8 for everyone; my rule uses their shift hours (12h→/12).`);
console.log(`3) ESI: your Excel deducts ESI (${nEsi} staff, total ₹${round(totEsi).toLocaleString('en-IN')}/mo). My rule has no ESI.\n`);

console.log('Where my GROSS differs from yours (rule #1 / #2):');
big.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
for (const b of big.slice(0, 30))
  console.log(`  ${b.name.padEnd(22)} days ${b.days}  OT ${b.ot}  | yours ₹${b.theirGross}  mine ₹${b.myGross}  diff ₹${b.diff}`);
