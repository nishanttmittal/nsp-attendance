import { useEffect, useState } from 'react';
import { loadSelfPunchStaff, saveMonth } from '../lib/data';

// Owner view of app-only self-punch staff (Radhey/Dinesh/Munnilal): captured in/out +
// month totals, with a manual override (days/hours) that wins over the punch data.
export default function SelfPunchCard() {
  const [staff, setStaff] = useState(null);
  const [open, setOpen] = useState({});
  const refresh = () => loadSelfPunchStaff().then(setStaff).catch(() => setStaff([]));
  useEffect(() => { refresh(); }, []);

  if (!staff || staff.length === 0) return null;
  const monthName = new Date().toLocaleString('en', { month: 'long' });

  return (
    <div className="bg-white rounded-xl shadow p-4 mb-4">
      <div className="font-semibold text-gray-800 mb-1">App-only staff · self-punch</div>
      <p className="text-xs text-gray-500 mb-3">Times they record from their own link ({monthName}). You can override days/hours for salary.</p>
      <div className="space-y-3">
        {staff.map((e) => (
          <Row key={e.code} e={e} open={!!open[e.code]} toggle={() => setOpen(o => ({ ...o, [e.code]: !o[e.code] }))} onSaved={refresh} />
        ))}
      </div>
    </div>
  );
}

function Row({ e, open, toggle, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ days: e.present ?? '', hours: e.totalHours ?? '', ot: e.ot ?? '' });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    // Write where PAYROLL READS: months[month].override (paycalc.js). This card used to write a
    // TOP-LEVEL emp.override[month], which payroll never looked at — so its own promise that the
    // override "wins for salary" was false (Codex review 2026-07-30). No data was orphaned: no
    // worker had a top-level override when this was fixed.
    await saveMonth(e.code, e.month, { override: { days: Number(f.days) || 0, hours: Number(f.hours) || 0, ot: Number(f.ot) || 0 } });
    setBusy(false); setEdit(false); onSaved();
  }
  async function clearOverride() {
    setBusy(true);
    await saveMonth(e.code, e.month, { override: null });
    setBusy(false); setEdit(false); onSaved();
  }

  return (
    <div className="border border-gray-100 rounded-lg">
      <button onClick={toggle} className="w-full text-left p-3 flex items-center justify-between active:bg-gray-50">
        <div>
          <div className="font-medium text-gray-800">{e.name}</div>
          <div className="text-xs text-gray-500">
            {e.dept}{e.unit ? ' · ' + e.unit : ''} · {e.dutyStart && e.dutyEnd ? e.dutyStart + '–' + e.dutyEnd : e.standardHours + 'h'}
            {e.isDriver ? ' · driver' : ''}{e.amount ? ' · ₹' + Number(e.amount).toLocaleString('en-IN') + '/mo' : ' · no salary set'}
          </div>
        </div>
        <div className="text-right text-sm">
          <div><b>{e.present}</b> days · <b>{e.totalHours}</b>h {e.manual && <span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1">manual</span>}</div>
          <div className="text-xs text-amber-700">{e.ot > 0 ? 'OT ' + e.ot + 'h' : 'no OT'}</div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
            <span className="text-xs text-gray-500">{e.manual ? 'Using manual figures' : 'From punches'} · auto: {e.autoPresent}d / {e.autoHours}h</span>
            <button onClick={() => { setEdit(v => !v); setF({ days: e.present ?? '', hours: e.totalHours ?? '', ot: e.ot ?? '' }); }}
              className="text-xs text-red-700 border border-red-200 rounded px-2 py-1">{edit ? 'Cancel' : 'Set manually'}</button>
          </div>

          {edit && (
            <div className="px-3 py-3 space-y-2 bg-gray-50 border-t border-gray-100">
              <div className="grid grid-cols-3 gap-2">
                <L label="Present days"><input className="inp2" type="number" value={f.days} onChange={ev => setF({ ...f, days: ev.target.value })} /></L>
                <L label="Total hours"><input className="inp2" type="number" value={f.hours} onChange={ev => setF({ ...f, hours: ev.target.value })} /></L>
                <L label="OT hours"><input className="inp2" type="number" value={f.ot} onChange={ev => setF({ ...f, ot: ev.target.value })} /></L>
              </div>
              <div className="flex gap-2">
                <button onClick={save} disabled={busy} className="flex-1 bg-red-700 text-white rounded py-2 text-sm font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Save override'}</button>
                {e.manual && <button onClick={clearOverride} disabled={busy} className="border border-gray-300 text-gray-700 rounded py-2 px-3 text-sm">Use punches</button>}
              </div>
              <style>{`.inp2{width:100%;border:1px solid #d1d5db;border-radius:.4rem;padding:.4rem .5rem}`}</style>
            </div>
          )}

          <ul className="text-sm divide-y divide-gray-100 border-t border-gray-100">
            {e.rows.length === 0 && <li className="p-3 text-gray-400">No punches yet this month.</li>}
            {e.rows.map((r) => (
              <li key={r.date} className="px-3 py-2 flex items-center justify-between">
                <span className="text-gray-600">{fmt(r.date)}{r.overnight ? ' 🌙' : ''}</span>
                <span className="text-gray-800">in {r.in || '—'} · out {r.out || '—'}
                  <span className="text-gray-400"> {r.fullDay ? '(full day)' : r.hours != null ? '(' + r.hours + 'h)' : ''}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function L({ label, children }) { return <label className="block"><span className="text-[11px] text-gray-500">{label}</span><div className="mt-0.5">{children}</div></label>; }
function fmt(ymd) {
  const [, m, d] = ymd.split('-');
  const mon = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m];
  return `${+d} ${mon}`;
}
