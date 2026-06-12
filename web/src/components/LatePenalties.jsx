import { useEffect, useState } from 'react';
import { loadLatePenaltyTasks, saveLatePenalty } from '../lib/data';

// Late-arrival penalties. For each employee with 4+ late marks: the first 4 are one task, and
// EVERY extra late day (5th, 6th, …) is its own task — each approved 25% / 50% or rejected.
export default function LatePenalties({ user }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const refresh = () => loadLatePenaltyTasks().then(setData).catch(() => setData({ staff: [] }));
  useEffect(() => { refresh(); }, []);

  async function decide(code, key, fraction) {
    setBusy(code + key); await saveLatePenalty(code, data.month, key, fraction, user.email); await refresh(); setBusy('');
  }

  if (!data) return <p className="text-gray-500">Loading…</p>;
  const monthName = data.month ? new Date(data.month + '-01').toLocaleString('en', { month: 'long', year: 'numeric' }) : '';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-semibold text-gray-800">Late-arrival penalties · {monthName}</div>
        <p className="text-xs text-gray-500 mt-1">4+ late marks (in &gt;15 min after grace). Decide the first 4, then <b>each extra late day separately</b>. Approved cuts apply in Salary.</p>
      </div>

      {data.staff.length === 0
        ? <div className="bg-white rounded-xl shadow p-4 text-sm text-gray-500">No one has 4+ late marks this month. 🎉</div>
        : data.staff.map((s) => (
          <div key={s.code} className="bg-white rounded-xl shadow p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="font-medium text-gray-800">{s.name}</div>
                <div className="text-xs text-gray-500">{s.dept} · {s.code} · {s.count} late</div>
              </div>
              {s.totalDays > 0 && <div className="text-sm font-semibold text-red-700">−{s.totalDays} day{s.totalDays === 1 ? '' : 's'}</div>}
            </div>
            <ul className="divide-y divide-gray-100">
              {s.items.map((it) => (
                <li key={it.key} className="py-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-700">
                      {it.label}
                      <span className="text-gray-400"> · {it.key === 'base' ? it.dates.map(fmt).join(', ') : fmt(it.dates[0]) + (it.inT ? ' · in ' + it.inT : '')}</span>
                    </div>
                  </div>
                  {it.status === 'pending' ? (
                    <div className="flex gap-2 mt-2">
                      <Btn disabled={busy === s.code + it.key} onClick={() => decide(s.code, it.key, 0.25)} cls="bg-amber-600">25%</Btn>
                      <Btn disabled={busy === s.code + it.key} onClick={() => decide(s.code, it.key, 0.5)} cls="bg-red-700">50%</Btn>
                      <Btn disabled={busy === s.code + it.key} onClick={() => decide(s.code, it.key, 0)} cls="bg-gray-200 !text-gray-700">Reject</Btn>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mt-1 text-sm">
                      <span className={it.fraction > 0 ? 'text-red-700 font-medium' : 'text-gray-500'}>{it.fraction > 0 ? `−${it.fraction * 100}%` : 'rejected'}</span>
                      <button onClick={() => decide(s.code, it.key, null)} disabled={busy === s.code + it.key} className="text-xs text-gray-500 underline">undo</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function Btn({ onClick, disabled, cls, children }) {
  return <button onClick={onClick} disabled={disabled} className={`flex-1 ${cls} text-white rounded-lg py-1.5 text-sm font-medium disabled:opacity-50`}>{children}</button>;
}
function fmt(ymd) { const [, m, d] = ymd.split('-'); return `${+d}/${+m}`; }
