// Re-apply the owner's genuine May missed-punch corrections to att_attendance (the salary source),
// on top of the restored clean baseline. Each manual_punch job = one employee + one date the owner
// said should be present. We add a present-day ONLY where the clean baseline (inout_2026-05.xls)
// shows that day was ABSENT (both NA) — so we don't double-count days already present.
//   full day -> +1 present / -1 absent ; half day -> +0.5 / -0.5. Backs up first. APPLY=false=preview.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { db } = require('./lib/firestore');

const CLEAN = path.resolve(__dirname, 'downloads/inout_2026-05.xls');   // June-13 clean in-out
const MK = '2026-05';
const APPLY = process.env.APPLY !== 'false';
const isNA = s => !/\d/.test(String(s));
const toYMD = s => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s)) || /(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if (!m) return ''; return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };
const ddmmToYMD = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s)); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

(async () => {
  const fdb = db();

  // clean baseline: code|ymd -> present?
  const cleanPresent = new Set();
  XLSX.utils.sheet_to_json(XLSX.readFile(CLEAN).Sheets.Sheet1, { header: 1, defval: '' }).slice(1).forEach(r => {
    const code = String(r[0] || '').trim(); const ymd = toYMD(r[1]); if (!code || !ymd) return;
    if (!(isNA(r[2]) && isNA(r[3]))) cleanPresent.add(code + '|' + ymd);
  });

  // the genuine corrections = manual_punch job payloads (one employee+date each)
  const jobs = await fdb.collection('att_job_requests').where('type', '==', 'manual_punch').get();
  const seen = new Set(); const delta = {};   // code -> days to add
  const detail = [];
  jobs.forEach(d => {
    const p = d.data().payload || {}; if (!p.emp || !p.date) return;
    const ymd = ddmmToYMD(p.date); if (!ymd || !ymd.startsWith(MK)) return;
    const key = p.emp + '|' + ymd; if (seen.has(key)) return; seen.add(key);
    if (cleanPresent.has(key)) { detail.push(`${p.emp} ${ymd}: already present in clean — skip`); return; }
    const half = /half/i.test(p.remark || '');
    const add = half ? 0.5 : 1;
    delta[p.emp] = (delta[p.emp] || 0) + add;
    detail.push(`${p.emp} ${ymd}: +${add} (${half ? 'half' : 'full'})`);
  });

  console.log(`Corrections considered: ${seen.size} | employees getting present-days added: ${Object.keys(delta).length}`);
  detail.slice(0, 60).forEach(d => console.log('  ' + d));
  const totalDays = Object.values(delta).reduce((a, b) => a + b, 0);
  console.log(`Total present-days to add: ${totalDays}`);

  if (!APPLY) { console.log('PREVIEW only (APPLY=false).'); process.exit(0); }

  // backup + apply to att_attendance.months[MK]
  const backup = {};
  for (const code of Object.keys(delta)) {
    const ref = fdb.collection('att_attendance').doc(code);
    const snap = await ref.get(); if (!snap.exists) { console.log('  no att doc for ' + code); continue; }
    const months = { ...(snap.data().months || {}) };
    const m = months[MK]; if (!m) { console.log('  no May data for ' + code); continue; }
    backup[code] = { presentDays: m.presentDays, absentDays: m.absentDays };
    const add = delta[code];
    m.presentDays = +( (m.presentDays || 0) + add ).toFixed(2);
    m.absentDays = +Math.max(0, (m.absentDays || 0) - add).toFixed(2);
    m.correctionsApplied = add;
    months[MK] = m;
    await ref.set({ months }, { merge: true });
  }
  fs.writeFileSync(path.resolve(__dirname, `downloads/backup_corrections_${Date.now()}.json`), JSON.stringify(backup, null, 2));
  console.log(`Applied to ${Object.keys(backup).length} employees (backup saved).`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
