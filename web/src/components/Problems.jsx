import { useEffect, useState } from 'react';
import { loadMissedDoc, loadLateList, loadEmployees, loadRoster, loadAllAttendance, loadPayout, decideResignPrompt, leaveMissedPunch, queueJob, istMonth } from '../lib/data';
import { SHIFT_HOURS } from '../lib/payroll';
import NamePick from './NamePick.jsx';

const addHrs = (hhmm, h) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); if (!m) return '';
  let t = Math.max(0, Math.min(23 * 60 + 59, +m[1] * 60 + +m[2] + Math.round(h * 60)));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// PROBLEMS — the bot tells you on Telegram each morning; here you fix things in two taps.
export default function Problems({ user }) {
  const mk = istMonth();
  const [missed, setMissed] = useState([]);
  const [short, setShort] = useState([]);
  const [late, setLate] = useState([]);
  const [resigns, setResigns] = useState([]);
  const [highOt, setHighOt] = useState([]);
  const [unpaid, setUnpaid] = useState(0);
  const [leftSet, setLeftSet] = useState(new Set());
  const [roster, setRoster] = useState([]);
  const [busy, setBusy] = useState('');
  const isAdmin = user.role === 'admin';

  async function reload() {
    const [md, lateList, ros] = await Promise.all([loadMissedDoc(mk), loadLateList(mk, 3), loadRoster()]);
    setMissed(md.entries || []); setShort(md.shortHours || []); setLate(lateList); setRoster(ros);
    try { // ticked but not yet handed over (manager-readable payout doc)
      const po = await loadPayout(mk);
      setUnpaid(Object.values(po.items || {}).filter((i) => !i.paid).length);
    } catch { /* ignore */ }
    if (isAdmin) {
      try {
        const emps = await loadEmployees(true);
        setResigns(emps.filter((e) => e.resignPrompt?.status === 'pending' && e.active !== false));
        setLeftSet(new Set(emps.flatMap((e) => ((e.missedLeave || {})[mk] || []).map((d) => e.code + '|' + d))));
        // abnormal OT: > 4h average OT per present day (and at least 20h) — the May bug would
        // have lit this up on day one
        const am = await loadAllAttendance();
        const names = Object.fromEntries(emps.map((e) => [e.code, e.name || e.code]));
        const flags = [];
        for (const [code, a] of Object.entries(am)) {
          const rec = (a.months && a.months[mk]) || (a.month === mk ? a : null);
          if (!rec || !rec.presentDays) continue;
          const perDay = rec.otHrs / rec.presentDays;
          if (rec.otHrs >= 20 && perDay > 4) flags.push({ code, name: names[code] || code, ot: Math.round(rec.otHrs), perDay: +perDay.toFixed(1), days: rec.presentDays });
        }
        flags.sort((a, b) => b.perDay - a.perDay);
        setHighOt(flags);
      } catch { /* ignore */ }
    }
  }
  useEffect(() => { reload(); }, []);
  const act = async (key, fn) => { setBusy(key); try { await fn(); await reload(); } finally { setBusy(''); } };

  const shiftHrsOf = (code) => SHIFT_HOURS[(roster.find((x) => x.code === code) || {}).shift] || 8;
  const visMissed = missed.filter((m) => !leftSet.has(m.code + '|' + m.date));

  // half-day fill / set-real-time → manual punch job (day reprocesses automatically)
  function fillPunch(m, fraction, manualTime) {
    const p = { emp: m.code, date: m.date, in: '', out: '', remark: fraction ? 'half day (missed punch)' : 'real time (missed punch)' };
    const span = shiftHrsOf(m.code) * (fraction || 1);
    if (m.which === 'out') { p.in = m.otherTime; p.out = manualTime || addHrs(m.otherTime, span); }
    else { p.out = m.otherTime; p.in = manualTime || addHrs(m.otherTime, -span); }
    return queueJob('manual_punch', p, user.email);
  }

  return (
    <div className="space-y-3">
      {unpaid > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          💵 <b>{unpaid}</b> ticked but not yet paid — check the Salary page.
        </div>
      )}

      {highOt.length > 0 && (
        <Card title={`⚡ Unusually high OT (${highOt.length})`} sub="More than 4 hrs OT per working day — check these are real before paying.">
          {highOt.map((h) => (
            <div key={h.code} className="py-1.5 flex justify-between text-sm border-t border-gray-50 first:border-0">
              <span>{h.name}</span>
              <span className="text-red-700 font-semibold">{h.ot}h <span className="text-gray-400 font-normal">({h.perDay}h/day · {h.days}d)</span></span>
            </div>
          ))}
        </Card>
      )}

      {resigns.length > 0 && (
        <Card title={`🚪 Absent a full month (${resigns.length})`} sub="Remove from salary list?">
          {resigns.map((e) => (
            <div key={e.code} className="py-2 flex items-center gap-2">
              <span className="flex-1 text-sm">{e.name || e.code} <span className="text-gray-400 text-xs">0 days in {e.resignPrompt.month}</span></span>
              <button disabled={!!busy} onClick={() => { if (confirm(`Resign ${e.name}?`)) act(e.code, () => decideResignPrompt(e.code, 'resigned', user.email)); }}
                className="bg-red-700 text-white text-xs rounded-lg px-3 py-1.5">Resign</button>
              <button disabled={!!busy} onClick={() => act(e.code, () => decideResignPrompt(e.code, 'kept', user.email))}
                className="border border-gray-300 text-xs rounded-lg px-3 py-1.5">Keep</button>
            </div>
          ))}
        </Card>
      )}

      <Card title={`⏱ Missed punches (${visMissed.length})`} sub="Already counted as full day till shift end. Fix only if the truth was different.">
        {visMissed.length === 0 && <p className="text-sm text-gray-400 py-1">None pending 🎉</p>}
        {visMissed.map((m) => <MissedRow key={m.code + m.date} m={m} busy={busy === m.code + m.date} isAdmin={isAdmin}
          onLeave={isAdmin ? () => act(m.code + m.date, () => leaveMissedPunch(m.code, mk, m.date)) : undefined}
          onHalf={() => act(m.code + m.date, () => fillPunch(m, 0.5))}
          onTime={(t) => act(m.code + m.date, () => fillPunch(m, 0, t))} />)}
      </Card>

      <Card title={`⏰ Late 3+ days (${late.length})`} sub="Pay cuts happen by the machine rules automatically — this is just for your eye.">
        {late.length === 0 && <p className="text-sm text-gray-400 py-1">No one yet 🎉</p>}
        {late.map((l) => <LateRow key={l.code} l={l} />)}
      </Card>

      <Card title={`🕐 Short days (${short.length})`} sub="Punched both times but worked less than the shift.">
        {short.length === 0 && <p className="text-sm text-gray-400 py-1">None this month</p>}
        <div className="max-h-64 overflow-auto">
          {short.map((s, i) => (
            <div key={i} className="py-1.5 flex justify-between text-sm border-t border-gray-50 first:border-0">
              <span>{s.name} <span className="text-gray-400 text-xs">{s.date}</span></span>
              <span className="text-amber-700">{s.hours}h<span className="text-gray-400">/{s.need}h · {s.in}–{s.out}</span></span>
            </div>
          ))}
        </div>
      </Card>

      <AddPunch roster={roster} user={user} />
    </div>
  );
}

