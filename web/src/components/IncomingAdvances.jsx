// Incoming Advances (from UNICO Hisab) — the owner records an advance in the Hisab
// app, targets a salaried worker, and it lands here to ACCEPT. Accepting calls the
// SAME addAdvance() the Salary screen uses (appends to the worker's advances[],
// deducted at settle) and marks the outbox doc accepted. Nothing touches salary
// until the owner taps Accept. Admin-only (salary feature).
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { addAdvance, loadEmployees } from '../lib/data';

const money = (n) => '₹' + (Math.round(Number(n) || 0)).toLocaleString('en-IN');

export default function IncomingAdvances({ user }) {
  const [rows, setRows] = useState([]);
  const [emps, setEmps] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, 'hisab_advance_outbox'), where('target', '==', 'salary'), where('status', '==', 'pending'));
    return onSnapshot(q, (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), () => setRows([]));
  }, []);
  useEffect(() => { loadEmployees(true).then(setEmps).catch(() => setEmps([])); }, []);

  const empOf = (r) => emps.find((e) => e.code === r.code) || emps.find((e) => (e.name || '') === (r.name || ''));

  const accept = async (r) => {
    if (busy) return;
    const emp = empOf(r);
    if (!emp) { setMsg(`No salary worker matches "${r.name}" (code ${r.code || '—'}). Add them first.`); return; }
    if (!window.confirm(`Accept advance of ${money(r.amount)} for ${emp.name}?\nIt will be added to his salary advances.`)) return;
    setBusy(r.id); setMsg('');
    try {
      await addAdvance(emp.code, { date: r.date || new Date().toISOString().slice(0, 10), mode: 'Cash',
        amount: Number(r.amount) || 0, remark: `via Hisab${r.note ? ': ' + r.note : ''}`, paidBy: user?.email || '' });
      await updateDoc(doc(db, 'hisab_advance_outbox', r.id), { status: 'accepted', acceptedAt: new Date().toISOString(), acceptedBy: user?.email || '' });
      setMsg(`✓ Added ${money(r.amount)} advance for ${emp.name}`);
    } catch (e) {
      // This path had NO locked-month check until 2026-07-31 — accepting a back-dated advance into
      // a sealed month recorded cash no salary run would ever deduct. Now it refuses; say why.
      const m = String(e?.message || '');
      if (m.startsWith('LOCKED:')) setMsg(`Not accepted — ${emp.name}'s salary for ${m.slice(7)} is already paid & locked, so this advance could never be deducted. Re-date it in the current month in Hisab.`);
      else if (m.startsWith('LOCKEDLATER:')) setMsg(`Not accepted — a later month (${m.slice(12)}) is already paid & locked for ${emp.name}, so this advance could never be deducted. Re-date it in the current month in Hisab.`);
      else if (m === 'BADDATE') setMsg('Not accepted — this advance has no valid date. Fix the date in Hisab first.');
      else setMsg('Failed: ' + m);
    }
    setBusy('');
  };

  const dismiss = async (r) => {
    if (!window.confirm(`Dismiss advance of ${money(r.amount)} for ${r.name}? (It won't be added.)`)) return;
    try { await updateDoc(doc(db, 'hisab_advance_outbox', r.id), { status: 'dismissed', dismissedAt: new Date().toISOString() }); }
    catch (e) { setMsg('Failed: ' + e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">Advances pushed from the <b>UNICO Hisab</b> app. Accept to add to the worker&apos;s salary advances.</p>
      {msg && <div className="text-sm font-medium bg-gray-50 border rounded px-3 py-2">{msg}</div>}
      {rows.length === 0 && <div className="text-center text-gray-400 text-sm py-8 border rounded bg-white">No incoming advances.</div>}
      {rows.map((r) => (
        <div key={r.id} className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-bold text-gray-800">{r.name}{empOf(r) ? '' : ' ⚠'}</div>
              <div className="text-xs text-gray-400">{r.date || ''}{r.note ? ' · ' + r.note : ''}{empOf(r) ? '' : ' · no matching worker'}</div>
            </div>
            <div className="text-xl font-extrabold text-rose-600">{money(r.amount)}</div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => dismiss(r)} className="flex-1 py-2 rounded bg-gray-100 text-gray-600 font-semibold text-sm">Dismiss</button>
            <button onClick={() => accept(r)} disabled={busy === r.id || !empOf(r)}
              className="flex-1 py-2 rounded bg-emerald-600 text-white font-bold text-sm disabled:opacity-50">{busy === r.id ? 'Accepting…' : 'Accept'}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
