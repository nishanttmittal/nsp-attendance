import { useId } from 'react';

// Type-or-pick employee field: type a few letters, browser suggests from the roster.
// onPick(code|null, typedText) — code resolves when the text matches exactly one person.
export default function NamePick({ roster, value, onChange, placeholder = 'Type a name…', className = '' }) {
  const listId = useId();
  function resolve(text) {
    const t = text.trim().toLowerCase();
    if (!t) return onChange(null, text);
    const exact = roster.find((r) => (r.name || '').toLowerCase() === t);
    if (exact) return onChange(exact.code, text);
    const matches = roster.filter((r) => (r.name || '').toLowerCase().includes(t));
    onChange(matches.length === 1 ? matches[0].code : null, text);
  }
  return (
    <>
      <input className={`border rounded px-2 py-2 text-sm ${className}`} list={listId} placeholder={placeholder}
        value={value} onChange={(e) => resolve(e.target.value)} />
      <datalist id={listId}>
        {roster.map((r) => <option key={r.code} value={r.name} />)}
      </datalist>
    </>
  );
}
