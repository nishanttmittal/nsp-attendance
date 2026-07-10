import { useEffect, useMemo, useState } from 'react';
import { loadEmployee, loadAllAttendance, loadPunchDoc, saveEmployee, saveMonth, addAdvance, addIncrement, resignEmployee, settleAndResign, checkActionPassword, queueJob, editNameDept, istMonth } from '../lib/data';
import { monthCtx, payFor, rupee } from '../lib/paycalc';
import { payslipOnePdf, sharePdf } from '../lib/salaryPdf';
import { graceDeltaDays } from '../lib/attendanceEngine';

// One person, one page: this month's money, their ledger, their settings.
export default function Person({ code, mk, user, onBack }) {
  const [emp, setEmp] = useState(null);
  const [attMap, setAttMap] = useState({});
  const [punchDoc, setPunchDoc] = useState(null);
  const [busy, setBusy] = useState(false);
  const ctx = useMemo(() => monthCtx(mk), [mk]);
  const graceDelta = useMemo(() => (emp ? graceDeltaDays(emp.shift, punchDoc, mk, istMonth()) : 0), [emp, punchDoc, mk]);

  async function reload() {
    const [e, am, pd] = await Promise.all([loadEmployee(code), loadAllAttendance(), loadPunchDoc(code)]);
    setEmp(e); setAttMap(am); setPunchDoc(pd);
  }
  useEffect(() => { reload(); }, [code]);
  const act = async (fn) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };

  if (!emp) return <p className="text-gray-500">Loading…</p>;
  const { att, md, pay } = payFor(emp, attMap, mk, ctx, graceDelta);
  // freeze on tick: once approved, nothing about this month can be edited (undo tick to reopen)
  const locked = !!md.payment || !!md.approved;
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const presentPct = ctx.elapsedDays > 0 ? Math.round((pay.presentDays / ctx.elapsedDays) * 100) : 0;

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-sm text-gray-600">← Back to list</button>

      <div className="bg-white rounded-xl shadow p-4">
        <div className="font-bold text-lg text-gray-800">{emp.name || code}{emp.nickname ? <span className="text-gray-400 font-normal text-base"> ({emp.nickname})</span> : null}</div>
        <div className="text-xs text-gray-500">{emp.dept || ''} · {emp.shift || ''} · {emp.type === 'daily' ? rupee(emp.wage) + '/day' : rupee(emp.amount) + '/month'}</div>
        <div className="text-xs text-gray-500 mb-2">
          {emp.phone ? '📞 ' + emp.phone + ' · ' : ''}{emp.joinDate ? 'joined ' + emp.joinDate + ' · ' : ''}
          present {presentPct}% · late {att.lateDays || 0}× · OT {pay.otHrsNet}h
        </div>
        {md.approved && !md.payment && <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded p-1.5 mb-2">🔒 Ticked — figures frozen at {rupee(md.approvedNet)}. Undo the tick in the list to edit.</p>}
        {pay.noAttendance && <p className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded p-1.5 mb-2">ℹ️ No attendance for {mk} — not employed this month (joined later). Pays ₹0; old months don't apply.</p>}
        <Row k="Days" v={`present ${pay.presentDays} · absent ${pay.absentDays}`} />
        {(() => {
          const unpaid = pay.unpaidWorkedSat || 0;
          const sat = (att.weeklyOff || 0) + (att.weeklyOffPresent || 0) - unpaid;  // paid Saturdays only
          if (!sat && !att.weeklyOffPresent) return null;
          return <Row k="Weekly off (paid)" v={`${sat} Sat${att.weeklyOffPresent ? ` · worked ${att.weeklyOffPresent} → +OT` : ''}`} />;
        })()}
        {pay.unpaidWorkedSat > 0 && <Row k="Worked Sat (OT only)" v={`${pay.unpaidWorkedSat} — week not earned (4+ absences): day unpaid, OT kept`} />}
        {emp.type !== 'daily' && !pay.noAttendance && <Row k="Paid days" v={`${Math.max(0, (pay.payableDays || 0) - (pay.absentDays || 0))} of ${ctx.daysInMonth} (weekly-offs included)`} />}
        <Row k="Overtime" v={`${pay.otHrs}h → pays ${pay.otHrsNet}h`} />
        <hr className="my-1.5" />
        <Row k="Base pay" v={rupee(pay.base)} />
        <Row k="+ Overtime" v={rupee(pay.otPay)} />
        {pay.perfectBonus > 0 && <Row k="+ Full-attendance bonus" v={rupee(pay.perfectBonus)} />}
        {pay.gracePay > 0 && <Row k={`+ 15-min grace (${pay.graceDays} day)`} v={rupee(pay.gracePay)} />}
        {pay.restoreSaturdayPay > 0 && <Row k={`+ ${pay.restoreSaturdayDays} Saturday${pay.restoreSaturdayDays > 1 ? 's' : ''} (goodwill)`} v={rupee(pay.restoreSaturdayPay)} />}
        {pay.bonus > 0 && <Row k="+ Bonus" v={rupee(pay.bonus)} />}
        {pay.fines > 0 && <Row k="− Fine" v={rupee(pay.fines)} />}
        {pay.loanInstallment > 0 && <Row k="− Loan" v={rupee(pay.loanInstallment)} />}
        {pay.advanceRecovered > 0 && <Row k="− Advance" v={rupee(pay.advanceRecovered)} />}
        <div className="flex justify-between mt-1 pt-1.5 border-t font-bold"><span>This month ({mk})</span><span className="text-red-700">{rupee(locked && md.payment ? md.payment.net : pay.net)}</span></div>
        {md.payment && <p className="text-xs text-green-700 mt-1">✓ Paid {md.payment.date} ({md.payment.mode})</p>}
        {pay.advanceBalanceCarried > 0 && <p className="text-xs text-amber-700 mt-1">Still owes {rupee(pay.advanceBalanceCarried)} advance — carries forward.</p>}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <button onClick={() => sharePdf(payslipOnePdf(emp, pay, mk), `payslip-${code}-${mk}.pdf`)} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">📄 PDF</button>
          <button onClick={() => {
            const sat = (att.weeklyOff || 0) + (att.weeklyOffPresent || 0);
            const L = [`*NSP — Salary ${mk}*`, `${emp.name || code}`, `Days: ${pay.presentDays} present / ${pay.absentDays} absent` + (sat ? ` / ${sat} weekly-off (paid)` : '') + (pay.saturdaysCut ? ` / ${pay.saturdaysCut} Sat cut` : ''), `OT: ${pay.otHrsNet}h`,
              `Base ₹${pay.base}` + (pay.otPay ? ` + OT ₹${pay.otPay}` : '') + (pay.perfectBonus ? ` + bonus ₹${pay.perfectBonus}` : '') + (pay.gracePay ? ` + grace ₹${pay.gracePay}` : '') + (pay.restoreSaturdayPay ? ` + ${pay.restoreSaturdayDays} Sat goodwill ₹${pay.restoreSaturdayPay}` : '') + (pay.bonus ? ` + bonus ₹${pay.bonus}` : ''),
              ...(pay.fines ? [`Fine −₹${pay.fines}`] : []), ...(pay.loanInstallment ? [`Loan −₹${pay.loanInstallment}`] : []), ...(pay.advanceRecovered ? [`Advance −₹${pay.advanceRecovered}`] : []),
              `*NET: ₹${(locked && md.payment ? md.payment.net : pay.net).toLocaleString('en-IN')}*`];
            const phone = (emp.phone || '').replace(/\D/g, '');
            window.open(`https://wa.me/${phone ? (phone.length === 10 ? '91' + phone : phone) : ''}?text=${encodeURIComponent(L.join('\n'))}`);
          }} className="border border-green-300 text-green-700 rounded-lg py-2 text-sm font-medium">🟢 WhatsApp</button>
          <button onClick={async () => { await queueJob('payslip', { code, month: mk }, user.email); alert('Sent to Telegram.'); }} className="border border-gray-300 rounded-lg py-2 text-sm font-medium">✈️ Telegram</button>
        </div>
      </div>

      {!locked && (
        <div className="bg-white rounded-xl shadow p-3 space-y-1">
          <div className="text-sm font-semibold text-gray-700">Adjust this month</div>
          {pay.type !== 'daily' && graceDelta > 0 && (
            <label className="flex items-center justify-between py-1">
              <span className="text-sm">⏱ Pay 15-min grace <span className="text-gray-500">(+{graceDelta} day = {rupee(pay.perDay * graceDelta)})</span></span>
              <input type="checkbox" className="w-5 h-5" checked={!!md.gracePaid} disabled={busy} onChange={(e) => act(() => saveMonth(code, mk, { gracePaid: e.target.checked }))} />
            </label>
          )}
          {pay.type !== 'daily' && <NumRow label={`Give back Saturdays${pay.saturdaysCut > 0 ? ` (${pay.saturdaysCut} cut · ${rupee(pay.perDay)}/day)` : ` (${rupee(pay.perDay)}/day)`}`} val={md.restoreSaturdays} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { restoreSaturdays: v }))} />}
          <NumRow label="Bonus ₹" val={md.bonus} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { bonus: v }))} />
          <NumRow label="Fine ₹" val={md.fine} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { fine: v }))} />
          <NumRow label="Loan cut ₹" val={md.loanInstallment} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { loanInstallment: v }))} />
          <NumRow label={`Advance cut ₹ (owes ${rupee(pay.advanceDue)})`} val={md.advanceRecover ?? pay.advanceDue} disabled={busy} onSave={(v) => act(() => saveMonth(code, mk, { advanceRecover: v }))} />
        </div>
      )}

      <Ledger title="💸 Advances" withMode items={(emp.advances || []).map((a) => ({ d: a.date, t: `${a.mode}${a.remark ? ' · ' + a.remark : ''}${a.paidBy ? ' · by ' + String(a.paidBy).split('@')[0] : ''}`, v: rupee(a.amount) }))}
        submit="Add advance" busy={busy || locked} defDate={today}
        onAdd={(f) => act(() => addAdvance(code, { date: f.date, mode: f.mode, amount: Number(f.amount), remark: f.remark || '', paidBy: user.email }))} />

      <Ledger title="📈 Increments" items={(emp.increments || []).map((i) => ({ d: i.effective, t: i.remark || '', v: '+' + rupee(i.amount), green: true }))}
        submit="Add increment (from that date onward)" busy={busy || locked} defDate={mk + '-01'}
        onAdd={(f) => act(() => addIncrement(code, { amount: Number(f.amount), effective: f.date, remark: f.remark || '' }))} />

      <PaymentsHistory emp={emp} />

      <CorrectionsLog emp={emp} />

      <SalaryEdit emp={emp} busy={busy}
        onSave={(patch) => act(() => saveEmployee(code, patch))}
        onSaveNameDept={(nd) => act(() => editNameDept(code, nd, user.email))} />

      {emp.active !== false ? (
        <button disabled={busy || locked} onClick={async () => {
          const last = prompt(`Final settlement for ${emp.name}.\nLast working day (YYYY-MM-DD):`, today);
          if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(last)) { if (last != null) alert('Enter the date as YYYY-MM-DD.'); return; }
          // recompute pay capped at the last working day (prorates a mid-month exit)
          const sp = payFor({ ...emp, exitDate: last }, attMap, mk, ctx).pay;
          const net = sp.net;
          if (!confirm(`Final settlement for ${emp.name}:\n\n` +
            `Days: ${sp.presentDays} present / ${sp.absentDays} absent\n` +
            `Base ₹${sp.base} + OT ₹${sp.otPay}` + (sp.perfectBonus ? ` + bonus ₹${sp.perfectBonus}` : '') + (sp.bonus ? ` + bonus ₹${sp.bonus}` : '') + '\n' +
            (sp.advanceRecovered ? `− Advance ₹${sp.advanceRecovered}\n` : '') +
            `\nFINAL PAYABLE: ₹${net.toLocaleString('en-IN')}\n\n` +
            `This pays & locks ${mk}, removes the worker (last day ${last}). Continue?`)) return;
          const pw = prompt('Enter the action password to confirm:');
          if (pw == null) return;
          const ok = await checkActionPassword(pw);
          if (ok === 'unset') { if (!confirm('No action password set yet (set one in ⚙ Settings). Settle & resign anyway?')) return; }
          else if (!ok) { alert('Wrong password.'); return; }
          act(() => settleAndResign(code, mk, sp, last, user.email));
        }} className="w-full border border-red-200 text-red-700 rounded-lg py-2 text-sm disabled:opacity-40">Final settlement &amp; resign {emp.name}</button>
      ) : (
        <div className="text-center text-xs text-gray-400">
          Resigned {emp.resignedAt || emp.exitDate || ''}{md.payment?.settlement ? ` · final settled ${rupee(md.payment.net)}` : ''}
        </div>
      )}
    </div>
  );
}

