import { useEffect, useState } from 'react';
import { listManagers, addManager, removeManager, setActionPassword, checkActionPassword } from '../lib/data';

// The old in-app "Download backup / Restore" buttons were REMOVED 2026-07-17: the export
// covered collections that no longer exist and missed attendance/punch data — a false sense
// of backup — and Restore could overwrite live payroll. Real backups now run automatically
// every night (02:45) to a private off-site vault; restoring from them is done with Claude.
export default function Settings() {
  return (
    <div className="space-y-4">
      <ManagersCard />
      <PasswordCard />
      <Card title="Data safety &amp; backups">
        <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
          <li>Data lives in the cloud (Firebase) — synced, not on one phone.</li>
          <li><b>Automatic backup every night (02:45)</b> to a private off-site vault — salary, advances, attendance, punches, everything. Last 60 nights kept, full history preserved.</li>
          <li>To restore anything, ask Claude with the worker/date — nothing is ever lost.</li>
        </ul>
      </Card>
    </div>
  );
}

function ManagersCard() {
  const [list, setList] = useState([]);
  const [f, setF] = useState({ email: '', chat: '' });
  const refresh = () => listManagers().then(setList);
  useEffect(() => { refresh(); }, []);
  async function add() {
    if (!f.email.trim()) return;
    await addManager(f.email.trim(), f.chat.trim());
    setF({ email: '', chat: '' }); refresh();
  }
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-1">Managers &amp; access</div>
      <p className="text-xs text-gray-500 mb-3">Managers get Telegram alerts and can see Floor / Punch / Staff and record advances — not salary. Add by Google email; chat-id is optional (for alerts).</p>
      <ul className="text-sm divide-y divide-gray-100 mb-2">
        {list.length === 0 && <li className="text-gray-400 py-1">No managers added.</li>}
        {list.map((m) => (
          <li key={m.email} className="py-1.5 flex items-center justify-between">
            <span>{m.email} <span className="text-gray-400">· {m.role}{m.telegramChatId ? ' · TG' : ''}</span></span>
            <button onClick={async () => { if (confirm(`Remove ${m.email}?`)) { await removeManager(m.email); refresh(); } }} className="text-xs text-red-700 border border-red-200 rounded px-2 py-1">Remove</button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-1 gap-2">
        <input className="border rounded px-3 py-2 text-sm" placeholder="manager@gmail.com" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />
        <input className="border rounded px-3 py-2 text-sm" placeholder="Telegram chat id (optional)" value={f.chat} onChange={e => setF({ ...f, chat: e.target.value })} />
        <button onClick={add} className="bg-gray-800 text-white rounded py-2 text-sm font-medium">Add manager</button>
      </div>
    </div>
  );
}

// password that guards dangerous actions (resign/remove, unlocking paid months)
function PasswordCard() {
  const [f, setF] = useState({ old: '', pw: '', pw2: '' });
  const [msg, setMsg] = useState(null);
  async function save() {
    if (!f.pw || f.pw.length < 4) return setMsg({ ok: false, t: 'Password must be at least 4 characters.' });
    if (f.pw !== f.pw2) return setMsg({ ok: false, t: 'The two passwords don’t match.' });
    const cur = await checkActionPassword(f.old);
    if (cur !== 'unset' && cur !== true) return setMsg({ ok: false, t: 'Current password is wrong.' });
    await setActionPassword(f.pw);
    setF({ old: '', pw: '', pw2: '' });
    setMsg({ ok: true, t: '✓ Action password saved.' });
  }
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-1">Action password</div>
      <p className="text-xs text-gray-500 mb-2">Asked before removing/resigning a worker (and other dangerous actions).</p>
      <div className="grid grid-cols-1 gap-2">
        <input className="border rounded px-3 py-2 text-sm" type="password" placeholder="Current password (leave empty if none yet)" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} />
        <input className="border rounded px-3 py-2 text-sm" type="password" placeholder="New password" value={f.pw} onChange={(e) => setF({ ...f, pw: e.target.value })} />
        <input className="border rounded px-3 py-2 text-sm" type="password" placeholder="New password again" value={f.pw2} onChange={(e) => setF({ ...f, pw2: e.target.value })} />
        <button onClick={save} className="bg-gray-800 text-white rounded py-2 text-sm font-medium">Save password</button>
      </div>
      {msg && <p className={`text-sm mt-2 rounded p-2 border ${msg.ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{msg.t}</p>}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2" dangerouslySetInnerHTML={{ __html: title }} />
      {children}
    </div>
  );
}
