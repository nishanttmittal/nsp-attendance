// Fill in workers the biometric portal created with PLACEHOLDER names (name = the code itself,
// dept DEMO, no salary) — they exist as punches but are invisible as people and would be paid
// NOTHING at settle. Owner supplies the real details; this script writes them.
//
//   DRY:   node jobs/addNewWorkers.js
//   APPLY: DRY_RUN=false node jobs/addNewWorkers.js
//   One batch only:  BATCH=2026-08-27 node jobs/addNewWorkers.js
//
// TABLE-DRIVEN ON PURPOSE — add a new batch to BATCHES below, never copy this file. (A near-copy of
// addDsgPolicy.js is what produced 6 of 8 Codex findings; addPolicy.js replaced it for the same reason.)
//
// LOAD-BEARING FIELDS
//   nameLocked / deptLocked : syncEmployees.js overwrites name+dept from the portal on EVERY run
//                             unless these are set — without them these revert to "00000114"/DEMO tonight.
//   joinDate                : an EMPTY joinDate makes attributeAdvanceMk() misfile an advance into a
//                             month the worker had not joined (the August-joiner bug, 2026-08-20).
//                             Set from the worker's FIRST REAL WORK DAY — never from the portal's DOJ,
//                             which is a 01/01/2025 default (see memory new-workers-aug-2026).
//   daily wagers            : pay reads emp.wage (NOT amount) x equivalentDays; needs type/wage/
//                             stdHours:10 (owner 2026-08-11 Rs 700 = 10 working hrs) + shift LOD +
//                             active:true, or lodGrace.js skips them and they fall back to the
//                             portal's under-reported workHrs. Portal side still needs
//                             PE_SHIFT=LOD PE_POLICY=LOD via pushEmployeeEdit.js.
const { db } = require('./lib/firestore');
const fs = require('fs');

