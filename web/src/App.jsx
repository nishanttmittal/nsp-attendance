import { useEffect, useState } from 'react';
import { useAuth, canSee, signOut } from './lib/auth';
import { loadEmployees } from './lib/data';
import Login from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import Salary, { ManagerAdvances } from './components/Salary.jsx';
import IncomingAdvances from './components/IncomingAdvances.jsx';
import Problems from './components/Problems.jsx';
import Settings from './components/Settings.jsx';
import Shadow from './components/Shadow.jsx';
import Welders from './components/Welders.jsx';
import Archive from './components/Archive.jsx';

// Daily tabs stay on the bar; occasional screens live under ⋯ More (owner 2026-08-11: "app is
// confusing" — six same-weight tabs, three of them advance-related). Keys are unchanged.
const TABS = [
  { key: 'floor', label: 'Floor', feature: 'dashboard', primary: true },
  { key: 'salary', label: 'Salary', feature: 'salary', primary: true },
  { key: 'problems', label: 'Problems', feature: 'problems', primary: true },
  { key: 'advances', label: 'Advances (manager)', feature: 'advances' },
  { key: 'incoming', label: 'Hisab advances — accept', feature: 'salary' },
  { key: 'shadow', label: 'Day check (shadow)', feature: 'shadow' },
  { key: 'welders', label: 'Welders (contractor-paid)', feature: 'salary' },
  { key: 'archive', label: 'Removed staff records', feature: 'archive' },
];

export default function App() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState('floor');
  const [badge, setBadge] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!user?.role) return;
    (async () => {
      try {
        // Problems badge now counts pending resign prompts (missed punches moved to the Shadow tab).
        if (user.role !== 'admin') { setBadge(0); return; }
        const emps = await loadEmployees(true);
        setBadge(emps.filter((e) => e.resignPrompt?.status === 'pending' && e.active !== false).length);
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

      {tab !== 'settings' && (() => {
        // ≤4 screens (e.g. a manager) → plain bar; more → 3 daily tabs + a ⋯ More menu
        const split = visible.length > 4;
        const bar = split ? visible.filter((t) => t.primary) : visible;
        const more = split ? visible.filter((t) => !t.primary) : [];
        const activeMore = more.find((t) => t.key === active);
        return (
          <nav className="bg-white border-b flex relative">
            {bar.map((t) => (
              <button key={t.key} onClick={() => { setTab(t.key); setMoreOpen(false); }}
                className={`flex-1 py-3 text-sm font-medium ${active === t.key ? 'text-red-700 border-b-2 border-red-700' : 'text-gray-500'}`}>
                {t.label}{t.key === 'problems' && badge > 0 ? <span className="ml-1 bg-red-600 text-white text-[10px] rounded-full px-1.5 py-0.5">{badge}</span> : null}
              </button>
            ))}
            {more.length > 0 && (
              <button onClick={() => setMoreOpen((o) => !o)}
                className={`flex-1 py-3 text-sm font-medium ${activeMore ? 'text-red-700 border-b-2 border-red-700' : 'text-gray-500'}`}>
                {activeMore ? activeMore.label.split(' ')[0] : '⋯ More'}
              </button>
            )}
            {moreOpen && more.length > 0 && (
              <div className="absolute right-2 top-full mt-1 bg-white border rounded-xl shadow-lg z-20 min-w-[220px] py-1">
                {more.map((t) => (
                  <button key={t.key} onClick={() => { setTab(t.key); setMoreOpen(false); }}
                    className={`block w-full text-left px-4 py-3 text-sm ${active === t.key ? 'text-red-700 font-semibold' : 'text-gray-700'} hover:bg-gray-50`}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </nav>
        );
      })()}

      <main className="flex-1 p-4 max-w-3xl w-full mx-auto">
        {tab === 'settings' && canSee(user.role, 'settings') ? (
          <div className="space-y-3">
            <button onClick={() => setTab('floor')} className="text-sm text-gray-600">← Back to app</button>
            <Settings />
          </div>
        ) : (
          <>
            {active === 'floor' && <Dashboard />}
            {active === 'advances' && canSee(user.role, 'advances') && <ManagerAdvances user={user} />}
            {active === 'salary' && canSee(user.role, 'salary') && <Salary user={user} />}
            {active === 'incoming' && canSee(user.role, 'salary') && <IncomingAdvances user={user} />}
            {active === 'welders' && canSee(user.role, 'salary') && <Welders />}
            {active === 'archive' && canSee(user.role, 'archive') && <Archive />}
            {active === 'problems' && canSee(user.role, 'problems') && <Problems user={user} />}
            {active === 'shadow' && canSee(user.role, 'shadow') && <Shadow />}
          </>
        )}
      </main>
    </div>
  );
}

function Center({ children }) {
  return <div className="min-h-full grid place-items-center text-gray-500">{children}</div>;
}
