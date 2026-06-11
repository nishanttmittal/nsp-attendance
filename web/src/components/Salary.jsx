import { useEffect, useState } from 'react';
import { loadEmployees, loadEmployee, saveEmployee, addAdvance, addIncrement, monthData, saveMonth, loadAttendance, queueJob } from '../lib/data';
import { computePay } from '../lib/payroll';

const MONTH = '2026-06';                 // current pay month (real app derives from date)
const MONTH_CTX = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: new Date('2026-06-01'), toDate: new Date('2026-06-30') };
const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function Salary({ user }) {
  const [emps, setEmps] = useState(null);
  const [code, setCode] = useState('');
  const [emp, setEmp] = useState(null);
  const [att, setAtt] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadEmployees().then(list => { setEmps(list); if (list[0]) setCode(list[0].code); }); }, []);

  async function reload(c = code) {
    if (!c) return;
    const [e, a] = await Promise.all([loadEmployee(c), loadAttendance(c)]);
    setEmp(e); setAtt(a);
  }
  useEffect(() => { setEmp(null); reload(code); }, [code]);

  const save = async (fn) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };

  if (emps === null) return <p className="text-gray-500">Loading…</p>;
  if (emps.length === 0) return <p className="text-gray-500 text-sm">No employees yet. Add staff in the <b>Staff</b> tab, then set their salary here.</p>;

  return (
    <div className="space-y-4">
      <select className="w-full border rounded-lg px-3 py-2 bg-white" value={code} onChange={e => setCode(e.target.value)}>
        {emps.map(e => <option key={e.code} value={e.code}>{e.name} ({e.code}) · {e.shift}</option>)}
      </select>

      {(!emp || !att) ? <p className="text-gray-500 text-sm">Loading employee…</p> : (() => {
        const md = monthData(emp, MONTH);
        const advancesThisMonth = (emp.advances || []).filter(a => (a.date || '').startsWith(MONTH)).reduce((s, a) => s + Number(a.amount || 0), 0);
        const pay = computePay({ emp, att, ...MONTH_CTX, advancesThisMonth, advanceBalanceIn: Number(md.advanceBalanceIn || 0), advanceRecover: Number(md.advanceRecover || 0), fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0) });
        const locked = md.locked;
        const earnings = pay.base + pay.otPay + pay.perfectBonus;
        // finalize only at month-end, unless the employee has left (resigned)
        const canFinalize = (new Date() >= MONTH_CTX.toDate) || emp.active === false;
        return (
          <>
            <SetupCard key={'s' + code} emp={emp} disabled={locked || busy} onSave={(patch) => save(() => saveEmployee(code, patch))} />

            <div className="bg-white rounded-xl shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-gray-800">Payslip · {MONTH}</div>
                {locked && <span className="text-xs bg-gray-800 text-white px-2 py-0.5 rounded">🔒 Locked</span>}
              </div>
              <Row k="Rate" v={`${rupee(pay.effectiveRate)} ${emp.type === 'daily' ? '/day' : '/month'}${pay.effectiveRemark ? ' (' + pay.effectiveRemark + ')' : ''}`} />
              <Row k="Present / Absent" v={`${pay.presentDays} / ${pay.absentDays} (payable ${pay.payableDays}d)`} />
              <Row k="OT" v={`${pay.otHrs}h → ${pay.otHrsNet}h net`} />
              <hr className="my-2" />
              <Row k="Base" v={rupee(pay.base)} />
              <Row k="+ Overtime" v={rupee(pay.otPay)} />
              {pay.perfectBonus > 0 && <Row k="+ Attendance bonus" v={rupee(pay.perfectBonus)} />}
              {pay.fines > 0 && <Row k="− Fine" v={rupee(pay.fines)} />}
              {pay.loanInstallment > 0 && <Row k="− Loan installment" v={rupee(pay.loanInstallment)} />}
              {pay.advanceRecovered > 0 && <Row k="− Advance recovered" v={rupee(pay.advanceRecovered)} />}
              <div className="flex justify-between mt-2 pt-2 border-t font-bold text-lg"><span>Net pay</span><span className="text-red-700">{rupee(pay.net)}</span></div>
              {pay.advanceDue > 0 && <p className="text-xs text-amber-700 mt-1">Advance owed {rupee(pay.advanceDue)} · carrying {rupee(pay.advanceBalanceCarried)} forward.</p>}
              {pay.suggestedWeeklyOffDock.days > 0 && <p className="text-xs text-amber-700 mt-1">⚠ {pay.absentDays} absences → suggest docking {pay.suggestedWeeklyOffDock.days} weekly-off ({rupee(pay.suggestedWeeklyOffDock.amount)}) — confirm to apply.</p>}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={async () => { await queueJob('payslip', { code, month: MONTH }, user.email); alert('Payslip will be sent to Telegram.'); }} className="bg-red-700 text-white rounded-lg py-2 text-sm font-medium">Send to Telegram</button>
                <LockButton locked={locked} canFinalize={canFinalize} onToggle={(next) => save(() => saveMonth(code, MONTH, { locked: next }))} />
              </div>
              {!canFinalize && !locked && <p className="text-xs text-gray-400 mt-1">Finalize unlocks at month-end (or now if the employee has left).</p>}
            </div>

            <div className="bg-white rounded-xl shadow p-4">
              <div className="font-semibold text-gray-800 mb-2">This month — deductions</div>
              <NumRow key={'r' + code} label={`Recover advance (owed ${rupee(pay.advanceDue)})`} val={md.advanceRecover} disabled={locked || busy} onSave={(v) => save(() => saveMonth(code, MONTH, { advanceRecover: v }))} />
              <NumRow key={'f' + code} label="Fine" val={md.fine} disabled={locked || busy} onSave={(v) => save(() => saveMonth(code, MONTH, { fine: v }))} />
              <NumRow key={'l' + code} label="Loan installment" val={md.loanInstallment} disabled={locked || busy} onSave={(v) => save(() => saveMonth(code, MONTH, { loanInstallment: v }))} />
            </div>

            <AdvancesCard key={'a' + code} emp={emp} earnings={earnings} thisMonth={advancesThisMonth} disabled={locked || busy} onAdd={(a) => save(() => addAdvance(code, a))} />
            <IncrementsCard key={'i' + code} emp={emp} disabled={locked || busy} onAdd={(i) => save(() => addIncrement(code, i))} />
          </>
        );
      })()}
    </div>
  );
}

