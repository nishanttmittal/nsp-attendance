// TECH DIGEST — owner 07-10-2026: the technical / exception alerts (floor update didn't run, app gone
// quiet, price health, settings guard, backups, 4-late-marks, missed punch, long absence) are NOT sent
// one by one; they are collected by sendTech() and sent as ONE plain WhatsApp message at 11:00 and 18:00.
// DRY=1 prints and does not clear the queue.
const { db } = require('./lib/firestore');
const { sendTelegram } = require('./lib/notify');
const { dmy } = require('./lib/simple');
const MAX_ITEMS = 12;
function firstLine(t) { return String(t).split('\n').map(x => x.trim()).filter(Boolean)[0] || ''; }
const names = t => String(t).replace(/\s*\(\d{6,8}\)/g, '').replace(/^•\s*/, '').trim();   // drop "(00000350)" codes and bullets
// Plain-language rewrites (owner 07-10-2026). Anything unknown falls back to compact().
function simplify(t) {
  const lines = String(t).split('\n').map(x => x.trim()).filter(Boolean);
  const h = lines[0] || '';
  const bullets = lines.slice(1).filter(x => x.startsWith('•')).map(names);
  let m;
  if ((m = h.match(/The (.+?) \((\d{1,2}:\d{2})\) floor update didn't run/))) return `Biometric update ${m[2]} nahi chala — Claude dekh raha hai`;
  if (/App gone quiet/i.test(h)) return 'App band jaisi: ' + bullets.map(b => b.replace(/ — nothing recorded for (\d+) days.*/, ' ($1 din se koi entry nahi)')).join('; ');
  if ((m = h.match(/^⏰ (.+?) has crossed (\d+) late marks/))) return `Late: ${m[1]} — ${m[2]} baar is mahine`;
  if (/Missed punch —/.test(h)) return 'Missed punch kal: ' + (bullets.length ? bullets.map(b => b.replace(/\s*\([A-Z ]+\)$/, '')).join(', ') : 'koi nahi');
  if (/Long absence/.test(h)) return 'Lambi chhutti: ' + bullets.map(b => b.replace(/:\s*(\d+) days.*/, ' $1 din')).join(', ');
  if (/Price health/.test(h)) return 'Price feed: ' + (lines.slice(1).find(x => /missing|broke|stale|⚠/i.test(x)) || 'theek').replace(/^⚠️\s*/, '').replace(/ — source may have broken\.?/, '');
  if (/Settings guard/i.test(h)) return 'Biometric portal settings check: ' + (lines[1] || 'problem — Claude dekh raha hai').slice(0, 120);
  if (/Archive\/delete|backup/i.test(h)) return h.replace(/<[^>]+>/g, '').slice(0, 140);
  if (/morning digest held/i.test(h)) return 'Subah ka attendance abhi portal par update nahi hua tha';
  return compact(t);
}
function compact(t) {
  const lines = String(t).split('\n').map(x => x.trim()).filter(Boolean).filter(x => !/^(fix|pm2|ssh|cd |review in the app|workers may be|tell claude)/i.test(x));
  return [lines[0], ...lines.slice(1, 3).map(names)].filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 200);
}
(async () => {
  const ref = db().collection('att_alert_state').doc('tech_digest');
  const items = ((await ref.get()).data() || {}).items || [];
  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const slot = nowIST.getUTCHours() < 14 ? 'subah' : 'shaam';
  if (!items.length) { console.log('tech digest: nothing queued'); if (!process.env.DRY) await ref.set({ items: [], lastSent: new Date().toISOString() }, { merge: true }); return; }
  // dedupe identical first lines (the same watchdog can fire several times)
  const seen = new Set(); const uniq = [];
  for (const it of items) { const k = simplify(it.text); if (seen.has(k)) continue; seen.add(k); uniq.push(it); }
  const L = [`🔔 System update (${slot}) — ${dmy(nowIST.toISOString())}`];
  for (const it of uniq.slice(0, MAX_ITEMS)) L.push('• ' + simplify(it.text));
  if (uniq.length > MAX_ITEMS) L.push(`• …aur ${uniq.length - MAX_ITEMS} items (Telegram mein poora)`);
  const msg = L.join('\n');
  if (process.env.DRY) { console.log(msg); return; }
  await sendTelegram(msg);
  await ref.set({ items: [], lastSent: new Date().toISOString(), lastCount: items.length }, { merge: true });
  console.log(`tech digest sent (${items.length} items, ${uniq.length} unique)`);
})().catch(e => { console.error(e); process.exit(1); });
