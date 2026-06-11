import { useEffect, useState } from 'react';
import { loadRoster, queueAdvance } from '../lib/data';

// Add-advance screen for managers (and admin). Submits to the job queue so it's applied
// with admin rights — managers never read salary, only record the advance they paid.
export default function Advance({ user }) {
  const [roster, setRoster] = useState(null);
  const [code, setCode] = useState('');
  const [f, setF] = useState({ amount: '', date: new Date().toISOString().slice(0, 10), mode: 'cash', remark: '', bank: '', cash: '' });
  const [status, setStatus] = useState(null);
  const set = k => e => setF({ ...f, [k]: e.target.value });

  useEffect(() => { loadRoster().then(r => { setRoster(r); if (r[0]) setCode(r[0].code); }); }, []);

  async function submit() {
    if (!code) { setStatus('pick an employee'); return; }
    const total = f.mode === 'both' ? Number(f.bank || 0) + Number(f.cash || 0) : Number(f.amount || 0);
    if (!total) { setStatus('enter amount'); return; }
    const advance = f.mode === 'both'
      ? { date: f.date, mode: 'both', amount: total, bank: Number(f.bank || 0), cash: Number(f.cash || 0), remark: f.remark, paidBy: user.email }
      : { date: f.date, mode: f.mode, amount: total, remark: f.remark, paidBy: user.email };
    setStatus('saving');
    try { await queueAdvance(code, advance, user.email); setStatus('saved'); setF({ ...f, amount: '', bank: '', cash: '', remark: '' }); }
    catch (e) { setStatus('error:' + e.message); }
  }

  if (roster === null) return <p className="text-gray-500">Loading…</p>;
  if (roster.length === 0) return <p className="text-gray-500 text-sm">No employees yet.</p>;

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <h2 className="font-semibold text-gray-800">Record an advance</h2>
      <p className="text-xs text-gray-500">Logged against the employee with your name as the payer. Applied within a few minutes.</p>
      <Field label="Employee">
        <select className="inp" value={code} onChange={e => setCode(e.target.value)}>
          {roster.map(r => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><input className="inp" type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Mode"><select className="inp" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="account">Bank</option><option value="both">Both</option></select></Field>
      </div>
      {f.mode === 'both' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank ₹"><input className="inp" type="number" value={f.bank} onChange={set('bank')} /></Field>
          <Field label="Cash ₹"><input className="inp" type="number" value={f.cash} onChange={set('cash')} /></Field>
        </div>
      ) : <Field label="Amount ₹"><input className="inp" type="number" value={f.amount} onChange={set('amount')} /></Field>}
      <Field label="Remark"><input className="inp" value={f.remark} onChange={set('remark')} /></Field>
      <button onClick={submit} disabled={status === 'saving'} className="w-full bg-red-700 disabled:opacity-50 text-white rounded-lg py-2.5 font-medium">{status === 'saving' ? 'Saving…' : 'Record advance'}</button>
      {status === 'saved' && <Note ok>Recorded — will reflect in salary shortly.</Note>}
      {status && !['saving', 'saved'].includes(status) && <Note>{status.replace(/^error:/, '')}</Note>}
      <style>{`.inp{width:100%;border:1px solid #d1d5db;border-radius:.5rem;padding:.55rem .75rem;background:#fff}`}</style>
    </div>
  );
}
function Field({ label, children }) { return <label className="block"><span className="text-sm text-gray-600">{label}</span><div className="mt-1">{children}</div></label>; }
function Note({ ok, children }) { return <p className={`text-sm rounded p-2 border ${ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>{children}</p>; }
