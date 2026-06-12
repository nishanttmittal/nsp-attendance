import { useEffect, useState } from 'react';
import { loadLatePenaltyTasks, saveLatePenalty } from '../lib/data';

// Approval tasks for the late-arrival rule: 4+ late marks in the month → owner approves
// 25% (¼ day) / 50% (½ day) or rejects. Decided items move to the log below.
export default function LatePenalties({ user }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const refresh = () => loadLatePenaltyTasks().then(setData).catch(() => setData({ pending: [], decided: [] }));
  useEffect(() => { refresh(); }, []);

  async function decide(code, fraction) {
    setBusy(code); await saveLatePenalty(code, data.month, fraction, user.email); await refresh(); setBusy('');
  }

  if (!data) return <p className="text-gray-500">Loading…</p>;
  const monthName = data.month ? new Date(data.month + '-01').toLocaleString('en', { month: 'long', year: 'numeric' }) : '';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-semibold text-gray-800">Late-arrival penalties · {monthName}</div>
        <p className="text-xs text-gray-500 mt-1">Anyone with <b>4+ late marks</b> (in &gt;15 min after grace). Approve a deduction or reject — it then applies in Salary.</p>
      </div>

      {data.pending.length === 0
        ? <div className="bg-white rounded-xl shadow p-4 text-sm text-gray-500">No pending late penalties. 🎉</div>
        : data.pending.map((t) => (
          <div key={t.code} className="bg-white rounded-xl shadow p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-800">{t.name}</div>
                <div className="text-xs text-gray-500">{t.dept} · {t.code}</div>
              </div>
              <div className="text-sm font-semibold text-amber-700">{t.count} late</div>
            </div>
            <ul className="text-xs text-gray-600 mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
              {t.lateDays.map((d) => <li key={d.date}>{fmt(d.date)} · in {d.inT || '—'}</li>)}
            </ul>
            <div className="flex gap-2 mt-3">
              <button disabled={busy === t.code} onClick={() => decide(t.code, 0.25)} className="flex-1 bg-amber-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Deduct 25%</button>
              <button disabled={busy === t.code} onClick={() => decide(t.code, 0.5)} className="flex-1 bg-red-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Deduct 50%</button>
              <button disabled={busy === t.code} onClick={() => decide(t.code, 0)} className="border border-gray-300 text-gray-700 rounded-lg py-2 px-3 text-sm">Reject</button>
            </div>
          </div>
        ))}

      {data.decided.length > 0 && (
        <div className="bg-white rounded-xl shadow p-4">
          <div className="font-semibold text-gray-800 mb-2">Decided (log)</div>
          <ul className="text-sm divide-y divide-gray-100">
            {data.decided.map((t) => (
              <li key={t.code} className="py-2 flex items-center justify-between">
                <span>{t.name} <span className="text-gray-400">· {t.count} late</span></span>
                <span className="flex items-center gap-2">
                  <span className={t.fraction > 0 ? 'text-red-700 font-medium' : 'text-gray-500'}>
                    {t.fraction > 0 ? `−${t.fraction * 100}%` : 'rejected'}
                  </span>
                  <button onClick={() => decide(t.code, 0)} disabled={busy === t.code} className="text-xs text-gray-500 underline">undo</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmt(ymd) {
  const [, m, d] = ymd.split('-');
  return `${+d}/${+m}`;
}
