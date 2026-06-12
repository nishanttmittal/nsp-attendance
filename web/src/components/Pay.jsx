import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, saveEmployee, addAdvance, addIncrement, monthData, saveMonth, dailyAtt, queueJob, istMonth } from '../lib/data';
import { computePay } from '../lib/payroll';
import { payslipOnePdf, payslipAllPdf, sharePdf, advanceSplit } from '../lib/salaryPdf';
import SelfPunchCard from './SelfPunchCard.jsx';

const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const pad = (n) => String(n).padStart(2, '0');

// last 6 months, newest first
function monthOptions() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const mk = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    return { mk, label: d.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
}
function monthCtx(mk) {
  const [y, m] = mk.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const fullMonth = mk !== istMonth();
  const elapsedDays = fullMonth ? daysInMonth : Math.max(1, nowIst.getUTCDate() - 1); // till previous day
  return {
    daysInMonth, fullMonth, elapsedDays,
    monthStart: new Date(Date.UTC(y, m - 1, 1)),
    toDate: fullMonth ? new Date(Date.UTC(y, m - 1, daysInMonth)) : new Date(Date.UTC(y, m - 1, elapsedDays)),
  };
}
const nextMonthKey = (mk) => { const [y, m] = mk.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };
const ZERO_ATT = { presentDays: 0, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 };

// attendance record for one employee in one month (months map → current top-level → zeros)
function attFor(emp, attMap, mk) {
  if (emp.appOnly) return dailyAtt(emp, mk);
  const a = attMap[emp.code];
  if (!a) return ZERO_ATT;
  if (a.months && a.months[mk]) return a.months[mk];
  if (a.month === mk) return a;
  return ZERO_ATT;
}

// full pay computation for one employee in one month — single source for list + detail
function payFor(emp, attMap, mk, ctx) {
  const att = attFor(emp, attMap, mk);
  const md = monthData(emp, mk);
  const advs = (emp.advances || []).filter((a) => (a.date || '').startsWith(mk));
  const advancesThisMonth = advs.reduce((s, a) => s + Number(a.amount || 0), 0);
  const advanceBalanceIn = Number(md.advanceBalanceIn || 0);
  // owner rule: recover the FULL outstanding advance by default (editable per month)
  const advanceRecover = md.advanceRecover != null ? Number(md.advanceRecover) : advancesThisMonth + advanceBalanceIn;
  const pay = computePay({
    emp, att, ...ctx,
    advancesThisMonth, advanceBalanceIn, advanceRecover,
    fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0),
    latePenaltyDays: 0, weeklyOffDockDays: 0, // machine applies late/weekly-off rules now
  });
  return { att, md, advs, advancesThisMonth, pay };
}

export default function Pay({ user }) {
  const [mk, setMk] = useState(istMonth());
  const [emps, setEmps] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [open, setOpen] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const ctx = useMemo(() => monthCtx(mk), [mk]);

  async function reload() {
    const [list, am] = await Promise.all([loadEmployees(), loadAllAttendance()]);
    setEmps(list); setAttMap(am);
  }
  useEffect(() => { reload(); }, []);
  const act = async (fn) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };

  if (emps === null) return <p className="text-gray-500">Loading…</p>;

  const withSalary = emps.filter((e) => e.amount || e.wage);
  const noSalary = emps.filter((e) => !(e.amount || e.wage));
  const rows = withSalary.map((e) => ({ emp: e, ...payFor(e, attMap, mk, ctx) }));
  const visible = rows.filter((r) => !q || (r.emp.name || '').toLowerCase().includes(q.toLowerCase()));
  const paid = rows.filter((r) => r.md.locked);
  const due = rows.filter((r) => !r.md.locked && r.pay.net > 0);

  async function registerPdf() {
    setBusy(true);
    try {
      const list = rows.map((r) => ({
        name: r.emp.name || r.emp.code, days: r.emp.appOnly ? r.att.equivalentDays : r.pay.presentDays,
        ot: r.pay.otHrsNet, advBank: advanceSplit(r.advs).bank, advCash: advanceSplit(r.advs).cash,
        net: r.pay.net, carried: r.pay.advanceBalanceCarried,
      }));
      await sharePdf(payslipAllPdf(list, mk), `salary-register-${mk}.pdf`);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex gap-2">
          <select className="flex-1 border rounded-lg px-3 py-2 bg-white font-medium" value={mk} onChange={(e) => { setMk(e.target.value); setOpen(''); }}>
            {monthOptions().map((m) => <option key={m.mk} value={m.mk}>{m.label}{m.mk === istMonth() ? ' (running)' : ''}</option>)}
          </select>
          <button onClick={registerPdf} disabled={busy} className="border border-gray-300 rounded-lg px-3 text-sm font-medium disabled:opacity-50">📄 Register</button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="To pay" value={rupee(due.reduce((s, r) => s + r.pay.net, 0))} sub={`${due.length} people`} color="text-red-700" />
          <Stat label="Paid" value={rupee(paid.reduce((s, r) => s + Number(r.md.payment?.net ?? r.pay.net), 0))} sub={`${paid.length} people`} color="text-green-700" />
          <Stat label="Advance owed" value={rupee(rows.reduce((s, r) => s + r.pay.advanceBalanceCarried, 0))} sub="carrying fwd" color="text-amber-700" />
        </div>
        {!ctx.fullMonth && <p className="text-xs text-gray-500">Running month — figures are till <b>yesterday</b>. Full-month extras (attendance bonus) apply after month-end.</p>}
      </div>

      {mk === istMonth() && <SelfPunchCard />}

      <input className="w-full border rounded-lg px-3 py-2" placeholder="🔍 Search name…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="space-y-2">
        {visible.length === 0 && <p className="text-gray-500 text-sm">No one matches.</p>}
        {visible.map((r) => (
          <PayCard key={r.emp.code} r={r} mk={mk} open={open === r.emp.code} onToggle={() => setOpen(open === r.emp.code ? '' : r.emp.code)}
            busy={busy} act={act} user={user} canFinalize={ctx.fullMonth || r.emp.active === false} />
        ))}
      </div>

      {noSalary.length > 0 && <NoSalaryList list={noSalary} busy={busy} act={act} />}
    </div>
  );
}

