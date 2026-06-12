import { useEffect, useState } from 'react';
import { queueJob, saveEmployee, loadEmployees, loadRoster, resignEmployee } from '../lib/data';

const DEPTS = ['FITTING', 'WELDING', 'PRESS', 'POWDER', 'TOOL ROOM', 'HELPER', 'FRAME', 'DEMO'];
const SHIFTS = ['GEN', '10H', '12H', 'wir'];

export default function Employees({ user }) {
  const [kind, setKind] = useState('machine'); // 'machine' | 'wager'
  const [f, setF] = useState({ name: '', cardno: '', dept: 'FITTING', shift: 'GEN', gender: 'Male', wage: '' });
  const [status, setStatus] = useState(null);
  const [staff, setStaff] = useState([]);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const isAdmin = user.role === 'admin';

  const refresh = () => (isAdmin ? loadEmployees() : loadRoster()).then(setStaff);
  useEffect(() => { refresh(); }, []);

  const [editing, setEditing] = useState(null);
  const [ef, setEf] = useState({ name: '', dept: '' });
  const startEdit = (e) => { setEditing(e.code); setEf({ name: e.name || '', dept: e.dept || DEPTS[0] }); };
  const saveEdit = async () => {
    if (!ef.name.trim()) return;
    // nameLocked/deptLocked stop the machine-sync job from overwriting the owner's correction
    await saveEmployee(editing, { name: ef.name.trim(), dept: ef.dept, nameLocked: true, deptLocked: true });
    setEditing(null); refresh();
  };

  async function resign(emp) {
    if (!confirm(`Mark ${emp.name} as resigned? They'll drop from active staff, salary and counts.`)) return;
    await resignEmployee(emp.code, user.email);
    refresh();
  }

  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim()) { setStatus({ ok: false, t: 'Name is required.' }); return; }
    setStatus({ busy: true });
    try {
      if (kind === 'wager') {
        if (!f.wage) { setStatus({ ok: false, t: 'Daily wage is required.' }); return; }
        const code = 'DW-' + Date.now().toString(36).toUpperCase();   // app-only id, not on machine
        await saveEmployee(code, { code, name: f.name.trim(), dept: f.dept, type: 'daily', appOnly: true, wage: Number(f.wage), standardHours: 11 });
        setStatus({ ok: true, t: `${f.name} added as daily-wager (₹${f.wage}/day, 11-hr day). Not on the machine — enter their hours in Salary.` });
        setF({ ...f, name: '', wage: '' });
      } else {
        if (!f.cardno.trim()) { setStatus({ ok: false, t: 'Card number is required.' }); return; }
        await queueJob('onboard_employee', { ...f }, user.email);   // -> machine (sets policy = shift)
        await saveEmployee(f.cardno.trim(), { code: f.cardno.trim(), name: f.name.trim(), dept: f.dept, shift: f.shift });
        setStatus({ ok: true, t: `${f.name} queued — being added to the machine with ${f.shift} shift & policy.` });
        setF({ ...f, name: '', cardno: '' });
      }
      refresh();
    } catch (e) { setStatus({ ok: false, t: 'Failed: ' + e.message }); }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl shadow p-4 space-y-3">
      {isAdmin && (<>
      <div className="font-semibold text-gray-800">Add employee</div>
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setKind('machine')} className={`flex-1 rounded-lg py-2 border ${kind === 'machine' ? 'border-red-700 text-red-700 font-medium' : 'border-gray-200 text-gray-500'}`}>Machine employee</button>
        <button type="button" onClick={() => setKind('wager')} className={`flex-1 rounded-lg py-2 border ${kind === 'wager' ? 'border-red-700 text-red-700 font-medium' : 'border-gray-200 text-gray-500'}`}>Daily-wager (app-only)</button>
      </div>
      <p className="text-xs text-gray-500">{kind === 'machine' ? 'On the biometric. Office-Time-Policy auto-matches the shift.' : 'Not on the machine — 11-hour day, pay prorates by hours. Enter hours in the Salary tab.'}</p>

      <Field label="Name *"><input className="inp" placeholder="Full name" value={f.name} onChange={set('name')} /></Field>
      {kind === 'machine' ? (
        <>
          <Field label="Card / device number *"><input className="inp" placeholder="e.g. 00000123" value={f.cardno} onChange={set('cardno')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department"><select className="inp" value={f.dept} onChange={set('dept')}>{DEPTS.map(d => <option key={d}>{d}</option>)}</select></Field>
            <Field label="Shift"><select className="inp" value={f.shift} onChange={set('shift')}>{SHIFTS.map(s => <option key={s}>{s}</option>)}</select></Field>
          </div>
          <Field label="Gender"><select className="inp" value={f.gender} onChange={set('gender')}><option>Male</option><option>Female</option><option>Other</option></select></Field>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Department"><select className="inp" value={f.dept} onChange={set('dept')}>{DEPTS.map(d => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Daily wage (₹) *"><input className="inp" type="number" placeholder="e.g. 650" value={f.wage} onChange={set('wage')} /></Field>
        </div>
      )}

      <button disabled={status?.busy} className="w-full bg-red-700 disabled:opacity-50 text-white rounded-lg py-2.5 font-medium">
        {status?.busy ? 'Adding…' : (kind === 'machine' ? 'Add to machine' : 'Add daily-wager')}
      </button>
      {status && !status.busy && <p className={`text-sm rounded p-2 border ${status.ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{status.t}</p>}
      </>)}

      <style>{`.inp{width:100%;border:1px solid #d1d5db;border-radius:.5rem;padding:.55rem .75rem;background:#fff}`}</style>

      {/* Current staff + resign */}
      <div className="pt-2">
        <div className="font-semibold text-gray-800 mb-1">Current staff ({staff.length})</div>
        <ul className="text-sm divide-y divide-gray-100">
          {staff.map((e) => (
            <li key={e.code} className="py-2">
              {editing === e.code ? (
                <div className="space-y-2">
                  <input className="inp" value={ef.name} onChange={ev => setEf({ ...ef, name: ev.target.value })} placeholder="Name" />
                  <select className="inp" value={ef.dept} onChange={ev => setEf({ ...ef, dept: ev.target.value })}>{DEPTS.map(d => <option key={d}>{d}</option>)}</select>
                  <div className="flex gap-2">
                    <button type="button" onClick={saveEdit} className="flex-1 bg-red-700 text-white rounded py-1.5 text-xs font-medium">Save</button>
                    <button type="button" onClick={() => setEditing(null)} className="border border-gray-300 rounded py-1.5 px-3 text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span>{e.name} <span className="text-gray-400">({e.code}){e.dept ? ' · ' + e.dept : ''}{e.shift ? ' · ' + e.shift : ''}</span></span>
                  {isAdmin && (
                    <div className="flex gap-1">
                      <button type="button" onClick={() => startEdit(e)} className="text-xs text-gray-600 border border-gray-200 rounded px-2 py-1">Edit</button>
                      <button type="button" onClick={() => resign(e)} className="text-xs text-red-700 border border-red-200 rounded px-2 py-1">Resign</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>;
}