// log + entry form: every advance/increment goes in with date, amount, (mode) and remark
function Ledger({ title, items, withMode, submit, onAdd, busy, defDate }) {
  const [f, setF] = useState({ amount: '', mode: 'cash', remark: '', date: defDate });
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">{title} ({items.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
        {items.length === 0 && <li className="text-gray-400 py-1">None yet</li>}
        {[...items].reverse().map((x, i) => <li key={i} className="py-1 flex justify-between"><span>{x.d}{x.t ? ' · ' + x.t : ''}</span><b className={x.green ? 'text-green-700' : ''}>{x.v}</b></li>)}
      </ul>
      <div className="grid grid-cols-2 gap-1.5 mt-2">
        <input className="border rounded px-2 py-1.5 text-sm" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input className="border rounded px-2 py-1.5 text-sm" type="number" placeholder="Amount ₹" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        {withMode && <select className="border rounded px-2 py-1.5 text-sm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="cash">Cash</option><option value="account">Bank</option></select>}
        <input className={`border rounded px-2 py-1.5 text-sm ${withMode ? '' : 'col-span-2'}`} placeholder="Remark (optional)" value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
        <button disabled={busy || !Number(f.amount) || !f.date} onClick={() => { onAdd(f); setF({ amount: '', mode: 'cash', remark: '', date: defDate }); }}
          className="col-span-2 bg-gray-800 text-white rounded py-1.5 text-xs font-medium disabled:opacity-40">{submit}</button>
      </div>
    </div>
  );
}

