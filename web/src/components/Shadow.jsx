import { useEffect, useMemo, useState } from 'react';
import { loadEmployees, loadAllAttendance, loadAllPunches, istMonth } from '../lib/data';
import { computeMonth } from '../lib/attendanceEngine';
import { attendanceDetailPdf, sharePdf } from '../lib/salaryPdf';

// SHADOW view (owner-only): the app computes present/half/absent/weekly-off from RAW punches with
// the clean rules, shown next to the portal's published numbers. Read-only — changes no pay.
// Purpose: watch the app engine for a full month before it becomes the source of truth.

const prevMonth = (mk) => { const [y, m] = mk.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const pad = (n) => String(n).padStart(2, '0');

// build { 'YYYY-MM-DD': {i,o} } across the target month + the previous month (for first-week earning)
function punchesByDate(punchDoc, mk) {
  const months = (punchDoc && punchDoc.months) || {};
  const out = {};
  for (const key of [prevMonth(mk), mk]) {
    const days = months[key] || {};
    for (const dd of Object.keys(days)) out[`${key}-${dd}`] = days[dd];
  }
  return out;
}

function windowFor(mk) {
  const cur = istMonth();
  const [y, m] = mk.split('-').map(Number);
  const start = `${mk}-01`;
  if (mk === cur) {
    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    const yest = new Date(Date.UTC(y, m - 1, nowIst.getUTCDate() - 1));
    return { start, to: yest.toISOString().slice(0, 10) };
  }
  const last = new Date(Date.UTC(y, m, 0));
  return { start, to: last.toISOString().slice(0, 10) };
}

export default function Shadow() {
  const [emps, setEmps] = useState([]);
  const [portal, setPortal] = useState({});
  const [punches, setPunches] = useState({});
  const [mk, setMk] = useState(istMonth());
  const [grace, setGrace] = useState(true);
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { (async () => {
    setLoading(true);
    const [e, p, pu] = await Promise.all([loadEmployees(), loadAllAttendance(), loadAllPunches()]);
    setEmps(e); setPortal(p); setPunches(pu); setLoading(false);
  })(); }, []);

  const rows = useMemo(() => {
    const win = windowFor(mk);
    return emps.filter((e) => e.type !== 'daily' && punches[e.code]).map((e) => {
      const pbd = punchesByDate(punches[e.code], mk);
      const appOn = computeMonth(e.shift || 'GEN', pbd, win, { grace: true });
      const appOff = computeMonth(e.shift || 'GEN', pbd, win, { grace: false });
      const app = grace ? appOn : appOff;
      const graceDelta = Math.round((appOn.present - appOff.present) * 100) / 100;   // extra present days grace gives
      const missed = app.detail.filter((d) => (d.in && !d.out) || (!d.in && d.out)).length;  // one punch only = forgot in/out
      const pm = (portal[e.code]?.months || {})[mk] || {};
      const pP = pm.presentDays, pA = pm.absentDays;
      const match = pP != null && Math.abs(app.present - (pP || 0)) < 0.01 && Math.abs(app.absent - (pA || 0)) < 0.01;
      return { e, app, graceDelta, missed, portal: { present: pP, absent: pA, weeklyOff: pm.weeklyOff, weeklyOffPresent: pm.weeklyOffPresent }, match, hasPortal: pP != null };
    }).sort((a, b) => (b.graceDelta - a.graceDelta) || (b.missed - a.missed) || (a.match === b.match ? 0 : a.match ? 1 : -1));
  }, [emps, portal, punches, mk, grace]);

  const nMatch = rows.filter((r) => r.match).length;
  const nDiff = rows.filter((r) => r.hasPortal && !r.match).length;
  const nGrace = rows.filter((r) => r.graceDelta > 0).length;
  const nMissed = rows.reduce((s, r) => s + r.missed, 0);

  if (loading) return <div className="text-gray-500 text-sm">Loading punches…</div>;

  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-900">
        <b>Shadow mode.</b> The app calculates attendance itself from raw punches (clean Full / Half / Absent).
        Shown next to the portal for checking — <b>this changes no salary.</b>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={mk} onChange={(e) => setMk(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value={istMonth()}>This month ({istMonth()})</option>
          <option value={prevMonth(istMonth())}>Last month ({prevMonth(istMonth())})</option>
        </select>
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={grace} onChange={(e) => setGrace(e.target.checked)} /> 15-min grace
        </label>
        <span className="text-[12px] text-gray-500 ml-auto"><span className="text-indigo-600">{nGrace} grace</span> · <span className="text-orange-600">{nMissed} missed</span> · <span className="text-red-600">{nDiff} differ</span></span>
      </div>

      <div className="bg-white rounded-xl shadow divide-y">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 text-[11px] font-semibold text-gray-500">
          <span>Worker</span><span className="text-right">App (P / A / ½ / WO)</span><span className="text-right">Portal</span>
        </div>
        {rows.map((r) => (
          <div key={r.e.code}>
            <button onClick={() => setOpen(open === r.e.code ? null : r.e.code)}
              className="w-full grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 text-left items-center">
              <span className="text-sm truncate">{r.match ? '' : '⚠️ '}{r.e.name || r.e.code}
                {r.graceDelta > 0 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-700 rounded px-1 py-0.5 whitespace-nowrap">⏱ +{r.graceDelta}d grace</span>}
                {r.missed > 0 && <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 rounded px-1 py-0.5 whitespace-nowrap">📌 {r.missed} missed</span>}</span>
              <span className={`text-right text-sm tabular-nums ${r.match ? 'text-gray-800' : 'text-red-700 font-medium'}`}>
                {r.app.present} / {r.app.absent} / {r.app.half} / {r.app.weeklyOff}{r.app.weeklyOffPresent ? `+${r.app.weeklyOffPresent}` : ''}
              </span>
              <span className="text-right text-[12px] text-gray-400 tabular-nums">
                {r.hasPortal ? `${r.portal.present} / ${r.portal.absent} / – / ${r.portal.weeklyOff || 0}` : '—'}
              </span>
            </button>
            {open === r.e.code && (
              <div className="px-3 pb-2 bg-gray-50 text-[12px] text-gray-600 space-y-0.5">
                <button onClick={() => sharePdf(attendanceDetailPdf(r.e, mk, r.app, grace), `attendance-${r.e.code}-${mk}.pdf`)}
                  className="mb-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-[12px] font-medium bg-white">📄 Print / PDF this month</button>
                <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 items-baseline">
                  {r.app.detail.map((d) => (
                    <div key={d.ymd} className="contents">
                      <span className="text-gray-500">{d.ymd.slice(5)} {DOW[new Date(d.ymd + 'T00:00:00').getDay()]}</span>
                      <span className="tabular-nums text-gray-700">{d.in || '—'} <span className="text-gray-400">→</span> {d.out || (d.in ? 'no out' : '—')}</span>
                      <span className={`text-right ${d.kind === 'absent' || d.kind === 'sat-absent' ? 'text-red-500' : d.kind === 'half' ? 'text-amber-600' : 'text-gray-700'}`}>
                        {d.worked != null ? `${d.worked.toFixed(2)}h · ` : d.single ? 'single · ' : ''}{LABEL[d.kind] || d.kind}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">Overtime still comes from the portal for now — day classification is what the app computes here.</p>
    </div>
  );
}

const LABEL = { full: 'Full', half: 'Half', absent: 'Absent', 'weekly-off': 'Weekly-off (paid)', 'sat-worked': 'Saturday worked (OT)', 'sat-absent': 'Saturday cut' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
