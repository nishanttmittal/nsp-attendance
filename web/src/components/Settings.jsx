import { useEffect, useRef, useState } from 'react';
import { exportAllData, restoreAllData, listManagers, addManager, removeManager } from '../lib/data';

export default function Settings() {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  async function backup() {
    setBusy('backup'); setMsg(null);
    try {
      const data = await exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nsp-attendance-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      setMsg({ ok: true, t: 'Backup downloaded. Keep it somewhere safe (Drive/Desktop).' });
    } catch (e) { setMsg({ ok: false, t: 'Backup failed: ' + e.message }); }
    finally { setBusy(''); }
  }

  async function restore(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!confirm('Restore will overwrite current data with the backup file. Continue?')) { e.target.value = ''; return; }
    setBusy('restore'); setMsg(null);
    try {
      const obj = JSON.parse(await file.text());
      const r = await restoreAllData(obj);
      setMsg({ ok: true, t: r.mock ? 'Valid backup file (connect Firebase to actually restore).' : `Restored ${r.restored} records.` });
    } catch (e) { setMsg({ ok: false, t: 'Restore failed: ' + e.message }); }
    finally { setBusy(''); e.target.value = ''; }
  }

  return (
    <div className="space-y-4">
      <ManagersCard />
      <Card title="Backup &amp; Restore">
        <p className="text-sm text-gray-500 mb-3">Your salary, advances, increments, loans and fines. An automatic backup also runs on a schedule.</p>
        <button onClick={backup} disabled={busy === 'backup'}
          className="w-full bg-red-700 disabled:opacity-50 text-white rounded-lg py-3 font-medium mb-2">
          {busy === 'backup' ? 'Preparing…' : '⬇ Download backup'}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy === 'restore'}
          className="w-full border border-gray-300 text-gray-800 rounded-lg py-3 font-medium">
          {busy === 'restore' ? 'Restoring…' : '⬆ Restore from backup'}
        </button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={restore} />
        {msg && <p className={`text-sm mt-3 rounded p-2 border ${msg.ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{msg.t}</p>}
      </Card>

      <Card title="Data safety">
        <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
          <li>Data is stored in the cloud (Firebase) — synced and not on one phone.</li>
          <li>Scheduled auto-backup keeps an off-site copy.</li>
          <li>Use Download backup before big changes; Restore brings it all back.</li>
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

function Card({ title, children }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="font-semibold text-gray-800 mb-2" dangerouslySetInnerHTML={{ __html: title }} />
      {children}
    </div>
  );
}
