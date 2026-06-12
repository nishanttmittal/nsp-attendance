import { useEffect, useState } from 'react';
import { loadAbsenceDockTasks, saveAbsenceDock } from '../lib/data';

// Absence dock approval tasks: every 3 real absences → 1 Saturday cut, each approved per person.
// (Fix missed punches in the Punch tab first so absences are real.)
export default function AbsenceDocks({ user }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const refresh = () => loadAbsenceDockTasks().then(setData).catch(() => setData({ staff: [] }));
  useEffect(() => { refresh(); }, []);

  async function decide(code, index, approved) {
    setBusy(code + index); await saveAbsenceDock(code, data.month, index, approved); await refresh(); setBusy('');
  }

  if (!data) return null;
  if (data.staff.length === 0) return null;

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800">Absence docks · cut 1 Saturday per 3 absences</div>
      <p className="text-xs text-gray-500 mt-1 mb-3">Approve each cut per person (or reject). Realtime doesn't pre-cut these. Fix missed punches first so absences are real.</p>
      <div className="space-y-3">
        {data.staff.map((s) => (
          <div key={s.code} className="border border-gray-100 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <div><span className="font-medium text-gray-800">{s.name}</span> <span className="text-xs text-gray-500">· {s.absent} absent</span></div>
              {s.approved > 0 && <span className="text-sm font-semibold text-red-700">−{s.approved} Sat</span>}
            </div>
            <ul className="divide-y divide-gray-100">
              {s.items.map((it) => (
                <li key={it.index} className="py-1.5 flex items-center justify-between">
                  <span className="text-sm text-gray-600">{it.label}</span>
                  {it.status === 'pending' ? (
                    <span className="flex gap-2">
                      <button disabled={busy === s.code + it.index} onClick={() => decide(s.code, it.index, true)} className="bg-red-700 text-white rounded px-3 py-1 text-xs font-medium disabled:opacity-50">Cut</button>
                      <button disabled={busy === s.code + it.index} onClick={() => decide(s.code, it.index, false)} className="border border-gray-300 text-gray-700 rounded px-3 py-1 text-xs">Skip</button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-sm">
                      <span className={it.status === 'approved' ? 'text-red-700 font-medium' : 'text-gray-500'}>{it.status === 'approved' ? 'cut −1 Sat' : 'skipped'}</span>
                      <button onClick={() => decide(s.code, it.index, null)} disabled={busy === s.code + it.index} className="text-xs text-gray-500 underline">undo</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
