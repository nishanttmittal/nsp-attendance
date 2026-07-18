// Data layer. Shape matches the jobs' getState.gatherState() output.
// Reads Firestore doc `daily_stats/today` when Firebase is configured; otherwise mock.
import { isConfigured, db } from './firebase';
import { doc, setDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getDoc, getDocs } from './readmeter';   // metered reads → usage_reads/{date} (quota diagnosis)

const MOCK = {
  at: new Date().toISOString(),
  counts: { totalEmployees: 92, totalPresent: 56, totalAbsent: 36, totalLate: 5 },
  perDept: { FITTING: 15, WELDING: 13, PRESS: 11, POWDER: 11, 'TOOL ROOM': 3, DEMO: 2, HELPER: 1 },
  deptRatio: {
    FITTING: { present: 15, total: 18, pct: 83 }, WELDING: { present: 13, total: 30, pct: 43 },
    PRESS: { present: 10, total: 17, pct: 59 }, POWDER: { present: 11, total: 17, pct: 65 },
    'TOOL ROOM': { present: 3, total: 3, pct: 100 }, DEMO: { present: 2, total: 4, pct: 50 },
    HELPER: { present: 1, total: 1, pct: 100 }, FRAME: { present: 0, total: 2, pct: 0 },
  },
  stillInCount: 18,
  mealHeadcount: 14,
  mealExcludes: 'WELDING',
  lateCount: 5,
  late: [
    { code: '00000112', name: 'Chandrashekhar fiitting', dept: 'FITTING', inT: '09:31', status: 'P-LT' },
    { code: '00000255', name: 'sandeep supervisor', dept: 'DEMO', inT: '10:07', status: 'P-LT' },
    { code: '00000080', name: 'poonam fitting', dept: 'FITTING', inT: '09:16', status: 'P-LT' },
  ],
  absentCount: 3,
  absent: [
    { code: '00000048', name: 'Ahjaj frame', dept: 'FRAME' },
    { code: '00000024', name: 'radhey shyam press', dept: 'PRESS' },
    { code: '1', name: 'Nishant Mittal', dept: 'DEMO' },
  ],
  longAbsence: [
    { code: '00000178', name: 'kushal welder', absentDays: 8 },
    { code: '00000350', name: 'amit jitender welder', absentDays: 6 },
    { code: '00000262', name: 'prakash helper press', absentDays: 5 },
  ],
  presentRows: [
    { code: '00000018', name: 'sanjay pathak', dept: 'TOOL ROOM', inT: '09:23', outT: '' },
    { code: '00000003', name: 'naveen press', dept: 'PRESS', inT: '09:11', outT: '' },
    { code: '00000080', name: 'poonam fitting', dept: 'FITTING', inT: '09:16', outT: '' },
  ],
  _mock: true,
};

export async function getDailyState() {
  if (!isConfigured || !db) return MOCK;
  const snap = await getDoc(doc(db, 'att_daily_stats', 'today'));
  return snap.exists() ? snap.data() : MOCK;
}

// ---- Salary store: Firestore att_salary/{code} when configured; localStorage fallback in preview ----
// One doc per employee: { code, name, dept, shift, active, type, amount|wage, joinDate, increments[], advances[], months{} }
const SAL_KEY = 'nsp_salary_v1';
const loadSal = () => { try { return JSON.parse(localStorage.getItem(SAL_KEY)) || {}; } catch { return {}; } };
const saveSal = (o) => localStorage.setItem(SAL_KEY, JSON.stringify(o));
const SEED = { // preview-only sample
  '00000018': { code: '00000018', name: 'sanjay pathak', dept: 'TOOL ROOM', shift: 'GEN' },
  '00000061': { code: '00000061', name: 'satish guard', dept: 'DEMO', shift: '12H' },
};
const MOCK_ATT = {
  '00000018': { presentDays: 24, absentDays: 1, otHrs: 46.5, lateHrs: 1.5, earlyHrs: 0.5 },
  '00000061': { presentDays: 25, absentDays: 0, otHrs: 55, lateHrs: 0, earlyHrs: 0 },
};
const blankEmp = (code) => ({ code, increments: [], advances: [], months: {}, attendanceLog: {} });
export const DAILY_STD = 11; // app-only daily-wager standard hours/day

