import { useState } from 'react';

// Type-or-TAP employee picker. Replaces the native <datalist> version: iOS Safari never
// shows datalist suggestions inside an installed (home-screen) PWA, so on the owner's
// iPhone the old field looked dead. This renders its own tappable list instead.
// Same API: onChange(code|null, typedText) — code resolves when exactly one person matches.
export default function NamePick({ roster, value, onChange, placeholder = 'Type a name…', className = '' }) {
  const [open, setOpen] = useState(false);
  const t = (value || '').trim().toLowerCase();
  const matches = roster.filter((r) => !t || (r.name || '').toLowerCase().includes(t));
  const picked = !!value && roster.some((r) => (r.name || '').toLowerCase() === t);
  return (
    <div className={`relative ${className}`}>
      <input
        className={`w-full border-2 rounded-xl px-3 py-2.5 text-sm bg-white ${picked ? 'border-emerald-500' : 'border-slate-200'}`}
        placeholder={placeholder} value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setOpen(true);
          const text = e.target.value; const tt = text.trim().toLowerCase();
          const exact = roster.find((r) => (r.name || '').toLowerCase() === tt);
          const ms = tt ? roster.filter((r) => (r.name || '').toLowerCase().includes(tt)) : [];
          onChange(exact ? exact.code : ms.length === 1 ? ms[0].code : null, text);
        }} />
      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border-2 border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
          {matches.slice(0, 12).map((r) => (
            <button key={r.code} type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(r.code, r.name); setOpen(false); }}
              className="w-full text-left px-3 py-2.5 text-sm border-b border-slate-100 last:border-0 active:bg-emerald-50">
              <span className="font-medium text-slate-800">{r.name}</span>{r.dept ? <span className="text-slate-400 text-xs"> · {r.dept}</span> : null}
            </button>
          ))}
          {matches.length > 12 && <div className="px-3 py-1.5 text-[11px] text-slate-400">…{matches.length - 12} more — type a few letters</div>}
        </div>
      )}
    </div>
  );
}
