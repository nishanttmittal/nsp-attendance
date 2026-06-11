// Data layer. Shape matches the jobs' getState.gatherState() output.
// Reads Firestore doc `daily_stats/today` when Firebase is configured; otherwise mock.
import { isConfigured, db } from './firebase';
import { doc, getDoc, getDocs, setDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore';

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

export async function saveEmployee(code, patch) {
  if (isConfigured && db) { await setDoc(doc(db, 'att_salary', code), patch, { merge: true }); return; }
  const store = loadSal(); store[code] = { ...(store[code] || {}), ...patch }; saveSal(store);
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
// Monthly attendance per employee — written by the publishSalaryData job to att_attendance/{code}.
export async function loadAttendance(code) {
  if (isConfigured && db) {
    const s = await getDoc(doc(db, 'att_attendance', code));
    if (s.exists()) return s.data();
  }
  return MOCK_ATT[code] || { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };
}

// The app-data collections that make up a full backup (all namespaced att_*).
const BACKUP_COLLECTIONS = ['att_employees', 'att_salary', 'att_advances', 'att_increments', 'att_loans', 'att_fines', 'att_month_locks'];

// Export everything into one JSON object (for download / off-site backup).
export async function exportAllData() {
  const out = { app: 'nsp-attendance', version: 1, exportedAt: new Date().toISOString(), collections: {} };
  if (!isConfigured || !db) {
    out.source = 'sample';
    out.collections = { employees: { '00000018': { type: 'monthly', amount: 18000, shift: 'GEN' } }, advances: [], increments: {}, loans: {}, fines: {}, month_locks: {} };
    return out;
  }
  const { getDocs, collection } = await import('firebase/firestore');
  for (const name of BACKUP_COLLECTIONS) {
    const snap = await getDocs(collection(db, name));
    out.collections[name] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  }
  return out;
}

// Restore from a previously exported object (overwrites matching docs).
export async function restoreAllData(obj) {
  if (!obj || obj.app !== 'nsp-attendance' || !obj.collections) throw new Error('Not a valid NSP Attendance backup file.');
  if (!isConfigured || !db) return { restored: 0, mock: true };
  const { doc, setDoc, collection } = await import('firebase/firestore');
  let restored = 0;
  for (const [name, docs] of Object.entries(obj.collections)) {
    if (!BACKUP_COLLECTIONS.includes(name)) continue;
    for (const [id, data] of Object.entries(docs || {})) { await setDoc(doc(collection(db, name), id), data, { merge: true }); restored++; }
  }
  return { restored };
}

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