// Attendance for an app-only daily-wager, derived from their manual hours log.
export function dailyAtt(emp, month) {
  const log = (emp.attendanceLog && emp.attendanceLog[month]) || [];
  const hoursTotal = log.reduce((s, d) => s + Number(d.hours || 0), 0);
  const equivalentDays = log.reduce((s, d) => s + Math.min(Number(d.hours || 0), DAILY_STD) / DAILY_STD, 0);
  return { presentDays: log.length, equivalentDays: Math.round(equivalentDays * 100) / 100, hoursTotal, otHrs: 0, lateHrs: 0, earlyHrs: 0, absentDays: 0 };
}
// Salary-free roster (att_meta/roster) — readable by managers for name pickers.
export async function loadRoster() {
  if (!isConfigured || !db) return [{ code: '00000018', name: 'sanjay pathak', dept: 'TOOL ROOM' }, { code: '00000003', name: 'naveen press', dept: 'PRESS' }];
  const s = await getDoc(doc(db, 'att_meta', 'roster'));
  return s.exists() ? (s.data().employees || []) : [];
}
// Managers / access (att_users keyed by lowercased email)
export async function listManagers() {
  if (!isConfigured || !db) return [];
  const snap = await getDocs(collection(db, 'att_users'));
  return snap.docs.filter(d => d.id !== '_config').map(d => ({ email: d.id, ...d.data() }));
}

