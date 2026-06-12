import { useEffect, useState } from 'react';
import { loadMissedDoc, loadLateList, loadEmployees, decideResignPrompt, leaveMissedPunch, istMonth } from '../lib/data';
import ManualPunch from './ManualPunch.jsx';

// Everything that needs the owner's eye, in one tab:
// 1. missed punches (fix or leave-as-is), 2. 3+ late days, 3. short-hours days,
// 4. absent-a-full-month → remove/resign, 5. manual punch form.
export default function Attention({ user }) {
  const mk = istMonth();
  const [late, setLate] = useState([]);
  const [short, setShort] = useState([]);
  const [resigns, setResigns] = useState([]);
  const [leftSet, setLeftSet] = useState(new Set());
  const [openLate, setOpenLate] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === 'admin';

  async function reload() {
    const [md, lateList] = await Promise.all([loadMissedDoc(mk), loadLateList(mk, 3)]);
    setShort(md.shortHours || []);
    setLate(lateList);
    try { // att_salary reads are admin-only; managers just don't see these two sections
      const emps = await loadEmployees(true);
      setResigns(emps.filter((e) => e.resignPrompt?.status === 'pending' && e.active !== false));
      setLeftSet(new Set(emps.flatMap((e) => ((e.missedLeave || {})[mk] || []).map((d) => e.code + '|' + d))));
    } catch { /* manager role */ }
  }
  useEffect(() => { reload(); }, []);

  return (
    <div className="space-y-4">
      {resigns.length > 0 && (
        <div className="bg-white rounded-xl shadow p-4 border-l-4 border-red-600">
          <div className="font-semibold text-gray-800 mb-1">Absent a full month — remove?</div>
          <ul className="divide-y divide-gray-100">
            {resigns.map((e) => (
              <li key={e.code} className="py-2">
                <div className="text-sm">{e.name || e.code} <span className="text-gray-400 text-xs">· 0 days in {e.resignPrompt.month}</span></div>
                <div className="flex gap-2 mt-1.5">
                  <button disabled={busy} onClick={async () => { if (!confirm(`Resign ${e.name}? (also disable on the machine)`)) return; setBusy(true); try { await decideResignPrompt(e.code, 'resigned', user.email); await reload(); } finally { setBusy(false); } }}
                    className="flex-1 bg-red-700 text-white rounded py-1.5 text-xs font-medium">Resign & remove</button>
                  <button disabled={busy} onClick={async () => { setBusy(true); try { await decideResignPrompt(e.code, 'kept', user.email); await reload(); } finally { setBusy(false); } }}
                    className="flex-1 border border-gray-300 rounded py-1.5 text-xs">Keep</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-semibold text-gray-800">Late 3+ days this month ({late.length})</div>
        <p className="text-xs text-gray-500 mb-1">Pay cuts are applied by the machine rules automatically — this list is for your eye.</p>
        {late.length === 0 ? <p className="text-sm text-gray-400">No one yet 🎉</p> : (
          <ul className="divide-y divide-gray-100">
            {late.map((l) => (
              <li key={l.code} className="py-1.5 text-sm">
                <button className="w-full flex justify-between" onClick={() => setOpenLate(openLate === l.code ? '' : l.code)}>
                  <span>{l.name} <span className="text-gray-400 text-xs">{l.dept}</span></span>
                  <span className={`font-semibold ${l.count >= 5 ? 'text-red-700' : 'text-amber-700'}`}>{l.count}× late</span>
                </button>
                {openLate === l.code && <div className="text-xs text-gray-500 mt-1">{l.days.map((d) => `${d.date.slice(8)}th ${d.inT}`).join(' · ')}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-semibold text-gray-800">Worked less than duty hours ({short.length})</div>
        <p className="text-xs text-gray-500 mb-1">Both punches present but hours below the shift (lunch deducted).</p>
        {short.length === 0 ? <p className="text-sm text-gray-400">None this month</p> : (
          <ul className="divide-y divide-gray-100 max-h-72 overflow-auto text-sm">
            {short.map((s, i) => (
              <li key={s.code + s.date + i} className="py-1.5 flex justify-between">
                <span>{s.name} <span className="text-gray-400 text-xs">· {s.date}</span></span>
                <span className="text-amber-700">{s.hours}h <span className="text-gray-400">/ {s.need}h</span> <span className="text-gray-400 text-xs">({s.in}–{s.out})</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ManualPunch user={user} leftSet={leftSet}
        onLeave={isAdmin ? async (m) => { await leaveMissedPunch(m.code, mk, m.date); await reload(); } : undefined} />
    </div>
  );
}