function SetupCard({ emp, onSave, disabled }) {
  const [type, setType] = useState(emp.type || 'monthly');
  const [amount, setAmount] = useState(emp.type === 'daily' ? (emp.wage || '') : (emp.amount || ''));
  const [shift, setShift] = useState(emp.shift || 'GEN');
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2">Salary setup</div>
      <div className="grid grid-cols-2 gap-2">
        <select className="border rounded px-2 py-2" value={type} onChange={e => setType(e.target.value)} disabled={disabled}>
          <option value="monthly">Monthly</option><option value="daily">Daily wage</option>
        </select>
        <select className="border rounded px-2 py-2" value={shift} onChange={e => setShift(e.target.value)} disabled={disabled}>
          {['GEN', '10H', '12H', 'wir'].map(s => <option key={s}>{s}</option>)}
        </select>
        <input className="border rounded px-2 py-2 col-span-2" type="number" placeholder={type === 'daily' ? 'Wage / day' : 'Salary / month'} value={amount} onChange={e => setAmount(e.target.value)} disabled={disabled} />
      </div>
      <button disabled={disabled} onClick={() => onSave(type === 'daily' ? { type, wage: Number(amount), shift } : { type, amount: Number(amount), shift })}
        className="mt-2 w-full bg-gray-800 disabled:opacity-40 text-white rounded py-2 text-sm font-medium">Save salary</button>
    </div>
  );
}

