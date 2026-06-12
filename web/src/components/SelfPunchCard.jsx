import { useEffect, useState } from 'react';
import { loadSelfPunchStaff } from '../lib/data';

// Owner view of app-only self-punch staff (Radhey/Dinesh): captured in/out + month totals.
export default function SelfPunchCard() {
  const [staff, setStaff] = useState(null);
  const [open, setOpen] = useState({});
  useEffect(() => { loadSelfPunchStaff().then(setStaff).catch(() => setStaff([])); }, []);

  if (!staff || staff.length === 0) return null;
  const monthName = new Date().toLocaleString('en', { month: 'long' });

  return (
    <div className="bg-white rounded-xl shadow p-4 mb-4">
      <div className="font-semibold text-gray-800 mb-1">App-only staff · self-punch</div>
      <p className="text-xs text-gray-500 mb-3">Times these workers record from their own link ({monthName}).</p>
      <div className="space-y-3">
        {staff.map((e) => (
          <div key={e.code} className="border border-gray-100 rounded-lg">
            <button onClick={() => setOpen(o => ({ ...o, [e.code]: !o[e.code] }))}
              className="w-full text-left p-3 flex items-center justify-between active:bg-gray-50">
              <div>
                <div className="font-medium text-gray-800">{e.name}</div>
                <div className="text-xs text-gray-500">{e.dept}{e.unit ? ' · ' + e.unit : ''} · {e.standardHours}h duty{e.amount ? ' · ₹' + Number(e.amount).toLocaleString('en-IN') + '/mo' : ''}</div>
              </div>
              <div className="text-right text-sm">
                <div><b>{e.present}</b> days · <b>{e.totalHours}</b>h</div>
                <div className="text-xs text-amber-700">{e.ot > 0 ? 'OT ' + e.ot + 'h' : 'no OT'}</div>
              </div>
            </button>
            {open[e.code] && (
              <ul className="text-sm divide-y divide-gray-100 border-t border-gray-100">
                {e.rows.length === 0 && <li className="p-3 text-gray-400">No punches yet this month.</li>}
                {e.rows.map((r) => (
                  <li key={r.date} className="px-3 py-2 flex items-center justify-between">
                    <span className="text-gray-600">{fmt(r.date)}</span>
                    <span className="text-gray-800">in {r.in || '—'} · out {r.out || '—'}
                      <span className="text-gray-400"> {r.hours != null ? '(' + r.hours + 'h)' : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(ymd) {
  const [, m, d] = ymd.split('-');
  const mon = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m];
  return `${+d} ${mon}`;
}