// ---- Action password (guards resign/unlock). SHA-256 hash in att_users/_config. ----
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function setActionPassword(pw) {
  if (!isConfigured || !db) return;
  await setDoc(doc(db, 'att_users', '_config'), { actionPwHash: await sha256(pw) }, { merge: true });
}
// returns true/false, or 'unset' when no password has been set yet
export async function checkActionPassword(pw) {
  if (!isConfigured || !db) return true;
  const s = await getDoc(doc(db, 'att_users', '_config'));
  const hash = s.exists() ? s.data().actionPwHash : null;
  if (!hash) return 'unset';
  return (await sha256(pw)) === hash;
}
export async function addManager(email, telegramChatId, role = 'manager') {
  if (!isConfigured || !db) return;
  await setDoc(doc(db, 'att_users', email.toLowerCase()), { role, telegramChatId: telegramChatId || '', addedAt: new Date().toISOString() }, { merge: true });
}
export async function removeManager(email) {
  if (!isConfigured || !db) return;
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'att_users', email.toLowerCase()));
}
// Manager advance → job queue (worker applies with admin rights so salary stays admin-only)
export async function queueAdvance(code, advance, by) {
  // Stable id (fix 2026-07-18): the worker dedupes on it, so a cloud run killed after saving and
  // retried can never record the same advance twice (mark_paid already had this via payId).
  const id = advance.id || ('adv-' + (advance.date || '') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  return queueJob('add_advance', { code, advance: { ...advance, id } }, by);
}

// All employees' monthly attendance at once (for the salary register PDF).
export async function loadAllAttendance() {
  if (!isConfigured || !db) return {};
  const snap = await getDocs(collection(db, 'att_attendance'));
  return Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
}

// Raw daily in/out punches (att_punches) — feeds the app-side attendance engine (Shadow view).
export async function loadAllPunches() {
  if (!isConfigured || !db) return {};
  const snap = await getDocs(collection(db, 'att_punches'));
  return Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
}
export async function loadPunchDoc(code) {
  if (!isConfigured || !db) return null;
  const d = await getDoc(doc(db, 'att_punches', code));
  return d.exists() ? d.data() : null;
}
export async function addDailyHours(code, month, entry) {
  const e = await loadEmployee(code);
  const log = { ...(e.attendanceLog || {}) };
  log[month] = [...(log[month] || []), entry];
  await saveEmployee(code, { attendanceLog: log });
}
export const monthData = (emp, month) =>
  (emp.months && emp.months[month]) || { advanceRecover: 0, fine: 0, loanInstallment: 0, advanceBalanceIn: 0, locked: false };

export async function loadEmployees(includeResigned = false) {
  let list;
  if (isConfigured && db) {
    const snap = await getDocs(collection(db, 'att_salary'));
    list = snap.docs.map(d => ({ ...blankEmp(d.id), ...d.data(), code: d.id }));
  } else {
    const store = { ...SEED, ...loadSal() };
    list = Object.entries(store).map(([code, v]) => ({ ...blankEmp(code), ...v, code }));
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return includeResigned ? list : list.filter(e => e.active !== false);
}

export async function loadEmployee(code) {
  if (isConfigured && db) {
    const s = await getDoc(doc(db, 'att_salary', code));
    return { ...blankEmp(code), ...(s.exists() ? s.data() : {}), code };
  }
  const store = { ...SEED, ...loadSal() };
  return { ...blankEmp(code), ...(store[code] || {}), code };
}

// App-only self-punch staff (Radhey/Dinesh/Munnilal): captured in/out times (att_punch) +
// this-month totals. Drivers: an OUT after midnight is stitched to the prior day's IN, and
// an OUT past their cutoff (e.g. 1 AM) counts as a full day. A manual override
// (att_salary.override[month] = {days, hours, ot}) wins over the punch data for salary.
const nextDate = (ymd) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export async function loadSelfPunchStaff() {
  if (!isConfigured || !db) return [];
  const snap = await getDocs(collection(db, 'att_salary'));
  const staff = snap.docs.map(d => ({ code: d.id, ...d.data() })).filter(e => e.selfPunch && e.active !== false);
  const month = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7); // IST YYYY-MM
  const toMin = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const out = [];
  for (const e of staff) {
    const pd = await getDoc(doc(db, 'att_punch', e.code));
    const days = (pd.exists() && pd.data().days) || {};
    const std = Number(e.standardHours) || 11;
    const cutoff = toMin(e.overnightAfter || '01:00');
    const dates = Object.keys(days).filter(dt => dt.startsWith(month)).sort();
    const used = new Set();
    const rows = [];
    for (const date of dates) {
      if (used.has(date)) continue;
      const t = days[date];
      let inT = t.in || '', outT = t.out || '', overnight = false, fullDay = false;
      if (e.isDriver && inT && !outT) {                 // driver came back after midnight?
        const nd = nextDate(date), nx = days[nd];
        if (nx && nx.out && !nx.in) { outT = nx.out; used.add(nd); overnight = true; }
      }
      const i = toMin(inT), o = toMin(outT);
      let hours = null;
      if (i != null && o != null) {
        let mins = o - i; if (mins < 0 || overnight) mins = (o + 1440) - i;
        hours = +(mins / 60).toFixed(1);
        if (e.isDriver && overnight && o >= cutoff) fullDay = true; // out past ~1 AM = full day
      }
      rows.push({ date, in: inT, out: outT, hours, overnight, fullDay });
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));

    const autoPresent = rows.length;
    const autoHours = +rows.reduce((s, r) => s + (r.hours || 0), 0).toFixed(1);
    const autoOt = +rows.reduce((s, r) => s + (r.hours != null ? Math.max(0, r.hours - std) : 0), 0).toFixed(1);
    const ov = (e.override && e.override[month]) || null;
    const ot = ov ? Number(ov.ot != null ? ov.ot : Math.max(0, (Number(ov.hours) || 0) - (Number(ov.days) || 0) * std)) : autoOt;
    out.push({
      code: e.code, name: e.name, dept: e.dept, unit: e.unit, amount: e.amount, standardHours: std,
      dutyStart: e.dutyStart, dutyEnd: e.dutyEnd, isDriver: !!e.isDriver, rows, month,
      present: ov ? Number(ov.days) : autoPresent,
      totalHours: ov ? Number(ov.hours) : autoHours,
      ot: +Number(ot).toFixed(1), manual: !!ov,
      autoPresent, autoHours, autoOt,
    });
  }
  return out;
}

