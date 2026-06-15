// Build the "punches to ADD" list for the vendor = the owner's genuine May missed-punch
// corrections (one employee + one date each), so they can be inserted correctly on the machine.
// Writes Desktop "may punches to add.xlsx". Names mapped locally (no extra Firestore reads).
const path = require('path');
const XLSX = require('xlsx');
const { parseSummary } = require('./salaryData');
const { db } = require('./lib/firestore');

const OUT = '/mnt/c/Users/lenovo/Desktop/may punches to add.xlsx';
const ddmm = s => String(s || '').trim();

(async () => {
  // code -> name from the local clean summary (no Firestore read)
  const name = {}; try { parseSummary(path.resolve(__dirname, 'downloads/may_final_rules.xls')).forEach(e => { name[e.code] = e.name; }); } catch {}

  const snap = await db().collection('att_job_requests').where('type', '==', 'manual_punch').get();
  const seen = new Set(); const rows = [];
  snap.forEach(d => {
    const p = d.data().payload || {}; if (!p.emp || !p.date) return;
    const key = p.emp + '|' + p.date; if (seen.has(key)) return; seen.add(key);
    rows.push({ code: p.emp, name: name[p.emp] || '', date: ddmm(p.date), in: p.in || '', out: p.out || '', type: /half/i.test(p.remark || '') ? 'half day' : 'full day' });
  });
  rows.sort((a, b) => {
    const da = a.date.split('/').reverse().join(''), db_ = b.date.split('/').reverse().join('');
    return da.localeCompare(db_) || a.code.localeCompare(b.code);
  });

  console.log(`Genuine corrections to ADD: ${rows.length} (one employee + date each)`);
  const aoa = [['Emp Code', 'Employee Name', 'Date (dd/mm/yyyy)', 'IN', 'OUT', 'Type']];
  rows.forEach(r => aoa.push([r.code, r.name, r.date, r.in, r.out, r.type]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Punches To Add');
  try { XLSX.writeFile(wb, OUT); console.log('Saved → ' + OUT); }
  catch (e) { const alt = path.resolve(__dirname, 'downloads/may_punches_to_add.xlsx'); XLSX.writeFile(wb, alt); console.log('Saved → ' + alt); }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
