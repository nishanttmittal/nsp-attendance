import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, saveEmployee, loadPayout, queueMarkPaid, queueAdvance, loadRoster, approveSalary, unapproveSalary, istMonth, queueJob } from '../lib/data';
import { monthOptions, monthCtx, payFor, rupee } from '../lib/paycalc';
import Person from './Person.jsx';
import SelfPunchCard from './SelfPunchCard.jsx';

// SALARY — owner ticks person by person; manager sees ticked list and marks PAID.
export default function Salary({ user }) {
  return user.role === 'admin' ? <OwnerSalary user={user} /> : <ManagerSalary user={user} />;
}

/* ---------------- owner view ---------------- */
function OwnerSalary({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [q, setQ] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState('');
  const ctx = useMemo(() => monthCtx(mk), [mk]);

  async function reload() {
    const [list, am] = await Promise.all([loadEmployees(), loadAllAttendance()]);
    setEmps(list); setAttMap(am);
  }
  useEffect(() => { reload(); }, []);

  if (openCode) return <Person code={openCode} mk={mk} user={user} onBack={() => { setOpenCode(''); reload(); }} />;
  if (emps === null) return <p className="text-gray-500">Loading…</p>;

  const rows = emps.filter((e) => e.amount || e.wage).map((e) => ({ emp: e, ...payFor(e, attMap, mk, ctx) }));
  const ticked = rows.filter((r) => r.md.approved);
  const paid = ticked.filter((r) => r.md.payment);
  const visible = rows.filter((r) => !q || (r.emp.name || '').toLowerCase().includes(q.toLowerCase()));
  const noSalary = emps.filter((e) => !(e.amount || e.wage));

  async function tick(r) {
    setBusy(r.emp.code);
    try {
      if (r.md.approved) await unapproveSalary(r.emp.code, mk);
      else await approveSalary(r.emp.code, mk, r.pay, user.email);
      await reload();
    } finally { setBusy(''); }
  }

  async function tickAll() {
    const remaining = rows.filter((r) => !r.md.approved && r.pay.net > 0);
    if (!remaining.length) return;
    if (!confirm(`Tick all remaining ${remaining.length} people for ${mk}?`)) return;
    setBusy('all');
    try {
      for (const r of remaining) await approveSalary(r.emp.code, mk, r.pay, user.email);
      await reload();
    } finally { setBusy(''); }
  }

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-xl shadow p-3 space-y-2">
        <div className="flex gap-2">
          <select className="flex-1 border rounded-lg px-3 py-2 bg-white font-medium" value={mk} onChange={(e) => setMk(e.target.value)}>
            {monthOptions().map((m) => <option key={m.mk} value={m.mk}>{m.label}{m.mk === istMonth() ? ' (running)' : ''}</option>)}
          </select>
          <button onClick={() => setShowReport(true)} className="border border-gray-300 rounded-lg px-3 text-sm font-medium">📄 Report</button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-sm text-gray-600">
            <b className="text-gray-800">{ticked.length}</b> of {rows.length} ticked · <b className="text-green-700">{paid.length}</b> paid ({rupee(paid.reduce((s, r) => s + Number(r.md.payment?.net || 0), 0))})
          </div>
          {rows.some((r) => !r.md.approved && r.pay.net > 0) && (
            <button disabled={busy === 'all'} onClick={tickAll} className="text-xs border border-red-300 text-red-700 rounded-lg px-2.5 py-1.5 font-medium disabled:opacity-50">
              {busy === 'all' ? 'Ticking…' : `✓ Tick all (${rows.filter((r) => !r.md.approved && r.pay.net > 0).length})`}
            </button>
          )}
        </div>
        {!ctx.fullMonth && <p className="text-xs text-gray-400">Running month — figures till yesterday.</p>}
      </div>

      <input className="w-full border rounded-lg px-3 py-2" placeholder="🔍 Search name…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="bg-white rounded-xl shadow divide-y divide-gray-100">
        {visible.length === 0 && <p className="p-4 text-sm text-gray-400">No one matches.</p>}
        {visible.map((r) => <OwnerRow key={r.emp.code} r={r} busy={busy === r.emp.code} onName={() => setOpenCode(r.emp.code)} onTick={() => tick(r)} />)}
      </div>

      {mk === istMonth() && <SelfPunchCard />}
      {noSalary.length > 0 && <NoSalaryList list={noSalary} onSaved={reload} />}
      {showReport && <ReportModal user={user} onClose={() => setShowReport(false)} />}
    </div>
  );
}

