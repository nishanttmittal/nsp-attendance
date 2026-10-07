// Simple-report helpers (owner 07-10-2026: "very simple report on my WhatsApp"). No HTML, no codes.
const { db } = require('./firestore');
let nameCache = null;
async function nameMap() {
  if (nameCache) return nameCache;
  nameCache = {};
  const s = await db().collection('att_salary').get();
  s.forEach(d => { const e = d.data(); nameCache[d.id] = (e.name || '').trim() || d.id; });
  return nameCache;
}
async function nameOf(code) { const m = await nameMap(); return m[code] || code; }
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const num = n => (Number(n) || 0).toLocaleString('en-IN');
// "a, b, c +4" — never more than `max` names
function clip(arr, max = 5) { const a = arr.filter(Boolean); return a.length <= max ? a.join(', ') : a.slice(0, max).join(', ') + ` +${a.length - max}`; }
function plain(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function dmy(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]}`; }
module.exports = { nameOf, nameMap, inr, num, clip, plain, dmy };
