import { useEffect, useState } from 'react';
import { useAuth, canSee, signOut } from './lib/auth';
import { loadMissedDoc, loadEmployees } from './lib/data';
import Login from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import Salary from './components/Salary.jsx';
import Problems from './components/Problems.jsx';
import Settings from './components/Settings.jsx';
import Archive from './components/Archive.jsx';

const TABS = [
  { key: 'floor', label: 'Floor', feature: 'dashboard' },
  { key: 'salary', label: 'Salary', feature: 'salary' },
  { key: 'problems', label: 'Problems', feature: 'problems' },
  { key: 'archive', label: '🗄️', feature: 'archive' },
];

export default function App() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState('floor');
  const [badge, setBadge] = useState(0);

  useEffect(() => {
    if (!user?.role) return;
    (async () => {
      try {
        const md = await loadMissedDoc();
        let n = (md.entries || []).length;
        if (user.role === 'admin') {
          try {
            const emps = await loadEmployees(true);
            const mk = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
            const left = new Set(emps.flatMap((e) => ((e.missedLeave || {})[mk] || []).map((d) => e.code + '|' + d)));
            n = (md.entries || []).filter((m) => !left.has(m.code + '|' + m.date)).length
              + emps.filter((e) => e.resignPrompt?.status === 'pending' && e.active !== false).length;
          } catch { /* ignore */ }
        }
        setBadge(n);
      } catch { /* ignore */ }
    })();
  }, [user]);

  if (loading) return <Center>Loading…</Center>;
  if (!user) return <Login />;
  if (!user.role) return (
    <Center>
      <div className="text-center p-6">
        <p className="text-gray-700 font-medium">No access yet</p>
        <p className="text-sm text-gray-500 mt-1">{user.email}<br />Ask the admin to add you in Settings → Managers.</p>
        <button onClick={signOut} className="mt-4 text-sm bg-gray-200 px-3 py-1.5 rounded">Sign out</button>
      </div>
    </Center>
  );

  const visible = TABS.filter((t) => canSee(user.role, t.feature));
  const active = visible.find((t) => t.key === tab) ? tab : visible[0]?.key;

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-red-700 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-bold leading-tight">NSP Attendance</div>
          <div className="text-xs text-red-200">{user.email} · {user.role}{user.mock ? ' (preview)' : ''}</div>
        </div>
        <div className="flex items-center gap-2">
          {canSee(user.role, 'settings') && (
            <button onClick={() => setTab(tab === 'settings' ? 'floor' : 'settings')} title="Settings"
              className={`text-lg px-2 py-1 rounded ${tab === 'settings' ? 'bg-red-900' : 'bg-red-800 hover:bg-red-900'}`}>⚙</button>
          )}
          <button onClick={signOut} className="text-sm bg-red-800 hover:bg-red-900 px-3 py-1 rounded">Sign out</button>
        </div>
      </header>

      {tab !== 'settings' && (
        <nav className="bg-white border-b flex">
          {visible.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex-1 py-3 text-sm font-medium ${active === t.key ? 'text-red-700 border-b-2 border-red-700' : 'text-gray-500'}`}>
              {t.label}{t.key === 'problems' && badge > 0 ? <span className="ml-1 bg-red-600 text-white text-[10px] rounded-full px-1.5 py-0.5">{badge}</span> : null}
            </button>
          ))}
        </nav>
      )}

      <main className="flex-1 p-4 max-w-3xl w-full mx-auto">
        {tab === 'settings' && canSee(user.role, 'settings') ? (
          <div className="space-y-3">
            <button onClick={() => setTab('floor')} className="text-sm text-gray-600">← Back to app</button>
            <Settings />
          </div>
        ) : (
          <>
            {active === 'floor' && <Dashboard />}
            {active === 'salary' && canSee(user.role, 'salary') && <Salary user={user} />}
            {active === 'problems' && canSee(user.role, 'problems') && <Problems user={user} />}
            {active === 'archive' && canSee(user.role, 'archive') && <Archive />}
          </>
        )}
      </main>
    </div>
  );
}

function Center({ children }) {
  return <div className="min-h-full grid place-items-center text-gray-500">{children}</div>;
}
