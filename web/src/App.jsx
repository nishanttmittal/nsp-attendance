import { useState } from 'react';
import { useAuth, canSee, signOut } from './lib/auth';
import Login from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import MonthlyDownload from './components/MonthlyDownload.jsx';
import ManualPunch from './components/ManualPunch.jsx';
import Salary from './components/Salary.jsx';
import SelfPunchCard from './components/SelfPunchCard.jsx';
import Employees from './components/Employees.jsx';
import Advance from './components/Advance.jsx';
import Settings from './components/Settings.jsx';

const TABS = [
  { key: 'dashboard', label: 'Floor', feature: 'dashboard' },
  { key: 'salary', label: 'Salary', feature: 'salary' },
  { key: 'monthly', label: 'Monthly', feature: 'monthly' },
  { key: 'manual', label: 'Punch', feature: 'manual' },
  { key: 'advance', label: 'Advance', feature: 'advance' },
  { key: 'employees', label: 'Staff', feature: 'employees' },
  { key: 'settings', label: 'Settings', feature: 'settings' },
];

export default function App() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState('dashboard');

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
        <button onClick={signOut} className="text-sm bg-red-800 hover:bg-red-900 px-3 py-1 rounded">Sign out</button>
      </header>

      <nav className="bg-white border-b flex">
        {visible.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-3 text-sm font-medium ${active === t.key ? 'text-red-700 border-b-2 border-red-700' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 p-4 max-w-3xl w-full mx-auto">
        {active === 'dashboard' && <Dashboard />}
        {active === 'monthly' && <MonthlyDownload user={user} />}
        {active === 'manual' && canSee(user.role, 'manual') && <ManualPunch user={user} />}
        {active === 'salary' && canSee(user.role, 'salary') && <><SelfPunchCard /><Salary user={user} /></>}
        {active === 'employees' && canSee(user.role, 'employees') && <Employees user={user} />}
        {active === 'advance' && canSee(user.role, 'advance') && <Advance user={user} />}
        {active === 'settings' && canSee(user.role, 'settings') && <Settings />}
      </main>
    </div>
  );
}

function Center({ children }) {
  return <div className="min-h-full grid place-items-center text-gray-500">{children}</div>;
}