function OwnerRow({ r, busy, onName, onTick }) {
  const { emp, md, pay } = r;
  const isPaid = !!md.payment, isTicked = !!md.approved;
  const sub = [
    `${pay.presentDays}d`,
    pay.otHrsNet > 0 ? `OT ${pay.otHrsNet}h` : null,
    pay.advanceRecovered > 0 ? `adv −${rupee(pay.advanceRecovered)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center p-3 gap-2">
      <button onClick={onName} className="flex-1 text-left">
        <div className="font-medium text-gray-800">{emp.name || emp.code}</div>
        <div className="text-xs text-gray-500">{sub}</div>
      </button>
      <div className="text-right">
        <div className="font-bold text-red-700">{rupee(isPaid ? md.payment.net : (isTicked ? md.approvedNet : pay.net))}</div>
        {isPaid ? <span className="text-[11px] text-green-700 font-medium">✓ PAID ({md.payment.mode})</span>
          : isTicked ? <button disabled={busy} onClick={onTick} className="text-[11px] text-amber-700 underline">ticked · undo</button>
          : <button disabled={busy} onClick={onTick} className="text-xs bg-red-700 text-white rounded-lg px-3 py-1.5 font-medium disabled:opacity-50">✓ Tick</button>}
      </div>
    </div>
  );
}

/* ---------------- manager view ---------------- */
function ManagerSalary({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [payout, setPayout] = useState(null);
  const [done, setDone] = useState({});       // optimistic: code -> mode
  const [busy, setBusy] = useState('');

  useEffect(() => { setPayout(null); loadPayout(mk).then(setPayout); }, [mk]);
  if (payout === null) return <p className="text-gray-500">Loading…</p>;

  const items = Object.entries(payout.items || {}).map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const pending = items.filter((i) => !i.paid && !done[i.code]);

  async function pay(i, mode) {
    setBusy(i.code);
    try { await queueMarkPaid(i.code, mk, mode, user.email); setDone({ ...done, [i.code]: mode }); }
    finally { setBusy(''); }
  }

  return (
    <div className="space-y-3">
      <select className="w-full border rounded-lg px-3 py-2 bg-white font-medium" value={mk} onChange={(e) => setMk(e.target.value)}>
        {monthOptions(3).map((m) => <option key={m.mk} value={m.mk}>{m.label}</option>)}
      </select>
      <p className="text-sm text-gray-600">{pending.length} left to pay · {items.length - pending.length} done</p>
      <div className="bg-white rounded-xl shadow divide-y divide-gray-100">
        {items.length === 0 && <p className="p-4 text-sm text-gray-400">Nothing approved for this month yet.</p>}
        {items.map((i) => {
          const paidMode = i.paid?.mode || done[i.code];
          return (
            <div key={i.code} className="flex items-center p-3 gap-2">
              <div className="flex-1">
                <div className="font-medium text-gray-800">{i.name}</div>
                <div className="text-xs text-gray-500">{i.dept}</div>
              </div>
              <div className="font-bold text-red-700 mr-1">{rupee(i.net)}</div>
              {paidMode ? <span className="text-xs text-green-700 font-medium">✓ {paidMode}</span> : (
                <div className="flex gap-1">
                  <button disabled={busy === i.code} onClick={() => pay(i, 'cash')} className="bg-green-700 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">💵 Cash</button>
                  <button disabled={busy === i.code} onClick={() => pay(i, 'bank')} className="bg-gray-800 text-white text-xs rounded-lg px-2.5 py-2 font-medium disabled:opacity-50">🏦 Bank</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <AdvanceCard user={user} />
    </div>
  );
}

// quick advance entry (both owner-on-Person-page and manager-here can record)
export function AdvanceCard({ user }) {
  const [roster, setRoster] = useState([]);
  const [f, setF] = useState({ code: '', amount: '', mode: 'cash' });
  const [st, setSt] = useState('');
  useEffect(() => { loadRoster().then(setRoster); }, []);
  async function go() {
    if (!f.code || !Number(f.amount)) return;
    setSt('saving');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      await queueAdvance(f.code, { date: today, mode: f.mode, amount: Number(f.amount), paidBy: user.email }, user.email);
      setSt('done'); setF({ code: '', amount: '', mode: 'cash' });
    } catch (e) { setSt('error'); }
  }
  return (
    <div className="bg-white rounded-xl shadow p-3 space-y-2">
      <div className="font-semibold text-gray-800 text-sm">💸 Give advance</div>
      <div className="grid grid-cols-2 gap-2">
        <select className="border rounded px-2 py-2 text-sm col-span-2" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>
          <option value="">Who…</option>
          {roster.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
        <input className="border rounded px-2 py-2 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <select className="border rounded px-2 py-2 text-sm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
          <option value="cash">Cash</option><option value="account">Bank</option>
        </select>
        <button onClick={go} disabled={st === 'saving'} className="col-span-2 bg-red-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">Record advance</button>
      </div>
      {st === 'done' && <p className="text-xs text-green-700">✓ Recorded — owner gets a Telegram alert.</p>}
      {st === 'error' && <p className="text-xs text-red-600">Could not save — try again.</p>}
    </div>
  );
}

/* ---------------- report modal ---------------- */
const REPORTS = [
  { v: 'perfbtn', label: 'Performance Report' },
  { v: 'Button10', label: 'Monthly Summary (Excel)' },
  { v: 'Button15', label: 'Daily In-Out times' },
  { v: 'Button8', label: 'OT Summary' },
  { v: 'Button13', label: 'Late Arrival' },
  { v: 'Button4', label: 'Absent Report' },
];
function ReportModal({ user, onClose }) {
  const [f, setF] = useState({ report: 'perfbtn', month: 0, code: '' });
  const [roster, setRoster] = useState([]);
  const [st, setSt] = useState('');
  useEffect(() => { loadRoster().then(setRoster); }, []);
  async function send() {
    setSt('sending');
    const payload = { month: Number(f.month), report: f.report, scope: f.code ? 'emp' : 'all', value: f.code };
    try { await queueJob('monthly_download', payload, user.email); setSt('sent'); }
    catch { setSt('error'); }
  }
  return (
    <div className="fixed inset-0 bg-black/40 z-20 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-gray-800">📄 Report → Telegram</div>
        <select className="w-full border rounded px-3 py-2" value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })}>
          {REPORTS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <select className="w-full border rounded px-3 py-2" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>
          {monthOptions(3).map((m, i) => <option key={m.mk} value={i}>{m.label}</option>)}
        </select>
        <select className="w-full border rounded px-3 py-2" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>
          <option value="">Everyone</option>
          {roster.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
        {st === 'sent' ? <p className="text-sm text-green-700">✓ On its way to Telegram (1–2 min).</p> : (
          <button onClick={send} disabled={st === 'sending'} className="w-full bg-red-700 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">Send to Telegram</button>
        )}
        {st === 'error' && <p className="text-xs text-red-600">Failed — try again.</p>}
      </div>
    </div>
  );
}

/* ---------------- people without salary ---------------- */
function NoSalaryList({ list, onSaved }) {
  const [show, setShow] = useState(false);
  const [vals, setVals] = useState({});
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-600">
        No salary set ({list.length}) {show ? '▲' : '▼'} <span className="font-normal text-xs text-gray-400">— piece-rate welders can stay empty</span>
      </button>
      {show && (
        <ul className="mt-2 divide-y divide-gray-100">
          {list.map((e) => {
            const v = vals[e.code] || { amount: '', type: 'monthly' };
            return (
              <li key={e.code} className="py-2 flex items-center gap-2 text-sm">
                <span className="flex-1">{e.name || e.code} <span className="text-gray-400 text-xs">{e.dept || ''}</span></span>
                <select className="border rounded px-1 py-1 text-xs" value={v.type} onChange={(ev) => setVals({ ...vals, [e.code]: { ...v, type: ev.target.value } })}>
                  <option value="monthly">₹/mo</option><option value="daily">₹/day</option>
                </select>
                <input className="border rounded px-2 py-1 w-20 text-xs" type="number" placeholder="amount" value={v.amount} onChange={(ev) => setVals({ ...vals, [e.code]: { ...v, amount: ev.target.value } })} />
                <button disabled={!Number(v.amount)} onClick={async () => { await saveEmployee(e.code, v.type === 'daily' ? { type: 'daily', wage: Number(v.amount) } : { type: 'monthly', amount: Number(v.amount) }); onSaved(); }}
                  className="text-xs bg-gray-800 text-white rounded px-2 py-1 disabled:opacity-40">Set</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