function Stat({ label, value, sub, color }) {
  return <div className="bg-gray-50 rounded-lg py-2">
    <div className={`font-bold ${color}`}>{value}</div>
    <div className="text-[11px] text-gray-500">{label} · {sub}</div>
  </div>;
}

function PayCard({ r, mk, open, onToggle, busy, act, user, canFinalize }) {
  const { emp, att, md, advs, advancesThisMonth, pay } = r;
  const locked = !!md.locked;
  return (
    <div className="bg-white rounded-xl shadow">
      <button onClick={onToggle} className="w-full flex items-center justify-between p-3 text-left">
        <div>
          <div className="font-medium text-gray-800">{emp.name || emp.code} {locked && <span className="text-[10px] bg-green-100 text-green-800 px-1.5 py-0.5 rounded ml-1">PAID</span>}</div>
          <div className="text-xs text-gray-500">
            {emp.dept || ''} · {emp.appOnly ? `${att.presentDays}d logged` : `${pay.presentDays}P/${pay.absentDays}A`} · OT {pay.otHrsNet}h
            {pay.advanceDue > 0 && <span className="text-amber-700"> · adv {rupee(pay.advanceDue)}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-lg text-red-700">{rupee(locked ? (md.payment?.net ?? pay.net) : pay.net)}</div>
          <div className="text-[10px] text-gray-400">{open ? '▲ close' : '▼ details'}</div>
        </div>
      </button>

      {open && (
        <div className="border-t p-3 space-y-3">
          <div>
            <Row k="Rate" v={`${rupee(pay.effectiveRate)} ${emp.type === 'daily' ? '/day' : '/month'}${pay.effectiveRemark ? ' (' + pay.effectiveRemark + ')' : ''}`} />
            <Row k="Days" v={`present ${pay.presentDays} · absent ${pay.absentDays} · payable ${pay.payableDays}`} />
            <Row k="Overtime" v={`${pay.otHrs}h raw → ${pay.otHrsNet}h net`} />
            <hr className="my-1.5" />
            <Row k="Base pay" v={rupee(pay.base)} />
            <Row k="+ Overtime" v={rupee(pay.otPay)} />
            {pay.perfectBonus > 0 && <Row k="+ Full-attendance bonus" v={rupee(pay.perfectBonus)} />}
            {pay.fines > 0 && <Row k="− Fine" v={rupee(pay.fines)} />}
            {pay.loanInstallment > 0 && <Row k="− Loan installment" v={rupee(pay.loanInstallment)} />}
            {pay.advanceRecovered > 0 && <Row k="− Advance recovered" v={rupee(pay.advanceRecovered)} />}
            <div className="flex justify-between mt-1 pt-1.5 border-t font-bold"><span>Net pay</span><span className="text-red-700">{rupee(pay.net)}</span></div>
            {pay.advanceBalanceCarried > 0 && <p className="text-xs text-amber-700 mt-1">Advance {rupee(pay.advanceBalanceCarried)} still owed — carries to next month.</p>}
          </div>

          {!locked && (
            <div className="bg-gray-50 rounded-lg p-2 space-y-1">
              <div className="text-xs font-semibold text-gray-600">Adjustments (this month)</div>
              <NumRow label="Fine ₹" val={md.fine} disabled={busy} onSave={(v) => act(() => saveMonth(emp.code, mk, { fine: v }))} />
              <NumRow label="Loan installment ₹" val={md.loanInstallment} disabled={busy} onSave={(v) => act(() => saveMonth(emp.code, mk, { loanInstallment: v }))} />
              <NumRow label={`Recover advance ₹ (owed ${rupee(pay.advanceDue)})`} val={md.advanceRecover ?? pay.advanceDue} disabled={busy} onSave={(v) => act(() => saveMonth(emp.code, mk, { advanceRecover: v }))} />
            </div>
          )}

          <Ledger emp={emp} mk={mk} advs={advs} busy={busy} act={act} user={user} locked={locked} />

          <PaymentBox emp={emp} mk={mk} md={md} pay={pay} locked={locked} canFinalize={canFinalize} busy={busy} act={act} user={user} />

          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => sharePdf(payslipOnePdf(emp, pay, mk), `payslip-${emp.code}-${mk}.pdf`)} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">📄 Payslip PDF</button>
            <button onClick={async () => { await queueJob('payslip', { code: emp.code, month: mk }, user.email); alert('Payslip will arrive on Telegram.'); }} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">✈️ Telegram</button>
          </div>
        </div>
      )}
    </div>
  );
}

