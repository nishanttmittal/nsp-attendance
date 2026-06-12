import { useEffect, useMemo, useState } from 'react';
import { loadEmployee, loadAllAttendance, saveEmployee, saveMonth, addAdvance, addIncrement, resignEmployee, queueJob } from '../lib/data';
import { monthCtx, payFor, rupee } from '../lib/paycalc';
import { payslipOnePdf, sharePdf } from '../lib/salaryPdf';

// One person, one page: this month's money, their ledger, their settings.
export default function Person({ code, mk, user, onBack }) {
  const [emp, setEmp] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [busy, setBusy] = useState(false);
  const ctx = useMemo(() => monthCtx(mk), [mk]);

  async function reload() {
    const [e, am] = await Promise.all([loadEmployee(code), loadAllAttendance()]);
    setEmp(e); setAttMap(am);
  }
  useEffect(() => { reload(); }, [code]);
  const act = async (fn) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };

  if (!emp) return <p className="text-gray-500">Loading…</p>;
  const { md, pay } = payFor(emp, attMap, mk, ctx);
  const locked = !!md.payment;
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-sm text-gray-600">← Back to list</button>

      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-bold text-lg text-gray-800">{emp.name || code}</div>
        <div className="text-xs text-gray-500 mb-2">{emp.dept || ''} · {emp.shift || ''} · {emp.type === 'daily' ? rupee(emp.wage) + '/day' : rupee(emp.amount) + '/month'}</div>
        <Row k="Days" v={`present ${pay.presentDays} · absent ${pay.absentDays}`} />
        <Row k="Overtime" v={`${pay.otHrs}h → pays ${pay.otHrsNet}h`} />
        <hr className="my-1.5" />
        <Row k="Base pay" v={rupee(pay.base)} />
        <Row k="+ Overtime" v={rupee(pay.otPay)} />
        {pay.perfectBonus > 0 && <Row k="+ Full-attendance bonus" v={rupee(pay.perfectBonus)} />}
        {pay.fines > 0 && <Row k="− Fine" v={rupee(pay.fines)} />}
        {pay.loanInstallment > 0 && <Row k="− Loan" v={rupee(pay.loanInstallment)} />}
        {pay.advanceRecovered > 0 && <Row k="− Advance" v={rupee(pay.advanceRecovered)} />}
        <div className="flex justify-between mt-1 pt-1.5 border-t font-bold"><span>This month ({mk})</span><span className="text-red-700">{rupee(locked ? md.payment.net : pay.net)}</span></div>
        {locked && <p className="text-xs text-green-700 mt-1">✓ Paid {md.payment.date} ({md.payment.mode})</p>}
        {pay.advanceBalanceCarried > 0 && <p className="text-xs text-amber-700 mt-1">Still owes {rupee(pay.advanceBalanceCarried)} advance — carries forward.</p>}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button onClick={() => sharePdf(payslipOnePdf(emp, pay, mk), `payslip-${code}-${mk}.pdf`)} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">📄 Payslip</button>
          <button onClick={async () => { await queueJob('payslip', { code, month: mk }, user.email); alert('Sent to Telegram.'); }} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">✈️ Telegram</button>
        </div>
      </div>

      {!locked && (
        <div className="bg-white rounded-xl shadow p-3 space-y-1">
          <div className="text-sm font-semibold text-gray-700">Adjust this month</div>
          <NumRow label="Fine ₹" val={md.fine} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { fine: v }))} />
          <NumRow label="Loan cut ₹" val={md.loanInstallment} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { loanInstallment: v }))} />
          <NumRow label={`Advance cut ₹ (owes ${rupee(pay.advanceDue)})`} val={md.advanceRecover ?? pay.advanceDue} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { advanceRecover: v }))} />
        </div>
      )}

      <Ledger title="💸 Advances" items={(emp.advances || []).map((a) => ({ d: a.date, t: `${a.mode}${a.remark ? ' · ' + a.remark : ''}`, v: rupee(a.amount) }))}
        form={{ fields: ['amount', 'mode'], submit: 'Add advance' }} busy={busy}
        onAdd={(f) => act(() => addAdvance(code, { date: today, mode: f.mode, amount: Number(f.amount), paidBy: user.email }))} />

      <Ledger title="📈 Increments" items={(emp.increments || []).map((i) => ({ d: i.effective, t: i.remark || '', v: '+' + rupee(i.amount), green: true }))}
        form={{ fields: ['amount', 'remark'], submit: 'Add increment (this month onward)' }} busy={busy}
        onAdd={(f) => act(() => addIncrement(code, { amount: Number(f.amount), effective: mk + '-01', remark: f.remark || '' }))} />

      <SalaryEdit emp={emp} busy={busy} onSave={(patch) => act(() => saveEmployee(code, patch))} />

      {emp.active !== false ? (
        <button disabled={busy} onClick={() => { if (confirm(`Resign ${emp.name}? (also remove on the machine)`)) act(() => resignEmployee(code, user.email)); }}
          className="w-full border border-red-200 text-red-700 rounded-lg py-2 text-sm">Resign / remove {emp.name}</button>
      ) : <p className="text-center text-xs text-gray-400">Resigned {emp.resignedAt || ''}</p>}
    </div>
  );
}

