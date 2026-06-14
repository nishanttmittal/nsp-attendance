import { useEffect, useState } from 'react';
import { loadArchive } from '../lib/data';
import { rupee } from '../lib/paycalc';

// Archive of resigned + removed workers. The machine record is deleted on resign, but the
// full payroll record + punch history is kept here (att_archive) so nothing is ever lost.
export default function Archive() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { loadArchive().then(setRows).catch(() => setRows([])); }, []);

  if (rows === null) return <p className="text-gray-500">Loading…</p>;
  if (!rows.length) return (
    <div className="text-center text-gray-500 py-10">
      <div className="text-3xl mb-2">🗄️</div>
      <p className="text-sm">No archived workers yet.</p>
      <p className="text-xs text-gray-400 mt-1">When you resign someone, their full record is saved here before they're removed from the machine.</p>
    </div>
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">{rows.length} archived worker{rows.length > 1 ? 's' : ''}. Their history is kept safe even though they're removed from the machine.</p>
      {rows.map((a) => {
        const payments = Object.entries((a.salary && a.salary.months) || {})
          .filter(([, m]) => m && m.payment).map(([mk, m]) => ({ mk, ...m.payment }))
          .sort((x, y) => (x.mk < y.mk ? 1 : -1));
        const last = payments[0];
        const isOpen = open === a.code;
        return (
          <div key={a.code} className="bg-white rounded-xl shadow">
            <button onClick={() => setOpen(isOpen ? null : a.code)} className="w-full text-left p-3">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold text-gray-800">{a.name || a.code}</div>
                  <div className="text-xs text-gray-500">{a.dept || ''} · code {a.code}</div>
                </div>
                <div className="text-right text-xs text-gray-400">
                  archived<br />{(a.archivedAt || '').slice(0, 10)}
                </div>
              </div>
            </button>
            {isOpen && (
              <div className="px-3 pb-3 text-sm border-t border-gray-100 pt-2 space-y-1">
                <Row k="Joined" v={a.doj || (a.salary && a.salary.joinDate) || '—'} />
                <Row k="Resigned / exit" v={(a.salary && (a.salary.exitDate || a.salary.resignedAt)) || '—'} />
                <Row k="Salary" v={a.salary ? (a.salary.type === 'daily' ? rupee(a.salary.wage) + '/day' : rupee(a.salary.amount) + '/month') : '—'} />
                {last && <Row k="Last payment" v={`${rupee(last.net)} · ${last.date || ''} · ${last.mode || ''}`} />}
                <Row k="Punch history" v={a.inoutFileName ? '✅ saved (sent to Telegram)' : '— not captured'} />
                {payments.length > 0 && (
                  <div className="pt-1">
                    <div className="text-xs font-semibold text-gray-600">Payments ({payments.length})</div>
                    <ul className="text-xs divide-y divide-gray-100 max-h-40 overflow-auto">
                      {payments.map((p) => (
                        <li key={p.mk} className="py-1 flex justify-between">
                          <span>{p.mk} · {p.date || ''} · {p.mode || ''}</span><b>{rupee(p.net)}</b>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Row({ k, v }) { return <div className="flex justify-between"><span className="text-gray-500">{k}</span><span className="text-gray-800">{v}</span></div>; }