export async function saveEmployee(code, patch) {
  if (isConfigured && db) { await setDoc(doc(db, 'att_salary', code), patch, { merge: true }); return; }
  const store = loadSal(); store[code] = { ...(store[code] || {}), ...patch }; saveSal(store);
}
// Owner picks which OT to pay (portal vs app-computed) for a worker's month. Deep-merges into months[mk].
export async function setOtSource(code, mk, source) {
  return saveEmployee(code, { months: { [mk]: { otSource: source === 'app' ? 'app' : 'portal' } } });
}

// Save a name/dept correction in the app AND push it to the Realtime machine (owner rule
// 2026-06-14). Locks the field so machine-sync won't revert it. App-only staff aren't on the
// machine, so they only save locally. `name`/`dept` are optional — push only what changed.
export async function editNameDept(code, { name, dept }, by) {
  const emp = await loadEmployee(code);
  const patch = {};
  if (name != null && name !== emp.name) { patch.name = name; patch.nameLocked = true; }
  if (dept != null && dept !== emp.dept) { patch.dept = dept; patch.deptLocked = true; }
  if (!Object.keys(patch).length) return { changed: false };
  await saveEmployee(code, patch);
  const onMachine = !emp.appOnly && emp.onMachine !== false;
  if (onMachine) {
    await queueJob('push_employee_edit', { code, ...(patch.name ? { name } : {}), ...(patch.dept ? { dept } : {}) }, by);
  }
  return { changed: true, pushed: onMachine };
}

// Late-arrival penalty tasks: employees with >=4 late marks in the month (att_late_log) →
// owner approves 25% (¼ day) / 50% (½ day) or rejects. Decision stored in months[mk].
const LATE_THRESHOLD = 4;
const _penDecision = d => ({ status: d?.status || 'pending', fraction: Number(d?.fraction) || 0 });

// Per employee with >=4 late marks: one task for the first 4 ("base"), then ONE SEPARATE task
// per extra late day (5th, 6th, …) — each approved 25%/50% or rejected independently.
export async function loadLatePenaltyTasks(month) {
  const mk = month || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  if (!isConfigured || !db) return { month: mk, staff: [] };
  const logSnap = await getDoc(doc(db, 'att_late_log', mk));
  const byCode = (logSnap.exists() && logSnap.data().byCode) || {};
  const salSnap = await getDocs(collection(db, 'att_salary'));
  const sal = {}; salSnap.forEach(d => { sal[d.id] = d.data(); });
  const staff = [];
  for (const [code, e] of Object.entries(byCode)) {
    const lateDays = Object.entries(e.days || {}).map(([date, inT]) => ({ date, inT })).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (lateDays.length < LATE_THRESHOLD) continue;
    const pen = (sal[code]?.months?.[mk]?.latePenalties) || {};
    const items = [
      { key: 'base', label: 'First 4 late marks', dates: lateDays.slice(0, 4).map(d => d.date), inT: '', ..._penDecision(pen.base) },
      ...lateDays.slice(4).map((d, i) => ({ key: d.date, label: `Late day #${i + 5}`, dates: [d.date], inT: d.inT, ..._penDecision(pen[d.date]) })),
    ];
    const totalDays = items.reduce((s, it) => s + (it.status === 'approved' ? it.fraction : 0), 0);
    staff.push({ code, name: sal[code]?.name || e.name || code, dept: e.dept || sal[code]?.dept || '', count: lateDays.length, items, totalDays });
  }
  staff.sort((a, b) => b.count - a.count);
  return { month: mk, staff };
}
// Missed punches this month (att_missed_punch, from the in-out report scan) — for the Punch tab.
export async function loadMissedPunches(month) {
  const mk = month || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  if (!isConfigured || !db) return [];
  const snap = await getDoc(doc(db, 'att_missed_punch', mk));
  return (snap.exists() && snap.data().entries) || [];
}
export const istMonth = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);

