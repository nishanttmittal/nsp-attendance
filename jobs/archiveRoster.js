// Roster cleanup (owner 2026-07-09): archive-then-delete left/inactive + ghost employee records
// so the app shows only current staff. SAFE: snapshots att_salary + att_attendance + att_punches
// to att_archive/{code} BEFORE deleting (fully recoverable). DRY_RUN default. Reads /tmp/to_remove.json.
const fs = require('fs');
const { db } = require('./lib/firestore');
const DRY = process.env.DRY_RUN !== 'false';
const codes = JSON.parse(fs.readFileSync('/tmp/to_remove.json', 'utf8'));

(async () => {
  const fdb = db();
  let done = 0;
  for (const code of codes) {
    const [sal, att, pun] = await Promise.all([
      fdb.collection('att_salary').doc(code).get(),
      fdb.collection('att_attendance').doc(code).get(),
      fdb.collection('att_punches').doc(code).get(),
    ]);
    const snapshot = {
      code, archivedAt: new Date().toISOString(), reason: 'roster-cleanup 2026-07-09 (inactive/ghost)',
      salary: sal.exists ? sal.data() : null,
      attendance: att.exists ? att.data() : null,
      punches: pun.exists ? pun.data() : null,
    };
    const name = (snapshot.salary && snapshot.salary.name) || '(none)';
    if (DRY) { console.log(`DRY would archive+delete ${code} — ${name}`); continue; }
    await fdb.collection('att_archive').doc('roster_' + code).set(snapshot);   // recoverable copy
    // delete only after the archive write succeeded
    await Promise.all([
      sal.exists ? fdb.collection('att_salary').doc(code).delete() : null,
      att.exists ? fdb.collection('att_attendance').doc(code).delete() : null,
      pun.exists ? fdb.collection('att_punches').doc(code).delete() : null,
    ].filter(Boolean));
    console.log(`archived+deleted ${code} — ${name}`);
    done++;
  }
  console.log(DRY ? `\n=== DRY (nothing changed) — ${codes.length} records would be removed ===`
                  : `\n=== DONE — archived+deleted ${done} records (recoverable in att_archive/roster_*) ===`);
})().catch(e => console.log('ERR', e.message));
