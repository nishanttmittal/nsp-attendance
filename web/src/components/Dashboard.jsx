import { useEffect, useState } from 'react';
import { getDailyState } from '../lib/data';

export default function Dashboard() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [showPresent, setShowPresent] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = (manual = false) => {
    if (manual) setRefreshing(true);
    return getDailyState().then(setS).catch((e) => setErr(String(e))).finally(() => setRefreshing(false));
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 120000); // auto-refresh every 2 min
    return () => clearInterval(id);
  }, []);

  if (err) return <p className="text-red-600">{err}</p>;
  if (!s) return <p className="text-gray-500">Loading floor…</p>;

  const presentRows = s.presentRows || [];
  const freshness = checkFreshness(s);

  return (
    <div className="space-y-4">
      {s._mock && <Banner>Showing sample data (live data wires in once the scraper job + Firebase are connected).</Banner>}
      {freshness && <FreshnessBanner f={freshness} />}

      <div className="flex justify-end -mb-1">
        <button onClick={() => load(true)} disabled={refreshing}
          className="text-sm flex items-center gap-1.5 text-red-700 border border-red-200 rounded-lg px-3 py-1.5 active:bg-red-50 disabled:opacity-50">
          <span className={refreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Present now ›" value={s.counts?.totalPresent ?? s.presentTotal} accent="text-green-700"
          onClick={() => setShowPresent(v => !v)} />
        <Stat label="Absent" value={s.counts?.totalAbsent ?? '—'} accent="text-gray-700" />
        <Stat label="Late today" value={s.lateCount} accent="text-amber-600" />
        <Stat label={`🍽️ Order food for`} value={s.mealHeadcount} accent="text-red-700"
          sub={`still in, excl. ${s.mealExcludes}`} />
      </div>

      {showPresent && (
        <Card title={`Present (${presentRows.length})`}>
          {presentRows.length === 0 ? <p className="text-sm text-gray-500">No names available.</p> : (
            <ul className="text-sm divide-y divide-gray-100 max-h-72 overflow-auto">
              {presentRows.map((r) => (
                <li key={r.code} className="py-1.5 flex justify-between gap-2">
                  <span className="truncate">{r.name} <span className="text-gray-400">({r.dept})</span></span>
                  <span className="text-gray-500 whitespace-nowrap tabular-nums">in {(r.inT || '—').slice(0, 5)} · {r.outT ? <span className="text-red-500">out {String(r.outT).slice(0, 5)}</span> : <span className="text-green-600">still in</span>}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Department attendance (present / total)">
        <div className="space-y-2">
          {Object.entries(s.deptRatio || {}).sort((a, b) => a[1].pct - b[1].pct).map(([d, r]) => (
            <div key={d}>
              <div className="flex justify-between text-sm">
                <span className="text-gray-700">{d}</span>
                <span className="text-gray-600"><b>{r.present}/{r.total}</b> · {r.pct}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded mt-0.5">
                <div className={`h-1.5 rounded ${r.pct < 50 ? 'bg-red-500' : r.pct < 80 ? 'bg-amber-500' : 'bg-green-600'}`}
                  style={{ width: `${r.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title={`Late comings (${s.lateCount})`}>
        {(!s.late || s.late.length === 0) ? <p className="text-sm text-gray-500">None 🎉</p> : (
          <ul className="text-sm divide-y divide-gray-100">
            {s.late.map((l) => (
              <li key={l.code} className="py-1.5 flex justify-between">
                <span>{l.name} <span className="text-gray-400">({l.dept})</span></span>
                <span className="text-gray-500">in {l.inT} · {l.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Absent today (${s.absentCount ?? (s.absent || []).length})`}>
        {(!s.absent || s.absent.length === 0) ? <p className="text-sm text-gray-500">None</p> : (
          <ul className="text-sm divide-y divide-gray-100">
            {s.absent.map((a) => (
              <li key={a.code} className="py-1.5 flex justify-between">
                <span>{a.name}</span><span className="text-gray-400">{a.dept}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(s.longAbsence && s.longAbsence.length > 0) && (
        <Card title="Long absence — >4 days this month">
          <ul className="text-sm divide-y divide-gray-100">
            {s.longAbsence.map((e) => (
              <li key={e.code} className="py-1.5 flex justify-between">
                <span>{e.name}</span><span className="font-semibold text-red-700">{e.absentDays} days</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-gray-400 text-center">
        {s.dataDate ? `Showing ${fmtDay(s.dataDate)} · ` : ''}updated {(s.publishedAt || s.at) ? new Date(s.publishedAt || s.at).toLocaleString() : '—'}
      </p>
    </div>
  );
}

// Returns null when fresh, else { level:'red'|'amber', text } describing the staleness.
function checkFreshness(s) {
  if (s._mock) return null;
  const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (s.dataDate && s.dataDate !== istToday) {
    return { level: 'red', text: `Showing ${fmtDay(s.dataDate)} — the biometric machine hasn’t sent today’s punches yet. Please check the device’s internet/power at the factory; the app will catch up automatically once data flows.` };
  }
  const stamp = s.publishedAt || s.at;
  if (stamp) {
    const mins = Math.round((Date.now() - new Date(stamp).getTime()) / 60000);
    if (mins > 30) return { level: 'amber', text: `Floor data hasn’t refreshed in ${mins} min — the auto-updater may be paused. Latest figures may be behind.` };
  }
  return null;
}

function fmtDay(ymd) {
  const [y, m, d] = (ymd || '').split('-');
  const mon = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m] || m;
  return `${+d} ${mon}`;
}

function FreshnessBanner({ f }) {
  const cls = f.level === 'red'
    ? 'text-red-800 bg-red-50 border-red-300'
    : 'text-amber-900 bg-amber-50 border-amber-300';
  return <div className={`text-sm rounded-lg border p-3 ${cls}`}>⚠️ {f.text}</div>;
}

function Stat({ label, value, sub, accent, onClick }) {
  return (
    <div className={`bg-white rounded-xl shadow p-4 ${onClick ? 'cursor-pointer active:bg-gray-50' : ''}`} onClick={onClick}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold ${accent}`}>{value ?? '—'}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}
function Card({ title, children }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2">{title}</div>
      {children}
    </div>
  );
}
function Banner({ children }) {
  return <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">{children}</div>;
}