function AdvancesCard({ emp, earnings = 0, thisMonth = 0, onAdd, disabled }) {
  const [f, setF] = useState({ amount: '', date: MONTH + '-01', mode: 'cash', remark: '' });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const projected = Number(thisMonth || 0) + Number(f.amount || 0);
  const over = f.amount && projected > earnings;
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2">Advances</div>
      <ul className="text-sm divide-y divide-gray-100 mb-2">
        {(emp.advances || []).length === 0 && <li className="text-gray-400 py-1">None</li>}
        {(emp.advances || []).map((a, i) => <li key={i} className="py-1 flex justify-between"><span>{a.date} · {a.mode}{a.paidBy ? ' · by ' + a.paidBy : ''}{a.remark ? ' · ' + a.remark : ''}</span><span className="font-semibold">{rupee(a.amount)}</span></li>)}
      </ul>
      {!disabled && <div className="grid grid-cols-2 gap-2">
        <input className="border rounded px-2 py-1.5" type="number" placeholder="Amount" value={f.amount} onChange={set('amount')} />
        <input className="border rounded px-2 py-1.5" type="date" value={f.date} onChange={set('date')} />
        <select className="border rounded px-2 py-1.5" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="account">Account</option><option value="both">Both</option></select>
        <input className="border rounded px-2 py-1.5" placeholder="Remark" value={f.remark} onChange={set('remark')} />
        {over ? <p className="col-span-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-1.5">⚠ Advance total {rupee(projected)} exceeds this month's earning {rupee(earnings)} — the extra will carry forward.</p> : null}
        <button onClick={() => { if (f.amount) onAdd({ ...f, amount: Number(f.amount) }); }} className="col-span-2 bg-red-700 text-white rounded py-1.5 text-sm font-medium">Add advance</button>
      </div>}
    </div>
  );
}

function IncrementsCard({ emp, onAdd, disabled }) {
  const [f, setF] = useState({ amount: '', effective: MONTH + '-01', remark: '' });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2">Increments (added to salary)</div>
      <ul className="text-sm divide-y divide-gray-100 mb-2">
        {(emp.increments || []).length === 0 && <li className="text-gray-400 py-1">None</li>}
        {(emp.increments || []).map((i, n) => <li key={n} className="py-1 flex justify-between"><span>{i.effective}{i.remark ? ' · ' + i.remark : ''}</span><span className="font-semibold text-green-700">+{rupee(i.amount)}</span></li>)}
      </ul>
      {!disabled && <div className="grid grid-cols-2 gap-2">
        <input className="border rounded px-2 py-1.5" type="number" placeholder="+ Amount" value={f.amount} onChange={set('amount')} />
        <input className="border rounded px-2 py-1.5" type="date" value={f.effective} onChange={set('effective')} />
        <input className="border rounded px-2 py-1.5 col-span-2" placeholder="Remark (e.g. annual hike)" value={f.remark} onChange={set('remark')} />
        <button onClick={() => { if (f.amount) onAdd({ ...f, amount: Number(f.amount) }); }} className="col-span-2 bg-green-700 text-white rounded py-1.5 text-sm font-medium">Add increment</button>
      </div>}
    </div>
  );
}

function LockButton({ locked, canFinalize, onToggle }) {
  if (locked) return <button onClick={() => { const p = prompt('Admin password to unlock:'); if (p) onToggle(false); }} className="border border-amber-400 text-amber-700 rounded-lg py-2 text-sm font-medium">🔓 Unlock</button>;
  return <button disabled={!canFinalize} onClick={() => onToggle(true)} className={`border rounded-lg py-2 text-sm font-medium ${canFinalize ? 'border-gray-300' : 'border-gray-200 text-gray-300'}`}>Finalize &amp; lock</button>;
}

function Row({ k, v }) { return <div className="flex justify-between text-sm py-0.5"><span className="text-gray-500">{k}</span><span className="text-gray-800">{v}</span></div>; }
function NumRow({ label, val, onSave, disabled }) {
  const [v, setV] = useState(val ?? 0);
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-sm text-gray-600 flex-1">{label}</span>
      <input className="border rounded px-2 py-1 w-24 text-right" type="number" value={v} onChange={e => setV(e.target.value)} disabled={disabled} />
      <button disabled={disabled} onClick={() => onSave(Number(v))} className="text-xs bg-gray-800 disabled:opacity-40 text-white rounded px-2 py-1">Set</button>
    </div>
  );
}