// read-only log of every salary payment made to this person
function PaymentsHistory({ emp }) {
  const rows = Object.entries(emp.months || {})
    .filter(([, m]) => m && m.payment)
    .map(([mk, m]) => ({ mk, ...m.payment }))
    .sort((a, b) => (a.mk < b.mk ? 1 : -1));
  if (!rows.length) return null;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">🧾 Salary payments ({rows.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
        {rows.map((p) => (
          <li key={p.mk} className="py-1 flex justify-between">
            <span>{p.mk} · paid {p.date} · {p.mode}{p.bank != null ? ` (bank ${rupee(p.bank)} + cash ${rupee(p.cash)})` : ''}{p.by ? ' · by ' + String(p.by).split('@')[0] : ''}</span>
            <b>{rupee(p.net)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// permanent log of attendance corrections (written by the worker on each manual punch)
function CorrectionsLog({ emp }) {
  const rows = [...(emp.corrections || [])].reverse();
  if (!rows.length) return null;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="text-sm font-semibold text-gray-700 mb-1">📝 Attendance corrections ({rows.length})</div>
      <ul className="text-xs divide-y divide-gray-100 max-h-44 overflow-auto">
        {rows.map((c, i) => (
          <li key={i} className="py-1">
            <div className="flex justify-between"><span className="font-medium">{c.date}</span><span className="text-gray-500">{c.in ? 'in ' + c.in : ''}{c.in && c.out ? ' · ' : ''}{c.out ? 'out ' + c.out : ''}</span></div>
            <div className="text-gray-500">{c.reason || ''}{c.by ? ' · by ' + String(c.by).split('@')[0] : ''}{c.at ? ' · ' + c.at.slice(0, 16).replace('T', ' ') : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SalaryEdit({ emp, onSave, onSaveNameDept, busy }) {
  const [show, setShow] = useState(false);
  const DEPTS = ['FITTING', 'Frame', 'HELPER', 'POWDER', 'PRESS', 'T', 'DEMO'];
  const [f, setF] = useState({
    type: emp.type || 'monthly', amount: emp.type === 'daily' ? emp.wage : emp.amount, shift: emp.shift || 'GEN',
    phone: emp.phone || '', joinDate: emp.joinDate || '', nickname: emp.nickname || '',
  });
  const [nd, setNd] = useState({ name: emp.name || '', dept: emp.dept || '' });
  const ndChanged = nd.name !== (emp.name || '') || nd.dept !== (emp.dept || '');
  const onMachine = !emp.appOnly && emp.onMachine !== false;
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <button onClick={() => setShow(!show)} className="w-full text-left text-sm font-semibold text-gray-700">⚙ Salary &amp; profile {show ? '▲' : '▼'}</button>
      {show && (
        <div className="space-y-3 mt-2">
          {/* Name + Department — corrections here are pushed to the biometric machine too */}
          <div className="border rounded-lg p-2">
            <div className="text-xs text-gray-500 mb-1">Name &amp; department {onMachine ? '(also updated on the machine)' : '(app-only worker)'}</div>
            <input className="border rounded px-2 py-2 text-sm w-full mb-1.5" placeholder="Full name" value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} />
            <select className="border rounded px-2 py-2 text-sm w-full" value={nd.dept} onChange={(e) => setNd({ ...nd, dept: e.target.value })}>
              <option value="">— department —</option>
              {[...new Set([emp.dept, ...DEPTS].filter(Boolean))].map((d) => <option key={d}>{d}</option>)}
            </select>
            <button disabled={busy || !ndChanged} onClick={() => onSaveNameDept({ name: nd.name, dept: nd.dept })}
              className="mt-1.5 w-full bg-gray-800 text-white rounded py-1.5 text-xs font-medium disabled:opacity-40">
              {onMachine ? 'Save & push to machine' : 'Save name/dept'}
            </button>
          </div>
          {/* Salary / profile (app-only — not on the machine) */}
          <div className="grid grid-cols-3 gap-2">
            <select className="border rounded px-2 py-2 text-sm" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="monthly">Monthly</option><option value="daily">Daily</option>
            </select>
            <input className="border rounded px-2 py-2 text-sm" type="number" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <select className="border rounded px-2 py-2 text-sm" value={f.shift} onChange={(e) => setF({ ...f, shift: e.target.value })}>
              {['GEN', '10H', '12H', 'wir'].map((s) => <option key={s}>{s}</option>)}
            </select>
            <input className="border rounded px-2 py-2 text-sm col-span-3" placeholder="Nickname (e.g. Raju Chrome line)" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
            <input className="border rounded px-2 py-2 text-sm col-span-2" placeholder="📞 Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <input className="border rounded px-2 py-2 text-sm" type="date" title="Joining date" value={f.joinDate} onChange={(e) => setF({ ...f, joinDate: e.target.value })} />
            <button disabled={busy} onClick={() => onSave({
              ...(f.type === 'daily' ? { type: 'daily', wage: Number(f.amount) } : { type: 'monthly', amount: Number(f.amount) }),
              shift: f.shift, phone: f.phone, joinDate: f.joinDate, nickname: f.nickname,
            })} className="col-span-3 bg-gray-800 text-white rounded py-1.5 text-xs font-medium">Save salary &amp; profile</button>
          </div>
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
