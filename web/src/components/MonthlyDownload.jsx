import { useState, useEffect } from 'react';
import { queueJob, loadRoster } from '../lib/data';

// last 12 months
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  return { v: i, label: (i === 0 ? 'This month — ' : '') + d.toLocaleString('default', { month: 'long', year: 'numeric' }) };
});

export default function MonthlyDownload({ user }) {
  const [month, setMonth] = useState(0);
  const [scope, setScope] = useState('all');
  const [value, setValue] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [emps, setEmps] = useState([]);
  const [status, setStatus] = useState(null);
  useEffect(() => { loadRoster().then(setEmps); }, []);
  const toDmy = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

  async function submit(e) {
    e.preventDefault();
    setStatus('queuing');
    const payload = { month: Number(month), scope, value: value.trim(), from: toDmy(range.from), to: toDmy(range.to) };
    try {
      const r = await queueJob('monthly_download', payload, user.email);
      setStatus(r.mock ? 'mock' : 'queued');
    } catch (e) { setStatus('error:' + e.message); }
  }

  return (
    <div className="space-y-4">
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
        <Field label="Employee">
          <select className="w-full border rounded px-3 py-2" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Select name…</option>
            {emps.map((em) => <option key={em.code} value={em.code}>{em.name} ({em.code})</option>)}
          </select>
        </Field>
      )}

      <Field label="Date range (optional — overrides the month)">
        <div className="grid grid-cols-2 gap-2">
          <input className="w-full border rounded px-3 py-2" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input className="w-full border rounded px-3 py-2" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
      </Field>

      <button disabled={status === 'queuing' || (scope !== 'all' && !value)}
        className="w-full bg-red-700 disabled:opacity-50 text-white rounded py-2 font-medium">
        {status === 'queuing' ? 'Requesting…' : 'Request download'}
      </button>

      {status === 'queued' && <Note ok>Requested — the file will be generated and sent to your Telegram shortly.</Note>}
      {status === 'mock' && <Note>Preview mode: request logged locally (wires to the job once Firebase is connected).</Note>}
      {status?.startsWith('error') && <Note>Could not queue: {status.slice(6)}</Note>}
    </form>
    <ReprocessCard user={user} />
    </div>
  );
}

function ReprocessCard({ user }) {
  const [r, setR] = useState({ from: '', to: '' });
  const [st, setSt] = useState(null);
  const toDmy = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  async function go() {
    if (!r.from || !r.to) { setSt('pick both dates'); return; }
    setSt('queuing');
    try { await queueJob('reprocess_period', { from: toDmy(r.from), to: toDmy(r.to) }, user.email); setSt('queued'); }
    catch (e) { setSt('error:' + e.message); }
  }
  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <h2 className="font-semibold text-gray-800">Reprocess attendance (period)</h2>
      <p className="text-xs text-gray-500">Recompute attendance for a date range (all employees) — use after editing punches or rule changes.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><input className="w-full border rounded px-3 py-2" type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
        <Field label="To"><input className="w-full border rounded px-3 py-2" type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
      </div>
      <button onClick={go} disabled={st === 'queuing'} className="w-full bg-gray-800 disabled:opacity-50 text-white rounded py-2 font-medium">{st === 'queuing' ? 'Requesting…' : 'Reprocess period'}</button>
      {st === 'queued' && <Note ok>Queued — attendance will be reprocessed; you'll get a Telegram confirmation.</Note>}
      {st && !['queuing', 'queued'].includes(st) && <Note>{st.replace(/^error:/, '')}</Note>}
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>;
}
function Note({ ok, children }) {
  return <p className={`text-sm rounded p-2 border ${ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>{children}</p>;
}
