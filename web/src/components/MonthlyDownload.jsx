import { useState } from 'react';
import { queueJob } from '../lib/data';

// last 12 months
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  return { v: i, label: (i === 0 ? 'This month — ' : '') + d.toLocaleString('default', { month: 'long', year: 'numeric' }) };
});

export default function MonthlyDownload({ user }) {
  const [month, setMonth] = useState(0);
  const [scope, setScope] = useState('all');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setStatus('queuing');
    const payload = { month: Number(month), scope, value: value.trim() };
    try {
      const r = await queueJob('monthly_download', payload, user.email);
      setStatus(r.mock ? 'mock' : 'queued');
    } catch (e) { setStatus('error:' + e.message); }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl shadow p-4 space-y-4">
      <h2 className="font-semibold text-gray-800">Download monthly attendance</h2>

      <Field label="Month">
        <select className="w-full border rounded px-3 py-2" value={month} onChange={(e) => setMonth(e.target.value)}>
          {MONTHS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
        </select>
      </Field>

      <Field label="Who">
        <select className="w-full border rounded px-3 py-2" value={scope} onChange={(e) => { setScope(e.target.value); setValue(''); }}>
          <option value="all">All employees</option>
          <option value="dept">A department</option>
          <option value="emp">One employee</option>
        </select>
      </Field>

      {scope === 'dept' && (
        <Field label="Department">
          <select className="w-full border rounded px-3 py-2" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Select…</option>
            {['FITTING', 'WELDING', 'PRESS', 'POWDER', 'TOOL ROOM', 'HELPER', 'FRAME', 'DEMO'].map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
      )}
      {scope === 'emp' && (
        <Field label="Employee code">
          <input className="w-full border rounded px-3 py-2" placeholder="e.g. 00000112" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}

      <button disabled={status === 'queuing' || (scope !== 'all' && !value)}
        className="w-full bg-red-700 disabled:opacity-50 text-white rounded py-2 font-medium">
        {status === 'queuing' ? 'Requesting…' : 'Request download'}
      </button>

      {status === 'queued' && <Note ok>Requested — the file will be generated and sent to your Telegram shortly.</Note>}
      {status === 'mock' && <Note>Preview mode: request logged locally (wires to the job once Firebase is connected).</Note>}
      {status?.startsWith('error') && <Note>Could not queue: {status.slice(6)}</Note>}
    </form>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>;
}
function Note({ ok, children }) {
  return <p className={`text-sm rounded p-2 border ${ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>{children}</p>;
}