const BATCHES = {
  // Owner 2026-08-20 01:03 — three unnamed workers filled in.
  // Rate CORRECTED 2026-08-27 21:36: owner — "last week ladies are also 8500". They were entered at
  // Rs 8,000; all three are Rs 8,500, same as the ladies named on 27-08. No month was locked, so the
  // raise applies cleanly to their whole first month. Applied via setWorkerPay.js (FORCE=true).
  '2026-08-20': [
    { code: '00000107', name: 'sajma',    dept: 'FITTING', gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500, joinDate: '2026-08-16' },
    { code: '00000109', name: 'shervano', dept: 'FITTING', gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500, joinDate: '2026-08-16' },
    { code: '00000113', name: 'kiran',    dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500, joinDate: '2026-08-17' },
  ],
  // Owner 2026-08-27 19:45 — nine more. joinDate = first REAL work day from att_punches for
  // 114/115/116/117 (their lone ~19:33 evening in-punch the day before is the enrolment test, the
  // same pattern seen on 60/62/63); the other five have no punches at all yet, so joinDate = the
  // day they were named. Gender for 120 masisurul confirmed Female by owner 2026-08-27 19:52 (gender blocks only
  // the PORTAL save, never pay); "ladies" in the owner's list is gender, not a department —
  // there is no LADIES FITTING dept on the portal or in Person.jsx DEPTS.
  '2026-08-27': [
    { code: '00000114', name: 'meen kumari',  dept: 'FITTING', gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-21' },
    { code: '00000115', name: 'anshika',      dept: 'FITTING', gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-21' },
    { code: '00000116', name: 'raghuraj',     dept: 'PRESS',   gender: 'Male',   shift: 'GEN', type: 'monthly', amount: 13500, joinDate: '2026-08-24' },
    { code: '00000117', name: 'dinesh loading', dept: 'LOADING', gender: 'Male', shift: 'LOD', type: 'daily',   wage: 700, stdHours: 10, joinDate: '2026-08-24' },
    { code: '00000118', name: 'kiran devi',   dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-27' },
    { code: '00000119', name: 'gajender',     dept: 'POWDER',  gender: 'Male',   shift: 'GEN', type: 'monthly', amount: 15000, joinDate: '2026-08-27' },
    { code: '00000120', name: 'masisurul',    dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-27' },
    { code: '00000121', name: 'amina',        dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-27' },
    { code: '00000123', name: 'kajal',        dept: 'FITTING', gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-08-27' },
  ],
  // Owner 2026-09-04 17:07 — four more named. All four are now in, but they went in in THREE passes,
  // because two were held back on purpose (see the notes under each):
  // 00000128 jenam: had NO att_salary doc at 17:07 because he was not yet enrolled on the biometric
  // machine — he was left OUT of the table entirely rather than added with a note, because pass 1
  // process.exit(1)s on a missing record and would have aborted the whole batch, taking 124 and 125
  // down with it. Owner enrolled him and said so at 18:05; `gh workflow run alerts.yml -f
  // task=sync-employees` pulled him in (roster 82 -> 83) and then this row applied. "ladies" in the
  // owner's line is GENDER, not a department — same call as the 27-08 batch.
  // 00000126 was already filled (sandeep kumar jitender welder) — that is the gap in the owner's list,
  // the same way 122 explained the gap on 27-08.
  // 00000127 kushal: rate withheld on 04-09 17:07 (owner typed no salary), then given as Rs 16,000 by
  // the owner at 18:05 — the SAME rate as his two Jitender peers 126 sandeep and 129 luvkush. Not a
  // guess, confirmed. dept WELDING puts him under isContractorPaid() so he is excluded from the
  // Salary tab's payables and appears on the owner-only Welders tab ([[welders-not-settled-...]]);
  // his contractor resolves from the name ("jitender"), the same way 126/129 do — no contractor field.
  // joinDate = 2026-09-04, the day they were named: none of the four has ANY punch doc in att_punches,
  // so there is no first-work-day to read. Same convention as the five punch-less workers on 27-08.
  // Gender for 125 shokin was left UNSET on 04-09 — the owner had not said, and Rs 10,500 (not the
  // Rs 8,500 ladies rate) was evidence but not proof. Owner confirmed "shokin -male" 2026-09-05 13:45,
  // so it is now set from his answer, not inferred. Gender blocks only the PORTAL save, never pay.
  '2026-09-04': [
    { code: '00000124', name: 'payal powder',  dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-09-04' },
    { code: '00000125', name: 'shokin fitting', dept: 'FITTING', gender: 'Male',   shift: 'GEN', type: 'monthly', amount: 10500, joinDate: '2026-09-04' },
    { code: '00000127', name: 'kushal jitender welder', dept: 'WELDING', gender: 'Male', shift: 'GEN', type: 'monthly', amount: 16000, joinDate: '2026-09-04' },
    { code: '00000128', name: 'jenam powder',  dept: 'POWDER',  gender: 'Female', shift: 'GEN', type: 'monthly', amount: 8500,  joinDate: '2026-09-04' },
  ],
};

const BATCH = process.env.BATCH || Object.keys(BATCHES).sort().pop();
const WORKERS = BATCHES[BATCH];
if (!WORKERS) { console.error(`no batch "${BATCH}". Known: ${Object.keys(BATCHES).join(', ')}`); process.exit(1); }
const DRY = process.env.DRY_RUN !== 'false';
const FORCE = process.env.FORCE === 'true';

const rateOf = (w) => (w.type === 'daily' ? w.wage : w.amount);

(async () => {
  console.log(`batch ${BATCH} — ${WORKERS.length} worker(s)${DRY ? '  [DRY]' : '  [APPLY]'}\n`);
  const before = {};
  const patches = [];

  // --- pass 1: read + guard everything BEFORE writing anything ---
  for (const w of WORKERS) {
    const snap = await db().collection('att_salary').doc(w.code).get();
    const e = snap.data() || null;
    before[w.code] = e;
    if (!snap.exists) { console.error(`ERROR ${w.code}: no att_salary record — the portal has not enrolled them yet. Nothing written.`); process.exit(1); }

    const locked = Object.entries(e.months || {}).filter(([, m]) => m && (m.locked || m.payment)).map(([k]) => k);
    if (locked.length) { console.error(`ERROR ${w.code} ${e.name}: month(s) already locked/paid (${locked.join(', ')}) — that payment is frozen around the OLD rate. Nothing written.`); process.exit(1); }

    const cur = e.type === 'daily' ? e.wage : e.amount;
    if (e.type && Number(cur) > 0 && Number(cur) !== Number(rateOf(w)) && !FORCE) { console.error(`ERROR ${w.code} ${e.name}: already has ${e.type} rate ${cur}; this would silently re-rate to ${rateOf(w)}. Re-run with FORCE=true if deliberate. Nothing written.`); process.exit(1); }

    const r = Number(rateOf(w));
    if (!Number.isFinite(r) || r <= 0) { console.error(`ERROR ${w.code}: bad rate ${rateOf(w)}. Nothing written.`); process.exit(1); }
    if (w.type === 'daily' && r > 10000) { console.error(`ERROR ${w.code}: daily wage ${r} looks like a slipped digit. Nothing written.`); process.exit(1); }
    if (w.type === 'monthly' && r > 500000) { console.error(`ERROR ${w.code}: monthly amount ${r} looks like a slipped digit. Nothing written.`); process.exit(1); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.joinDate || '')) { console.error(`ERROR ${w.code}: joinDate must be YYYY-MM-DD (got "${w.joinDate}") — an empty one misfiles advances. Nothing written.`); process.exit(1); }

    const patch = {
      code: w.code, name: w.name, nameLocked: true, dept: w.dept, deptLocked: true,
      shift: w.shift, type: w.type, active: true, joinDate: w.joinDate,
    };
    if (w.gender) patch.gender = w.gender;
    if (w.type === 'daily') { patch.wage = w.wage; patch.stdHours = w.stdHours || 10; }
    else patch.amount = w.amount;
    patches.push({ w, e, patch });
  }

  // --- pass 2: show, then write ---
  for (const { w, e, patch } of patches) {
    if (DRY) {
      console.log(`[DRY] ${w.code}  was: name=${e.name} dept=${e.dept} shift=${e.shift} type=${e.type ?? '(unset)'} rate=${(e.type === 'daily' ? e.wage : e.amount) ?? '(unset)'}`);
      console.log(`             now: ${JSON.stringify(patch)}`);
      continue;
    }
    await db().collection('att_salary').doc(w.code).set(patch, { merge: true });
    const label = w.type === 'daily' ? `Rs ${w.wage}/day (${w.stdHours || 10}h basis)` : `Rs ${w.amount}/mo`;
    console.log(`${w.code} ${w.name.padEnd(16)} ${w.dept.padEnd(8)} ${(w.gender || 'gender?').padEnd(7)} ${w.shift.padEnd(4)} ${label.padEnd(24)} joined ${w.joinDate}  OK`);
  }

  if (!DRY) {
    const f = require('path').resolve(__dirname, 'rules_backup', `new-workers-before-${BATCH}-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(before, null, 2));
    console.log('\nbackup of previous values:', f);
    // read back — a write that "succeeded" but stored nothing is the failure mode that matters
    for (const { w } of patches) {
      const r = (await db().collection('att_salary').doc(w.code).get()).data() || {};
      const got = r.type === 'daily' ? r.wage : r.amount;
      const ok = r.name === w.name && r.dept === w.dept && r.nameLocked === true && r.deptLocked === true
        && r.joinDate === w.joinDate && Number(got) === Number(rateOf(w)) && r.active === true;
      console.log(`  readback ${w.code} ${ok ? 'OK' : 'MISMATCH -> ' + JSON.stringify(r)}`);
    }
  }
  console.log(DRY ? '\nDRY run — nothing written. Re-run with DRY_RUN=false to apply.' : '\nAPPLIED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