// advances (bank/cash/both) + increments for one person — their money ledger
function Ledger({ emp, mk, advs, busy, act, user, locked }) {
  const [show, setShow] = useState(false);
  const [a, setA] = useState({ amount: '', mode: 'cash', bank: '', cash: '', remark: '' });
  const [inc, setInc] = useState({ amount: '', remark: '' });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const allAdv = emp.advances || [], allInc = emp.increments || [];
  return (
    <div className="bg-gray-50 rounded-lg p-2">
      <button onClick={() => setShow(!show)} className="w-full text-left text-xs font-semibold text-gray-600">
        Ledger — advances ({allAdv.length}) · increments ({allInc.length}) {show ? '▲' : '▼'}
      </button>
      {show && (
        <div className="mt-2 space-y-2">
          <ul className="text-xs divide-y divide-gray-200 max-h-36 overflow-auto bg-white rounded p-1.5">
            {allAdv.length === 0 && <li className="text-gray-400 py-0.5">No advances yet</li>}
            {allAdv.map((x, i) => <li key={'a' + i} className="py-0.5 flex justify-between"><span>💸 {x.date} · {x.mode}{x.remark ? ' · ' + x.remark : ''}</span><b>{rupee(x.amount)}</b></li>)}
            {allInc.map((x, i) => <li key={'i' + i} className="py-0.5 flex justify-between"><span>📈 {x.effective}{x.remark ? ' · ' + x.remark : ''}</span><b className="text-green-700">+{rupee(x.amount)}</b></li>)}
          </ul>
          {!locked && <>
            <div className="grid grid-cols-2 gap-1.5">
              <select className="border rounded px-2 py-1 text-sm" value={a.mode} onChange={(e) => setA({ ...a, mode: e.target.value })}>
                <option value="cash">Advance · Cash</option><option value="account">Advance · Bank</option><option value="both">Advance · Both</option>
              </select>
              {a.mode === 'both'
                ? <div className="grid grid-cols-2 gap-1"><input className="border rounded px-2 py-1 text-sm" type="number" placeholder="Bank" value={a.bank} onChange={(e) => setA({ ...a, bank: e.target.value })} /><input className="border rounded px-2 py-1 text-sm" type="number" placeholder="Cash" value={a.cash} onChange={(e) => setA({ ...a, cash: e.target.value })} /></div>
                : <input className="border rounded px-2 py-1 text-sm" type="number" placeholder="Amount ₹" value={a.amount} onChange={(e) => setA({ ...a, amount: e.target.value })} />}
              <input className="border rounded px-2 py-1 text-sm col-span-2" placeholder="Remark" value={a.remark} onChange={(e) => setA({ ...a, remark: e.target.value })} />
              <button disabled={busy} onClick={() => {
                const amt = a.mode === 'both' ? Number(a.bank || 0) + Number(a.cash || 0) : Number(a.amount || 0);
                if (!amt) return;
                const adv = { date: today, mode: a.mode, amount: amt, remark: a.remark, paidBy: user.email };
                if (a.mode === 'both') { adv.bank = Number(a.bank || 0); adv.cash = Number(a.cash || 0); }
                act(() => addAdvance(emp.code, adv)); setA({ amount: '', mode: 'cash', bank: '', cash: '', remark: '' });
              }} className="col-span-2 bg-red-700 text-white rounded py-1.5 text-xs font-medium disabled:opacity-50">+ Add advance</button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <input className="border rounded px-2 py-1 text-sm" type="number" placeholder="Increment +₹/mo" value={inc.amount} onChange={(e) => setInc({ ...inc, amount: e.target.value })} />
              <input className="border rounded px-2 py-1 text-sm" placeholder="Remark" value={inc.remark} onChange={(e) => setInc({ ...inc, remark: e.target.value })} />
              <button disabled={busy} onClick={() => { if (!Number(inc.amount)) return; act(() => addIncrement(emp.code, { amount: Number(inc.amount), effective: mk + '-01', remark: inc.remark })); setInc({ amount: '', remark: '' }); }}
                className="col-span-2 bg-green-700 text-white rounded py-1.5 text-xs font-medium disabled:opacity-50">+ Add increment (from this month onward)</button>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}

function PaymentBox({ emp, mk, md, pay, locked, canFinalize, busy, act, user }) {
  const [bank, setBank] = useState('');
  const [cash, setCash] = useState('');
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (locked) {
    const p = md.payment || {};
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-2 text-sm">
        <div className="text-green-800">✓ Paid {rupee(p.net)} on {p.date}{p.bank != null ? ` — bank ${rupee(p.bank)} + cash ${rupee(p.cash)}` : p.mode ? ` (${p.mode})` : ''}</div>
        <button disabled={busy} onClick={() => { const pw = prompt('Admin password to unlock:'); if (pw) act(() => saveMonth(emp.code, mk, { locked: false })); }}
          className="text-xs text-amber-700 underline mt-1">Unlock / correct</button>
      </div>
    );
  }
  const total = Number(bank || 0) + Number(cash || 0);
  return (
    <div className="bg-red-50 border border-red-100 rounded-lg p-2 space-y-1.5">
      <div className="text-xs font-semibold text-gray-700">Pay {rupee(pay.net)} now — split it:</div>
      <div className="grid grid-cols-2 gap-1.5">
        <input className="border rounded px-2 py-1.5 text-sm" type="number" placeholder={`Bank ₹ (e.g. ${pay.net})`} value={bank} onChange={(e) => setBank(e.target.value)} />
        <input className="border rounded px-2 py-1.5 text-sm" type="number" placeholder="Cash ₹" value={cash} onChange={(e) => setCash(e.target.value)} />
      </div>
      {total > 0 && total !== pay.net && <p className="text-[11px] text-amber-700">Entered {rupee(total)} ≠ net {rupee(pay.net)} — double-check.</p>}
      <button disabled={busy || !canFinalize} onClick={() => act(async () => {
        const b = Number(bank || (cash ? 0 : pay.net)), c = Number(cash || 0);
        await saveMonth(emp.code, mk, {
          locked: true,
          payment: { date: today, bank: b, cash: c, net: pay.net, by: user.email },
          advanceRecover: pay.advanceRecovered,
        });
        // roll the unrecovered advance into next month automatically
        await saveMonth(emp.code, nextMonthKey(mk), { advanceBalanceIn: pay.advanceBalanceCarried });
      })} className="w-full bg-green-700 text-white rounded-lg py-2 text-sm font-bold disabled:opacity-40">✓ Mark PAID & lock</button>
      {!canFinalize && <p className="text-[11px] text-gray-500">Pay/lock opens at month-end (or now if the person has left). Payslip works anytime.</p>}
    </div>
  );
}

function NoSalaryList({ list, busy, act }) {
  const [show, setShow] = useState(false);
  const [vals, setVals] = useState({});
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-700">
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
                <button disabled={busy || !Number(v.amount)} onClick={() => act(() => saveEmployee(e.code, v.type === 'daily' ? { type: 'daily', wage: Number(v.amount) } : { type: 'monthly', amount: Number(v.amount) }))}
                  className="text-xs bg-gray-800 text-white rounded px-2 py-1 disabled:opacity-40">Set</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ k, v }) { return <div className="flex justify-between text-sm py-0.5"><span className="text-gray-500">{k}</span><span className="text-gray-800 text-right">{v}</span></div>; }
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