// Missed punches + short-hours days together (one scan doc per month).
export async function loadMissedDoc(month) {
  const mk = month || istMonth();
  if (!isConfigured || !db) return { entries: [], shortHours: [] };
  const snap = await getDoc(doc(db, 'att_missed_punch', mk));
  const d = snap.exists() ? snap.data() : {};
  return { entries: d.entries || [], shortHours: d.shortHours || [] };
}
// Ask the worker to (re)scan a chosen month's missed punches + short days + late marks
// from Realtime → att_missed_punch/{month} (+ att_late_log/{month}).
export async function queueScanMissed(month, by) {
  return queueJob('scan_missed', { month }, by);
}
// Ask the worker to REPROCESS attendance on Realtime for a date range (dd/MM/yyyy, all employees).
// Recalculation only — pulls corrected present/OT/late from the existing punches; deletes nothing.
export async function queueReprocess(from, to, by) {
  return queueJob('reprocess_period', { from, to }, by);
}
// "Leave as is" decision for a missed punch — stored on att_salary so the daily rescan
// (which overwrites the scan doc) can't lose it.
export async function leaveMissedPunch(code, month, date) {
  const e = await loadEmployee(code);
  const ml = { ...(e.missedLeave || {}) };
  ml[month] = [...new Set([...(ml[month] || []), date])];
  await saveEmployee(code, { missedLeave: ml });
}
// Everyone with >= minDays late marks this month (view-only list; machine applies the cuts).
export async function loadLateList(month, minDays = 3) {
  const mk = month || istMonth();
  if (!isConfigured || !db) return [];
  const logSnap = await getDoc(doc(db, 'att_late_log', mk));
  const byCode = (logSnap.exists() && logSnap.data().byCode) || {};
  const out = [];
  for (const [code, e] of Object.entries(byCode)) {
    const days = Object.entries(e.days || {}).map(([date, inT]) => ({ date, inT })).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (days.length >= minDays) out.push({ code, name: e.name || code, dept: e.dept || '', count: days.length, days });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}
// ---- Salary approval flow (owner ticks → manager pays) ----
// Tick: freeze this month's numbers on the employee doc (worker mirrors them into the
// manager-readable payout doc att_meta/payout_{mk} on its next cycle).
export async function approveSalary(code, month, pay, by) {
  await saveMonth(code, month, {
    approved: { by, at: new Date().toISOString() },
    approvedNet: pay.net,
    advanceRecover: pay.advanceRecovered,
    approvedCarry: pay.advanceBalanceCarried,
  });
}
export async function unapproveSalary(code, month) {
  await saveMonth(code, month, { approved: null, approvedNet: null, approvedCarry: null });
}
// Salary Hold: stop a person's pay on purpose, with a mandatory reason. A held month
// can't be ticked/approved until released.
export async function holdSalary(code, month, reason, by) {
  await saveMonth(code, month, { hold: { reason, by, at: new Date().toISOString() }, approved: null, approvedNet: null });
}
export async function releaseSalary(code, month, by) {
  await saveMonth(code, month, { hold: null, holdReleasedBy: by, holdReleasedAt: new Date().toISOString() });
}
// Pre-approval safety backup (once per month, deduped in att_meta) + the daily one.
export async function ensureApprovalBackup(month, by) {
  if (!isConfigured || !db) return;
  const ref = doc(db, 'att_meta', 'backup_' + month);
  const s = await getDoc(ref);
  if (s.exists() && s.data().done) return;
  await setDoc(ref, { done: true, by, at: new Date().toISOString() }, { merge: true });
  await queueJob('backup', { reason: 'before approving ' + month }, by);
}
// Final settlement for a resigning worker: pay till the last day + OT + bonus − advances,
// recorded as the month's final payment, employee marked inactive (exit date set).
export async function settleAndResign(code, month, pay, lastDay, by) {
  await saveMonth(code, month, {
    approved: { by, at: new Date().toISOString() }, approvedNet: pay.net, approvedCarry: pay.advanceBalanceCarried,
    advanceRecover: pay.advanceRecovered, locked: true,
    payment: { date: lastDay, mode: 'settlement', net: pay.net, by, settlement: true },
  });
  await saveEmployee(code, { active: false, exitDate: lastDay, resignedAt: lastDay });
  return queueJob('resign_employee', { code }, by);
}
// Manager-readable payout list (worker keeps it in sync with att_salary).
export async function loadPayout(month) {
  if (!isConfigured || !db) return { items: {} };
  const s = await getDoc(doc(db, 'att_meta', 'payout_' + month));
  return s.exists() ? s.data() : { items: {} };
}
// Owner finalizes a whole month's hisab: locks every ticked person's month and carries their
// leftover advance forward to next month (advance carries ONLY at finalize). Worker applies it.
export async function queueFinalizeHisab(month, by) {
  return queueJob('finalize_hisab', { month }, by);
}

// Manager marks a person paid — applied by the worker with admin rights. `amount` = the actual
// amount handed over (defaults to the net due); anything paid OVER the net becomes an advance
// carried forward to next month.
// Cashier settle: record cash+account, freeze the month, carry the running balance. payable = the
// client-computed net + opening balance (what to settle). Applied by the worker with admin rights.
export async function queueLock(code, month, { cash, account, payable, advanceCarry, breakdown, reason }, by) {
  // breakdown rides along so even the robot's fallback lock stores the full salary snapshot
  return queueJob('lock_month', { code, month, cash: Number(cash || 0), account: Number(account || 0), payable: Number(payable || 0), advanceCarry: Number(advanceCarry || 0), ...(breakdown ? { breakdown } : {}), reason: reason || '' }, by);
}
export async function queueUnlock(code, month, reason, by) {
  return queueJob('unlock_month', { code, month, reason: reason || '' }, by);
}
// INSTANT unlock — mirror of lockMonthDirect + the worker's unlock_month: the owner may write att_salary
// directly, so reopen the month right away (no dependency on the background robot, which may be offline).
// Clears lock + payment and REVERTS the carry it pushed to next month (restores prevNextOpening/Advance).
export async function unlockMonthDirect(code, month, reason, by) {
  const e = await loadEmployee(code);
  const md = (e.months || {})[month] || {};
  if (!md.locked && !md.payment) return { notLocked: true };
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const months = { ...(e.months || {}) };
  months[month] = { ...md, locked: false, payment: null, unlockedAt: new Date().toISOString(), unlockedBy: by };
  // Revert the carry we pushed to next month — BUT never touch next month if it's already locked
  // (its balance is baked into its own frozen payment; overwriting would desync it). Unlock later months first.
  if (!(months[next] || {}).locked) {
    months[next] = { ...(months[next] || {}), openingBalance: Number(md.payment?.prevNextOpening || 0), advanceBalanceIn: Number(md.payment?.prevNextAdvance || 0) };
  }
  const entry = { at: new Date().toISOString(), by, code, name: e.name || code, month, field: 'unlock', from: 'locked', to: 'reopened', reason: reason || '' };
  await saveEmployee(code, { months, decisions: [...(e.decisions || []), entry] });
  return { unlocked: true };
}
// INSTANT lock — the owner may write att_salary directly (rules line 49), so freeze the month + carry
// the balance right away (no 5-min wait). A background lock_month job then adds the register + Telegram.
export async function lockMonthDirect(code, month, { cash, account, payable, advanceCarry, breakdown, reason }, by) {
  const e = await loadEmployee(code);
  const md = (e.months || {})[month] || {};
  if (md.locked) return { alreadyLocked: true };
  const paid = Number(cash || 0) + Number(account || 0);
  const closing = Math.round((Number(payable || 0) - paid) * 100) / 100;
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const months = { ...(e.months || {}) };
  const prevNextOpening = Number((months[next] || {}).openingBalance || 0);
  const prevNextAdvance = Number((months[next] || {}).advanceBalanceIn || 0);
  const date = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  // `breakdown` snapshots the salary figures AT LOCK so an already-paid month never re-renders under a
  // later rule change. advanceBalanceIn is forced to 0: the advance folded fully into `closing` (one account).
  months[month] = { ...md, locked: true, lockedAt: new Date().toISOString(),
    payment: { cash: Number(cash || 0), account: Number(account || 0), net: paid, payable: Number(payable || 0), closing, mode: 'lock', prevNextOpening, prevNextAdvance, ...(breakdown ? { breakdown } : {}), by, reason: reason || '' } };
  months[next] = { ...(months[next] || {}), openingBalance: closing, advanceBalanceIn: 0 };
  const entry = { at: new Date().toISOString(), by, code, name: e.name || code, month, field: 'lock', from: `payable ₹${payable}`, to: `paid ₹${paid} (cash ${cash || 0}+acct ${account || 0}); carry ₹${closing}`, reason: reason || '' };
  await saveEmployee(code, { months, decisions: [...(e.decisions || []), entry] });
  return { closing, paid };
}
export async function queueMarkPaid(code, month, mode, by, remark, amount, payId) {
  // Unique id per Pay tap → the worker dedupes on it, so a re-tap during the 5-min queue delay
  // can never double-record a (part) payment.
  const pid = payId || ('pay-' + month + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  return queueJob('mark_paid', { code, month, mode, remark: remark || '', amount: amount != null ? Number(amount) : null, payId: pid }, by);
}

// Resign prompts (set by publishMonthly when someone is absent a full month).
export async function decideResignPrompt(code, decision, by) {
  const e = await loadEmployee(code);
  const rp = { ...(e.resignPrompt || {}), status: decision, decidedBy: by || '', decidedAt: new Date().toISOString() };
  await saveEmployee(code, { resignPrompt: rp });
  if (decision === 'resigned') return resignEmployee(code, by);
}
// Absence dock approval tasks: every 3 real absences → 1 Saturday cut, each approved/rejected
// per person. Approved count → weeklyOffDockDays (the engine deduction).
export async function loadAbsenceDockTasks(month) {
  const mk = month || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  if (!isConfigured || !db) return { month: mk, staff: [] };
  const [attSnap, salSnap] = await Promise.all([getDocs(collection(db, 'att_attendance')), getDocs(collection(db, 'att_salary'))]);
  const sal = {}; salSnap.forEach(d => { sal[d.id] = d.data(); });
  const staff = [];
  attSnap.forEach(d => {
    // read the SELECTED month's absences (months[mk]), not the top-level value
    // (which is only the current month) — else past-month review shows wrong docks.
    const ad = d.data();
    const rec = ad.months?.[mk] || (ad.month === mk ? ad : null);
    const absent = Number(rec?.absentDays) || 0;
    const docks = Math.floor(absent / 3);
    const s = sal[d.id];
    if (docks < 1 || !s || !(s.amount || s.wage)) return;
    const dec = (s.months?.[mk]?.absenceDocks) || {};
    const items = Array.from({ length: docks }, (_, i) => ({ index: i, label: `${(i + 1) * 3} absences → cut 1 Saturday`, status: dec[i]?.status || 'pending' }));
    staff.push({ code: d.id, name: s.name || d.id, dept: s.dept || '', absent, items, approved: items.filter(it => it.status === 'approved').length });
  });
  staff.sort((a, b) => b.absent - a.absent);
  return { month: mk, staff };
}
export async function saveAbsenceDock(code, month, index, approved) {
  const emp = await loadEmployee(code);
  const dec = { ...((emp.months?.[month]?.absenceDocks) || {}) };
  dec[index] = approved === null ? { status: 'pending' } : { status: approved ? 'approved' : 'rejected', at: new Date().toISOString() };
  const approvedCount = Object.values(dec).filter(d => d.status === 'approved').length;
  await saveMonth(code, month, { absenceDocks: dec, weeklyOffDockDays: approvedCount });
}

// Decide one penalty item (key = 'base' or a 'YYYY-MM-DD'). fraction 0.25/0.5, 0=reject, null=reopen.
export async function saveLatePenalty(code, month, key, fraction, by) {
  const emp = await loadEmployee(code);
  const pen = { ...((emp.months?.[month]?.latePenalties) || {}) };
  pen[key] = fraction === null
    ? { status: 'pending', fraction: 0 }
    : { fraction: Number(fraction) || 0, status: Number(fraction) > 0 ? 'approved' : 'rejected', by: by || '', at: new Date().toISOString() };
  const total = Object.values(pen).reduce((s, d) => s + (d.status === 'approved' ? Number(d.fraction) || 0 : 0), 0);
  await saveMonth(code, month, { latePenalties: pen, latePenaltyDays: total });
}
export async function addAdvance(code, adv) {
  const e = await loadEmployee(code); await saveEmployee(code, { advances: [...(e.advances || []), adv] });
}
export async function addIncrement(code, inc) {
  const e = await loadEmployee(code); await saveEmployee(code, { increments: [...(e.increments || []), inc] });
}
export async function saveMonth(code, month, data) {
  const e = await loadEmployee(code); const months = { ...(e.months || {}) };
  months[month] = { ...monthData(e, month), ...data }; await saveEmployee(code, { months });
}
export async function resignEmployee(code, by) {
  await saveEmployee(code, { active: false, resignedAt: new Date().toISOString().slice(0, 10) });
  return queueJob('resign_employee', { code }, by);
}

// ---- Manual (app-only) workers + worker removal ----------------------------------------------
// Add a worker who is NOT on the biometric machine (e.g. Radhey, Dinesh). Owner fills their days/OT
// each month via the month override. type: 'monthly' (amount ₹/mo) or 'daily' (wage ₹/day).
export async function addManualWorker({ name, dept = '', type = 'monthly', amount = 0, shift = 'GEN', standardHours = 8.5 }, by) {
  const code = 'MAN-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  const patch = {
    name: (name || '').trim(), dept, shift, standardHours: Number(standardHours) || 8.5,
    type: type === 'daily' ? 'daily' : 'monthly',
    ...(type === 'daily' ? { wage: Number(amount) || 0 } : { amount: Number(amount) || 0 }),
    appOnly: true, onMachine: false, manual: true, active: true,
    createdBy: by || '', createdAt: new Date().toISOString(), months: {}, advances: [], increments: [],
  };
  await saveEmployee(code, patch);
  return code;
}
// Soft remove: hide from the active salary list but KEEP all history (reversible via active:true).
export async function removeWorker(code, by) {
  await saveEmployee(code, { active: false, removedAt: new Date().toISOString().slice(0, 10), removedBy: by || '' });
}
export async function restoreWorker(code) {
  await saveEmployee(code, { active: true, removedAt: null });
}
// Hard delete: permanently erase the worker's salary record (att_salary). Caller must gate this
// (never-paid, or action password) — see Person page. att_attendance/att_punch are Admin-SDK-only
// (rules block client writes), so they stay on the admin side but are invisible in the app.
export async function deleteWorkerHard(code) {
  if (!isConfigured || !db) return;
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'att_salary', code));
}
// Has this worker been PAID (locked) in any month? (blocks free permanent-delete)
export function workerEverPaid(emp) {
  return Object.values((emp && emp.months) || {}).some((m) => m && (m.payment || m.locked));
}
// Archived (resigned + removed-from-machine) workers, newest first. Their full history is kept
// in att_archive/{code} by the worker before the machine record is deleted.
export async function loadArchive() {
  if (!isConfigured || !db) return [];
  const snap = await getDocs(collection(db, 'att_archive'));
  return snap.docs.map((d) => d.data())
    .sort((a, b) => (String(b.archivedAt || '')).localeCompare(String(a.archivedAt || '')));
}
// Monthly attendance per employee — written by the publishSalaryData job to att_attendance/{code}.
export async function loadAttendance(code) {
  if (isConfigured && db) {
    const s = await getDoc(doc(db, 'att_attendance', code));
    if (s.exists()) return s.data();
  }
  return MOCK_ATT[code] || { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };
}

// In-app export/restore REMOVED 2026-07-17: it referenced retired collections (att_employees,
// att_advances, …) and missed attendance/punches — an incomplete file that looked like a full
// backup, next to a Restore that could overwrite live payroll. Real backup = nightly cloud job
// (jobs/fullBackup.js → private unico-backups repo); restores are done via firebase-admin.

// Queue a job for the GitHub Actions worker to pick up (manual punch / monthly download).
export async function queueJob(type, payload, requestedBy) {
  if (!isConfigured || !db) {
    return { id: 'mock-' + Date.now(), mock: true };
  }
  const ref = await addDoc(collection(db, 'att_job_requests'), {
    type, payload, requestedBy, status: 'pending', createdAt: serverTimestamp(),
  });
  return { id: ref.id };
}
