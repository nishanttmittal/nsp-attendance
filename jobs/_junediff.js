// NON-DESTRUCTIVE: backup att_attendance, pull the portal's reprocessed June summary, diff vs app. No writes.
const fs = require('path'); const P = require('path');
const { session, downloadMonthly } = require('./lib/realtime');
const { parseSummary, range } = require('./salaryData');
const { db } = require('./lib/firestore');
const fss = require('fs');
const pad = n => String(n).padStart(2,'0');
const fmt = d => `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
(async () => {
  const fdb = db();
  // 1) BACKUP current att_attendance
  const snap = await fdb.collection('att_attendance').get();
  const backup = snap.docs.map(d=>({code:d.id, ...d.data()}));
  const ts = new Date(Date.now()+5.5*3600*1000).toISOString().replace(/[:.]/g,'-').slice(0,19);
  const dir = __dirname+'/downloads'; fss.mkdirSync(dir,{recursive:true});
  const bpath = `${dir}/att_attendance-backup-${ts}.json`;
  fss.writeFileSync(bpath, JSON.stringify(backup,null,2));
  console.log(`BACKED UP ${backup.length} att_attendance docs -> ${bpath}\n`);
  const cur = {}; backup.forEach(d=>{ cur[d.code] = d.months?.['2026-06'] || null; });
  const salSnap = await fdb.collection('att_salary').get(); const nm={}; salSnap.forEach(d=>nm[d.id]=d.data().name||d.id);
  // 2) pull portal June summary
  const { first, to } = range(1);   // offset 1 = last month = June
  const { browser, page } = await session();
  let neu;
  try { const dl = await downloadMonthly(page, fmt(first), fmt(to), 'summary'); const f=P.join(dir,`salarydata_diff_2026-06.xls`); await dl.saveAs(f); neu = parseSummary(f); }
  finally { await browser.close(); }
  const byCode={}; neu.forEach(e=>byCode[e.code]=e);
  // 3) diff
  const drops=[], otChanges=[], newAbsent=[], other=[];
  for (const [code,e] of Object.entries(byCode)) {
    const c = cur[code];
    if (!c) continue;
    const dP = (e.presentDays||0)-(c.presentDays||0);
    const dA = (e.absentDays||0)-(c.absentDays||0);
    const dOT = Math.round(((e.otHrs||0)-(c.otHrs||0))*100)/100;
    if (dP<0 || dA>0) drops.push(`${code} ${(nm[code]||'').slice(0,20).padEnd(20)} present ${c.presentDays}->${e.presentDays} (${dP}) | absent ${c.absentDays}->${e.absentDays} (+${dA}) | OT ${c.otHrs}->${e.otHrs}`);
    else if (Math.abs(dOT)>=0.5) otChanges.push(`${code} ${(nm[code]||'').slice(0,20).padEnd(20)} OT ${c.otHrs} -> ${e.otHrs}  (${dOT>0?'+':''}${dOT}h) | present ${c.presentDays}->${e.presentDays}`);
    else if (dP!==0||dA!==0) other.push(`${code} ${(nm[code]||'').slice(0,20).padEnd(20)} present ${c.presentDays}->${e.presentDays} absent ${c.absentDays}->${e.absentDays}`);
  }
  console.log(`=== ⚠ PRESENT DROPPED / NEW ABSENT (corruption red flags): ${drops.length} ===`); drops.forEach(x=>console.log('  '+x));
  console.log(`\n=== OT CHANGED (>=0.5h): ${otChanges.length} ===`); otChanges.slice(0,60).forEach(x=>console.log('  '+x));
  console.log(`\n=== other present/absent shifts (no drop): ${other.length} ===`); other.slice(0,30).forEach(x=>console.log('  '+x));
  console.log(`\nTotals: ${Object.keys(byCode).length} workers in new portal data.`);
  process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
