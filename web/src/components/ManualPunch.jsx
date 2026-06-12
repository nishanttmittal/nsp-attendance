import { useEffect, useState } from 'react';
import { queueJob, loadRoster, loadMissedPunches } from '../lib/data';

export default function ManualPunch({ user }) {
  const [f, setF] = useState({ emp: '', date: '', in: '', out: '', remark: '' });
  const [status, setStatus] = useState(null);
  const [emps, setEmps] = useState([]);
  const [missed, setMissed] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { loadRoster().then(setEmps); loadMissedPunches().then(setMissed); }, []);

  // tap a missed-punch row → prefill the person, date, and the punch that IS present
  function prefill(m) {
    const base = { emp: m.code, date: m.date, in: '', out: '', remark: 'missed ' + m.which };
    if (m.which === 'out') base.in = m.otherTime;   // out missing → in is known
    else base.out = m.otherTime;                    // in missing → out is known
    setF(base);
    setStatus(null);
    window.scrollTo({ top: 9999, behavior: 'smooth' });
  }

  async function submit(e) {
    e.preventDefault();
    if (!f.emp || !f.date || (!f.in && !f.out)) { setStatus('need emp, date, and at least one time'); return; }
    setStatus('queuing');
    try {
      const r = await queueJob('manual_punch', { ...f }, user.email);
      setStatus(r.mock ? 'mock' : 'queued');
      if (!r.mock) { setF({ emp: '', date: '', in: '', out: '', remark: '' }); loadMissedPunches().then(setMissed); }
    } catch (e) { setStatus('error:' + e.message); }
  }

  return (
    <div className="space-y-4">
      {missed.length > 0 && (
        <div className="bg-white rounded-xl shadow p-4">
          <div className="font-semibold text-gray-800">Missed punches this month ({missed.length})</div>
          <p className="text-xs text-gray-500 mb-2">Tap one to fill the form, then enter the missing time.</p>
          <ul className="text-sm divide-y divide-gray-100 max-h-72 overflow-auto">
            {missed.map((m, i) => (
              <li key={m.code + m.date + i}>
                <button type="button" onClick={() => prefill(m)} className="w-full text-left py-2 flex items-center justify-between active:bg-gray-50">
                  <span>{m.name} <span className="text-gray-400">· {m.date}</span></span>
                  <span className="text-xs"><span className="text-amber-700">missing {m.which.toUpperCase()}</span> <span className="text-gray-400">({m.which === 'out' ? 'in ' : 'out '}{m.otherTime})</span></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit} className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-gray-800">Add a missed punch</h2>
        <p className="text-xs text-gray-500">Time in 24h HH:MM. Fill IN, OUT, or both. The day is reprocessed automatically.</p>

        <Field label="Employee">
          <select className="inp" value={f.emp} onChange={set('emp')}>
            <option value="">Select name…</option>
            {emps.map((e) => <option key={e.code} value={e.code}>{e.name} ({e.code})</option>)}
          </select>
        </Field>
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
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>;
}
function Note({ ok, children }) {
  return <p className={`text-sm rounded p-2 border ${ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>{children}</p>;
}