function Ledger({ title, items, form, onAdd, busy }) {
  const [f, setF] = useState({ amount: '', mode: 'cash', remark: '' });
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">{title} ({items.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
        {items.length === 0 && <li className="text-gray-400 py-1">None yet</li>}
        {[...items].reverse().map((x, i) => <li key={i} className="py-1 flex justify-between"><span>{x.d}{x.t ? ' · ' + x.t : ''}</span><b className={x.green ? 'text-green-700' : ''}>{x.v}</b></li>)}
      </ul>
      <div className="grid grid-cols-2 gap-1.5 mt-2">
        <input className="border rounded px-2 py-1.5 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        {form.fields.includes('mode')
          ? <select className="border rounded px-2 py-1.5 text-sm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="cash">Cash</option><option value="account">Bank</option></select>
          : <input className="border rounded px-2 py-1.5 text-sm" placeholder="Remark" value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />}
        <button disabled={busy || !Number(f.amount)} onClick={() => { onAdd(f); setF({ amount: '', mode: 'cash', remark: '' }); }}
          className="col-span-2 bg-gray-800 text-white rounded py-1.5 text-xs font-medium disabled:opacity-40">{form.submit}</button>
      </div>
    </div>
  );
}

function SalaryEdit({ emp, onSave, busy }) {
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ type: emp.type || 'monthly', amount: emp.type === 'daily' ? emp.wage : emp.amount, shift: emp.shift || 'GEN' });
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-700">⚙ Salary setting {show ? '▲' : '▼'}</button>
      {show && (
        <div className="grid grid-cols-3 gap-2 mt-2">
          <select className="border rounded px-2 py-2 text-sm" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="monthly">Monthly</option><option value="daily">Daily</option>
          </select>
          <input className="border rounded px-2 py-2 text-sm" type="number" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <select className="border rounded px-2 py-2 text-sm" value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>
            {['GEN', '10H', '12H', 'wir'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button disabled={busy} onClick={() => onSave(f.type === 'daily' ? { type: 'daily', wage: Number(f.amount), shift: f.shift } : { type: 'monthly', amount: Number(f.amount), shift: f.shift })}
            className="col-span-3 bg-gray-800 text-white rounded py-1.5 text-xs font-medium">Save</button>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) { return <div className="flex justify-between text-sm py-0.5"><span className="text-gray-500">{k}</span><span className="text-gray-800">{v}</span></div>; }
function NumRow({ label, val, onSave, disabled }) {
  const [v, setV] = useState(val ?? 0);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 flex-1">{label}</span>
      <input className="border rounded px-2 py-1 w-24 text-right text-sm" type="number" value={v} onChange={(e) => setV(e.target.value)} disabled={disabled} />
      <button disabled={disabled} onClick={() => onSave(Number(v))} className="text-xs bg-gray-800 disabled:opacity-40 text-white rounded px-2 py-1">Set</button>
    </div>
  );
}
