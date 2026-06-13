import { useEffect, useState } from 'react';
import { loadMissedDoc, loadLateList, loadEmployees, loadRoster, loadAllAttendance, loadPayout, decideResignPrompt, leaveMissedPunch, queueScanMissed, queueReprocess, queueJob, istMonth } from '../lib/data';
import { monthOptions } from '../lib/paycalc';
import { SHIFT_HOURS } from '../lib/payroll';
import NamePick from './NamePick.jsx';

const SHIFT_START = '09:00';                  // factory standard morning start (owner-confirmed)
const addHrs = (hhmm, h) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); if (!m) return '';
  let t = Math.max(0, Math.min(23 * 60 + 59, +m[1] * 60 + +m[2] + Math.round(h * 60)));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// PROBLEMS — the bot tells you on Telegram each morning; here you fix things in two taps.
export default function Problems({ user }) {
  const mk = istMonth();
  const [mMonth, setMMonth] = useState(mk);   // month being reviewed for missed/short punches
  const [missed, setMissed] = useState([]);
  const [short, setShort] = useState([]);
  const [late, setLate] = useState([]);
  const [resigns, setResigns] = useState([]);
  const [highOt, setHighOt] = useState([]);
  const [unpaid, setUnpaid] = useState(0);
  const [leftSet, setLeftSet] = useState(new Set());
  const [roster, setRoster] = useState([]);
  const [busy, setBusy] = useState('');
  const [scanSt, setScanSt] = useState('');
  const isAdmin = user.role === 'admin';

  // current-month concerns (late / resign / high-OT / unpaid)
  async function reload() {
    const ros = await loadRoster();
    setRoster(ros);
    try {
      const po = await loadPayout(mk);
      setUnpaid(Object.values(po.items || {}).filter((i) => !i.paid).length);
    } catch { /* ignore */ }
    if (isAdmin) {
      try {
        const emps = await loadEmployees(true);
        setResigns(emps.filter((e) => e.resignPrompt?.status === 'pending' && e.active !== false));
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
  // missed / short punches for the SELECTED month
  async function reloadMissed() {
    const md = await loadMissedDoc(mMonth);
    setMissed(md.entries || []); setShort(md.shortHours || []);
    try { setLate(await loadLateList(mMonth, 3)); } catch { /* ignore */ }
    try {
      const emps = await loadEmployees(true);
      setLeftSet(new Set(emps.flatMap((e) => ((e.missedLeave || {})[mMonth] || []).map((d) => e.code + '|' + d))));
    } catch { /* ignore */ }
  }
  useEffect(() => { reload(); }, []);
  useEffect(() => { reloadMissed(); }, [mMonth]);
  const act = async (key, fn) => { setBusy(key); try { await fn(); await reloadMissed(); } finally { setBusy(''); } };

  const shiftHrsOf = (code) => SHIFT_HOURS[(roster.find((x) => x.code === code) || {}).shift] || 8;
  const visMissed = missed.filter((m) => !leftSet.has(m.code + '|' + m.date));

  // apply a chosen correction → manual punch job (the day reprocesses automatically)
  function applyPunch(m, { in: inT, out: outT, remark }) {
    return queueJob('manual_punch', { emp: m.code, date: m.date, in: inT || '', out: outT || '', remark, reason: remark }, user.email);
  }
  async function rescan() {
    setScanSt('scanning'); setBusy('scan');
    try { await queueScanMissed(mMonth, user.email); setScanSt('queued'); }
    catch { setScanSt('failed'); } finally { setBusy(''); }
  }

  const monthLabel = monthOptions(6).find((o) => o.mk === mMonth)?.label || mMonth;

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

      {/* MONTH PICKER + RESCAN — governs all three lists below: missed punches, late marks, short days */}
      <div className="bg-white rounded-xl shadow p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="font-semibold text-gray-800 text-sm flex-1">⏱ Missed punches</div>
          <select value={mMonth} onChange={(e) => setMMonth(e.target.value)} className="border rounded-lg px-2 py-1 text-xs bg-white">
            {monthOptions(6).map((o) => <option key={o.mk} value={o.mk}>{o.label}</option>)}
          </select>
          <button disabled={busy === 'scan'} onClick={rescan} className="border border-gray-300 rounded-lg px-2.5 py-1 text-xs disabled:opacity-50">🔍 Rescan</button>
        </div>
        <p className="text-[11px] text-gray-400 mb-1">Month + Rescan apply to all three lists below — missed punches, late marks & short days.</p>
        {scanSt === 'queued' && <p className="text-xs text-blue-700 mb-1">Rescanning {monthLabel} (missed punches · late marks · short days) from the machine… refresh in a few minutes.</p>}
        {scanSt === 'failed' && <p className="text-xs text-red-600 mb-1">Couldn't queue rescan — try again.</p>}
        <p className="text-xs text-gray-400 mb-1">Each one asks you to confirm — fill the missing punch with shift time, mark overtime, or half-day if he left early.</p>
        {visMissed.length === 0 && <p className="text-sm text-gray-400 py-1">No pending missed punches in {monthLabel} 🎉</p>}
        {visMissed.map((m) => (
          <MissedRow key={m.code + m.date} m={m} shiftHrs={shiftHrsOf(m.code)} busy={busy === m.code + m.date} isAdmin={isAdmin}
            onApply={(payload) => act(m.code + m.date, () => applyPunch(m, payload))}
            onLeave={isAdmin ? () => act(m.code + m.date, () => leaveMissedPunch(m.code, mMonth, m.date)) : undefined} />
        ))}
      </div>

      <Card title={`⏰ Late 3+ days (${late.length})`} sub={`Pay cuts happen by the machine rules automatically — this is just for your eye · ${monthLabel}.`}>
        {late.length === 0 && <p className="text-sm text-gray-400 py-1">No one with 3+ late days in {monthLabel} 🎉</p>}
        {late.map((l) => <LateRow key={l.code} l={l} />)}
      </Card>

      <Card title={`🕐 Short days (${short.length})`} sub={`Punched both times but worked less than the shift — ${monthLabel}.`}>
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

      {isAdmin && <ReprocessCard user={user} defaultMonth={mMonth} />}

      <AddPunch roster={roster} user={user} />
    </div>
  );
}

// REPROCESS ATTENDANCE for a date range — recalculates present/OT/late on the machine from the
// existing punches (e.g. after a settings fix or bulk correction). Deletes nothing. Admin only.
function ReprocessCard({ user, defaultMonth }) {
  const monthStart = (defaultMonth || '') + '-01';
  const lastDay = defaultMonth ? new Date(+defaultMonth.slice(0, 4), +defaultMonth.slice(5, 7), 0).toISOString().slice(0, 10) : '';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(lastDay);
  const [st, setSt] = useState('');
  const toDMY = (ymd) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

  async function run() {
    const f = toDMY(from), t = toDMY(to);
    if (!f || !t) { setSt('bad'); return; }
    if (from > to) { setSt('order'); return; }
    if (!confirm(`Reprocess attendance for ALL staff from ${f} to ${t}?\n\nThis recalculates present days, OT and late from the existing punches on the machine. It does not delete anything.`)) return;
    setSt('busy');
    try { await queueReprocess(f, t, user.email); setSt('queued'); }
    catch { setSt('failed'); }
  }

  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="font-semibold text-gray-800 text-sm mb-1">🔄 Reprocess attendance</div>
      <p className="text-[11px] text-gray-400 mb-2">Recalculate present / OT / late for a period from the existing punches (after a rule fix or bulk correction). Nothing is deleted.</p>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">From</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded-lg px-2 py-1 text-xs" />
        <label className="text-xs text-gray-500">To</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded-lg px-2 py-1 text-xs" />
        <button disabled={st === 'busy'} onClick={run} className="ml-auto bg-blue-700 text-white rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">Reprocess</button>
      </div>
      {st === 'queued' && <p className="text-xs text-blue-700 mt-2">Queued — the machine is recalculating. Rescan the month above in a few minutes to see corrected figures.</p>}
      {st === 'order' && <p className="text-xs text-red-600 mt-2">"From" date must be on or before "To".</p>}
      {st === 'bad' && <p className="text-xs text-red-600 mt-2">Pick both dates.</p>}
      {st === 'failed' && <p className="text-xs text-red-600 mt-2">Couldn't queue — try again.</p>}
    </div>
  );
}

// One missed-punch row: shows who/when/which punch is missing, then ASKS you to choose and
// CONFIRM — full day (shift time), worked overtime (type real time), left early (half day),
// or leave as is. Nothing is applied until you confirm.
function MissedRow({ m, shiftHrs, busy, isAdmin, onApply, onLeave }) {
  const [choice, setChoice] = useState('');   // '', 'full', 'ot', 'half'
  const [ot, setOt] = useState('');
  const missingOut = m.which === 'out';        // came in, forgot to punch out
  const existing = `${missingOut ? 'in' : 'out'} ${m.otherTime}`;

  // resulting punch pair for each choice
  const full = missingOut ? { in: m.otherTime, out: addHrs(m.otherTime, shiftHrs) } : { in: SHIFT_START, out: m.otherTime };
  const half = missingOut ? { in: m.otherTime, out: addHrs(m.otherTime, shiftHrs * 0.5) } : { in: addHrs(m.otherTime, -shiftHrs * 0.5), out: m.otherTime };
  const otPair = missingOut ? { in: m.otherTime, out: ot } : { in: ot, out: m.otherTime };

  const reset = () => { setChoice(''); setOt(''); };
  const confirm = (pair, remark) => { onApply({ ...pair, remark }); reset(); };

  return (
    <div className="py-2 border-t border-gray-50 first:border-0">
      <div className="flex justify-between text-sm">
        <span className="font-medium text-gray-800">{m.name} <span className="text-gray-400 text-xs font-normal">{m.date}</span></span>
        <span className="text-xs text-amber-700">no {m.which.toUpperCase()} <span className="text-gray-400">({existing})</span></span>
      </div>

      {!choice && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          <button disabled={busy} onClick={() => setChoice('full')} className="bg-green-700 text-white rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">Full day</button>
          {missingOut && <button disabled={busy} onClick={() => setChoice('ot')} className="bg-blue-700 text-white rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">Worked overtime</button>}
          <button disabled={busy} onClick={() => setChoice('half')} className="bg-amber-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">Left early (½ day)</button>
          {missingOut && onLeave && <button disabled={busy} onClick={onLeave} className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Leave as is</button>}
        </div>
      )}

      {choice === 'full' && (
        <Confirm busy={busy} text={`Pay full day — set IN ${full.in} · OUT ${full.out}?`} onCancel={reset} onOk={() => confirm(full, 'full day (missed punch)')} />
      )}
      {choice === 'half' && (
        <Confirm busy={busy} text={`Half day — set IN ${half.in} · OUT ${half.out}?`} onCancel={reset} onOk={() => confirm(half, 'half day — left early (missed punch)')} />
      )}
      {choice === 'ot' && (
        <div className="mt-1.5 bg-blue-50 rounded-lg p-2">
          <p className="text-xs text-gray-600 mb-1">He stayed late — enter the real OUT time:</p>
          <div className="flex gap-1.5 items-center">
            <span className="text-xs text-gray-500">IN {m.otherTime} · OUT</span>
            <input className="border rounded-lg px-2 py-1 w-20 text-xs" placeholder="HH:MM" value={ot} onChange={(e) => setOt(e.target.value)} />
            <button disabled={busy || !/^\d{1,2}:\d{2}$/.test(ot)} onClick={() => confirm(otPair, 'worked overtime (missed punch)')} className="bg-blue-700 text-white rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-40">Confirm</button>
            <button disabled={busy} onClick={reset} className="text-xs text-gray-500 px-1">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Confirm({ text, onOk, onCancel, busy }) {
  return (
    <div className="mt-1.5 bg-gray-50 rounded-lg p-2 flex items-center gap-2">
      <span className="flex-1 text-xs text-gray-700">{text}</span>
      <button disabled={busy} onClick={onOk} className="bg-green-700 text-white rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-50">Confirm</button>
      <button disabled={busy} onClick={onCancel} className="text-xs text-gray-500 px-1">Cancel</button>
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
