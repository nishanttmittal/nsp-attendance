import { useMemo, useState } from 'react';
import { listEmployees, getEmployee, saveEmployee, addAdvance, addIncrement, getMonth, saveMonth, getAttendance, queueJob } from '../lib/data';
import { computePay } from '../lib/payroll';

const MONTH = '2026-06';                 // current pay month (real app derives from date)
const MONTH_CTX = { daysInMonth: 30, elapsedDays: 30, fullMonth: true, monthStart: new Date('2026-06-01'), toDate: new Date('2026-06-30') };
const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function Salary({ user }) {
  const emps = listEmployees();
  const [code, setCode] = useState(emps[0]?.code || '');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(t => t + 1);

  const emp = useMemo(() => getEmployee(code), [code, tick]);
  const md = useMemo(() => getMonth(code, MONTH), [code, tick]);
  const att = getAttendance(code, MONTH);
  const advancesThisMonth = (emp.advances || []).filter(a => (a.date || '').startsWith(MONTH)).reduce((s, a) => s + Number(a.amount || 0), 0);

  const pay = useMemo(() => computePay({
    emp, att, ...MONTH_CTX,
    advancesThisMonth, advanceBalanceIn: Number(md.advanceBalanceIn || 0),
    advanceRecover: Number(md.advanceRecover || 0), fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0),
  }), [emp, att, md, advancesThisMonth]);

  const locked = md.locked;

  return (
    <div className="space-y-4">
      <select className="w-full border rounded-lg px-3 py-2 bg-white" value={code} onChange={e => setCode(e.target.value)}>
        {emps.map(e => <option key={e.code} value={e.code}>{e.name} ({e.code}) · {e.shift}</option>)}
      </select>

      {/* Salary setup */}
      <SetupCard emp={emp} onSave={(patch) => { saveEmployee(code, patch); refresh(); }} disabled={locked} />

      {/* Payslip */}
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
        <div className="flex justify-between mt-2 pt-2 border-t font-bold text-lg">
          <span>Net pay</span><span className="text-red-700">{rupee(pay.net)}</span>
        </div>
        {pay.advanceDue > 0 && <p className="text-xs text-amber-700 mt-1">Advance owed {rupee(pay.advanceDue)} · carrying {rupee(pay.advanceBalanceCarried)} forward.</p>}
        {pay.suggestedWeeklyOffDock.days > 0 && <p className="text-xs text-amber-700 mt-1">⚠ {pay.absentDays} absences → suggest docking {pay.suggestedWeeklyOffDock.days} weekly-off ({rupee(pay.suggestedWeeklyOffDock.amount)}) — confirm to apply.</p>}

        <div className="grid grid-cols-2 gap-2 mt-3">
          <button onClick={async () => { await queueJob('payslip', { code, month: MONTH }, user.email); alert('Payslip will be sent to Telegram.'); }}
            className="bg-red-700 text-white rounded-lg py-2 text-sm font-medium">Send to Telegram</button>
          <LockButton locked={locked} onToggle={(next) => { saveMonth(code, MONTH, { locked: next }); refresh(); }} />
        </div>
      </div>

      {/* This-month deductions */}
      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-semibold text-gray-800 mb-2">This month — deductions</div>
        <NumRow label={`Recover advance (owed ${rupee(pay.advanceDue)})`} val={md.advanceRecover} onSave={(v) => { saveMonth(code, MONTH, { advanceRecover: v }); refresh(); }} disabled={locked} />
        <NumRow label="Fine" val={md.fine} onSave={(v) => { saveMonth(code, MONTH, { fine: v }); refresh(); }} disabled={locked} />
        <NumRow label="Loan installment" val={md.loanInstallment} onSave={(v) => { saveMonth(code, MONTH, { loanInstallment: v }); refresh(); }} disabled={locked} />
      </div>

      {/* Advances */}
      <AdvancesCard emp={emp} disabled={locked} onAdd={(a) => { addAdvance(code, a); refresh(); }} />

      {/* Increments */}
      <IncrementsCard emp={emp} disabled={locked} onAdd={(i) => { addIncrement(code, i); refresh(); }} />
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

function AdvancesCard({ emp, onAdd, disabled }) {
  const [f, setF] = useState({ amount: '', date: MONTH + '-01', mode: 'cash', remark: '' });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2">Advances</div>
      <ul className="text-sm divide-y divide-gray-100 mb-2">
        {(emp.advances || []).length === 0 && <li className="text-gray-400 py-1">None</li>}
        {(emp.advances || []).map((a, i) => <li key={i} className="py-1 flex justify-between"><span>{a.date} · {a.mode}{a.remark ? ' · ' + a.remark : ''}</span><span className="font-semibold">{rupee(a.amount)}</span></li>)}
      </ul>
      {!disabled && <div className="grid grid-cols-2 gap-2">
        <input className="border rounded px-2 py-1.5" type="number" placeholder="Amount" value={f.amount} onChange={set('amount')} />
        <input className="border rounded px-2 py-1.5" type="date" value={f.date} onChange={set('date')} />
        <select className="border rounded px-2 py-1.5" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="account">Account</option><option value="both">Both</option></select>
        <input className="border rounded px-2 py-1.5" placeholder="Remark" value={f.remark} onChange={set('remark')} />
        <button onClick={() => { if (f.amount) { onAdd({ ...f, amount: Number(f.amount) }); setF({ ...f, amount: '', remark: '' }); } }}
          className="col-span-2 bg-red-700 text-white rounded py-1.5 text-sm font-medium">Add advance</button>
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
        <button onClick={() => { if (f.amount) { onAdd({ ...f, amount: Number(f.amount) }); setF({ ...f, amount: '', remark: '' }); } }}
          className="col-span-2 bg-green-700 text-white rounded py-1.5 text-sm font-medium">Add increment</button>
      </div>}
    </div>
  );
}

function LockButton({ locked, onToggle }) {
  if (!locked) return <button onClick={() => onToggle(true)} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">Finalize & lock</button>;
  return <button onClick={() => { const p = prompt('Admin password to unlock:'); if (p) onToggle(false); }} className="border border-amber-400 text-amber-700 rounded-lg py-2 text-sm font-medium">🔓 Unlock</button>;
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