function MissedRow({ m, busy, onLeave, onHalf, onTime }) {
  const [t, setT] = useState('');
  return (
    <div className="py-2 border-t border-gray-50 first:border-0">
      <div className="flex justify-between text-sm">
        <span>{m.name} <span className="text-gray-400 text-xs">{m.date}</span></span>
        <span className="text-xs text-amber-700">no {m.which.toUpperCase()} ({m.which === 'out' ? 'in' : 'out'} {m.otherTime})</span>
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {onLeave && <button disabled={busy} onClick={onLeave} className="flex-1 bg-green-700 text-white rounded-lg py-1.5 text-xs font-medium">OK, full day</button>}
        <button disabled={busy} onClick={onHalf} className="flex-1 bg-amber-600 text-white rounded-lg py-1.5 text-xs font-medium">Half day</button>
        <input className="border rounded-lg px-2 w-20 text-xs" placeholder="HH:MM" value={t} onChange={(e) => setT(e.target.value)} />
        <button disabled={busy || !/^\d{1,2}:\d{2}$/.test(t)} onClick={() => onTime(t)} className="border border-gray-300 rounded-lg px-2.5 text-xs disabled:opacity-40">Set</button>
      </div>
    </div>
  );
}

function LateRow({ l }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-1.5 border-t border-gray-50 first:border-0">
      <button onClick={() => setOpen(!open)} className="w-full flex justify-between text-sm">
        <span>{l.name} <span className="text-gray-400 text-xs">{l.dept}</span></span>
        <span className={`font-semibold ${l.count >= 5 ? 'text-red-700' : 'text-amber-700'}`}>{l.count}× late</span>
      </button>
      {open && <div className="text-xs text-gray-500 mt-1">{l.days.map((d) => `${d.date.slice(8)} → ${d.inT}`).join(' · ')}</div>}
    </div>
  );
}

function AddPunch({ roster, user }) {
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ code: null, name: '', date: '', in: '', out: '', reason: '' });
  const [st, setSt] = useState('');
  async function go() {
    if (!f.code) { setSt('Type the name — it will suggest from the list.'); return; }
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(f.date)) { setSt('Date must be dd/mm/yyyy, e.g. 09/06/2026.'); return; }
    if (!f.in && !f.out) { setSt('Fill at least one time (HH:MM).'); return; }
    setSt('saving');
    try { await queueJob('manual_punch', { emp: f.code, date: f.date, in: f.in, out: f.out, remark: 'manual', reason: f.reason || 'manual correction' }, user.email); setSt('done'); setF({ code: null, name: '', date: '', in: '', out: '', reason: '' }); }
    catch { setSt('Failed — try again.'); }
  }
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-600">＋ Add a punch manually {show ? '▲' : '▼'}</button>
      {show && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <NamePick roster={roster} value={f.name} onChange={(code, name) => setF({ ...f, code, name })} className="col-span-2" />
          {f.name && !f.code && <p className="col-span-2 text-xs text-amber-700">Keep typing — more than one name matches.</p>}
          <input className="border rounded px-2 py-2 text-sm" placeholder="dd/mm/yyyy" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <div className="grid grid-cols-2 gap-1">
            <input className="border rounded px-2 py-2 text-sm" placeholder="IN 09:00" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} />
            <input className="border rounded px-2 py-2 text-sm" placeholder="OUT 19:30" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} />
          </div>
          <input className="border rounded px-2 py-2 text-sm col-span-2" placeholder="Reason (e.g. machine breakdown, worker was present)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-gray-800 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Add punch</button>
          {st === 'done' && <p className="col-span-2 text-xs text-green-700">✓ Added — day reprocesses automatically.</p>}
          {st && !['saving', 'done'].includes(st) && <p className="col-span-2 text-xs text-amber-700">{st}</p>}
        </div>
      )}
    </div>
  );
}

function Card({ title, sub, children }) {
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="font-semibold text-gray-800 text-sm">{title}</div>
      {sub && <p className="text-xs text-gray-400 mb-1">{sub}</p>}
      {children}
    </div>
  );
}
