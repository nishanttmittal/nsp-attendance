import { useEffect, useState } from 'react';
import { queueJob, saveEmployee, loadEmployees, resignEmployee } from '../lib/data';

const DEPTS = ['FITTING', 'WELDING', 'PRESS', 'POWDER', 'TOOL ROOM', 'HELPER', 'FRAME', 'DEMO'];
const SHIFTS = ['GEN', '10H', '12H', 'wir'];

export default function Employees({ user }) {
  const [f, setF] = useState({ name: '', cardno: '', dept: 'FITTING', shift: 'GEN', gender: 'Male' });
  const [status, setStatus] = useState(null);
  const [staff, setStaff] = useState([]);
  const set = k => e => setF({ ...f, [k]: e.target.value });

  const refresh = () => loadEmployees().then(setStaff);
  useEffect(() => { refresh(); }, []);

  async function resign(emp) {
    if (!confirm(`Mark ${emp.name} as resigned? They'll drop from active staff, salary and counts.`)) return;
    await resignEmployee(emp.code, user.email);
    refresh();
  }

  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim() || !f.cardno.trim()) { setStatus({ ok: false, t: 'Name and card number are required.' }); return; }
    setStatus({ busy: true });
    try {
      await queueJob('onboard_employee', { ...f }, user.email);   // -> machine (sets policy = shift)
      await saveEmployee(f.cardno.trim(), { code: f.cardno.trim(), name: f.name.trim(), dept: f.dept, shift: f.shift }); // app salary list
      setStatus({ ok: true, t: `${f.name} queued — being added to the machine with ${f.shift} shift & policy.` });
      setF({ name: '', cardno: '', dept: f.dept, shift: f.shift, gender: 'Male' });
      refresh();
    } catch (e) { setStatus({ ok: false, t: 'Failed: ' + e.message }); }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="font-semibold text-gray-800">Add employee</div>
      <p className="text-xs text-gray-500">After enrolling the worker on the machine, add their details here. Office-Time-Policy is set to match the shift automatically.</p>

      <Field label="Name *"><input className="inp" placeholder="Full name" value={f.name} onChange={set('name')} /></Field>
      <Field label="Card / device number *"><input className="inp" placeholder="e.g. 00000123" value={f.cardno} onChange={set('cardno')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Department"><select className="inp" value={f.dept} onChange={set('dept')}>{DEPTS.map(d => <option key={d}>{d}</option>)}</select></Field>
        <Field label="Shift"><select className="inp" value={f.shift} onChange={set('shift')}>{SHIFTS.map(s => <option key={s}>{s}</option>)}</select></Field>
      </div>
      <Field label="Gender"><select className="inp" value={f.gender} onChange={set('gender')}><option>Male</option><option>Female</option><option>Other</option></select></Field>

      <button disabled={status?.busy} className="w-full bg-red-700 disabled:opacity-50 text-white rounded-lg py-2.5 font-medium">
        {status?.busy ? 'Adding…' : 'Add to machine'}
      </button>
      {status && !status.busy && <p className={`text-sm rounded p-2 border ${status.ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{status.t}</p>}

      <style>{`.inp{width:100%;border:1px solid #d1d5db;border-radius:.5rem;padding:.55rem .75rem;background:#fff}`}</style>

      {/* Current staff + resign */}
      <div className="pt-2">
        <div className="font-semibold text-gray-800 mb-1">Current staff ({staff.length})</div>
        <ul className="text-sm divide-y divide-gray-100">
          {staff.map((e) => (
            <li key={e.code} className="py-2 flex items-center justify-between">
              <span>{e.name} <span className="text-gray-400">({e.code}) · {e.shift}</span></span>
              <button type="button" onClick={() => resign(e)} className="text-xs text-red-700 border border-red-200 rounded px-2 py-1">Resign</button>
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
