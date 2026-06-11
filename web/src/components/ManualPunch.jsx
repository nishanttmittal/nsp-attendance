import { useState } from 'react';
import { queueJob } from '../lib/data';

export default function ManualPunch({ user }) {
  const [f, setF] = useState({ emp: '', date: '', in: '', out: '', remark: '' });
  const [status, setStatus] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (!f.emp || !f.date || (!f.in && !f.out)) { setStatus('need emp, date, and at least one time'); return; }
    setStatus('queuing');
    try {
      const r = await queueJob('manual_punch', { ...f }, user.email);
      setStatus(r.mock ? 'mock' : 'queued');
      if (!r.mock) setF({ emp: '', date: '', in: '', out: '', remark: '' });
    } catch (e) { setStatus('error:' + e.message); }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl shadow p-4 space-y-3">
      <h2 className="font-semibold text-gray-800">Add a missed punch</h2>
      <p className="text-xs text-gray-500">Time in 24h HH:MM. Fill IN, OUT, or both. The day is reprocessed automatically.</p>

      <Field label="Employee code"><input className="inp" placeholder="00000112" value={f.emp} onChange={set('emp')} /></Field>
      <Field label="Date (dd/MM/yyyy)"><input className="inp" placeholder="09/06/2026" value={f.date} onChange={set('date')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="IN time"><input className="inp" placeholder="09:00" value={f.in} onChange={set('in')} /></Field>
        <Field label="OUT time"><input className="inp" placeholder="18:30" value={f.out} onChange={set('out')} /></Field>
      </div>
      <Field label="Remark"><input className="inp" placeholder="forgot to punch out" value={f.remark} onChange={set('remark')} /></Field>

      <button disabled={status === 'queuing'} className="w-full bg-red-700 disabled:opacity-50 text-white rounded py-2 font-medium">
        {status === 'queuing' ? 'Submitting…' : 'Insert punch'}
      </button>

      {status === 'queued' && <Note ok>Submitted — punch will be inserted and the day reprocessed.</Note>}
      {status === 'mock' && <Note>Preview mode: request logged locally (wires to the job once Firebase is connected).</Note>}
      {status && !['queuing', 'queued', 'mock'].includes(status) && <Note>{status.replace(/^error:/, '')}</Note>}

      <style>{`.inp{width:100%;border:1px solid #d1d5db;border-radius:.375rem;padding:.5rem .75rem}`}</style>
    </form>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>;
}
function Note({ ok, children }) {
  return <p className={`text-sm rounded p-2 border ${ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>{children}</p>;
}
