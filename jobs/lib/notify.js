// Telegram notifier. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env, falling back
// to the git-ignored telegram.local.json (for local dev). In production these come from
// GitHub Actions secrets. If still missing, runs in DRY mode and prints. Uses global fetch.
const fs = require('fs');
const path = require('path');
let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'telegram.local.json'), 'utf8')); } catch { /* none */ }
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || local.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || local.TELEGRAM_CHAT_ID;

// Separate bots per topic (owner 11-10-2026: "seperate bot for attendance, advance and order and other
// factory notifications"). A topic with no token of its own falls back to TOKEN (the NSP OPS bot), so
// nothing is lost while a bot is not set up yet. Same chat ids for every bot — each person presses Start once per bot.
const TOPIC_TOKENS = {};
for (const t of ['ATTENDANCE', 'ADVANCE', 'ORDERS', 'TECH', 'LEADS', 'QUALITY']) {
  const v = process.env['TELEGRAM_BOT_TOKEN_' + t] || local['TELEGRAM_BOT_TOKEN_' + t];
  if (v) TOPIC_TOKENS[t.toLowerCase()] = v;
}
const tokenFor = topic => (topic && TOPIC_TOKENS[topic]) || TOKEN;

// "Open app" button under an alert (Telegram only; the WhatsApp copy is plain text and unchanged).
const APP = 'https://unico-operations.firebaseapp.com';
const TOPIC_BUTTON = {
  attendance: { text: 'Open Attendance app', url: APP + '/attendance/' },
  advance: { text: 'Open Salary / Advance', url: APP + '/attendance/' },
  orders: { text: 'Open Orders app', url: APP + '/orders/' },
};
const buttonFor = topic => (topic && TOPIC_BUTTON[topic] ? { reply_markup: { inline_keyboard: [[TOPIC_BUTTON[topic]]] } } : {});

// recipients = owner (env CHAT_ID) + any managers with a telegramChatId in att_users
async function recipients() {
  const set = new Set();
  if (CHAT_ID) set.add(String(CHAT_ID));
  try {
    const { db } = require('./firestore');
    const snap = await db().collection('att_users').get();
    snap.docs.forEach(d => { const t = d.data().telegramChatId; if (t) set.add(String(t)); });
  } catch { /* no firestore / not configured */ }
  return [...set];
}

// Mirror every alert into the WhatsApp outbox (`wa_outbox`) so the WhatsApp
// bridge — the only process logged into WhatsApp — can also deliver it to the
// owner's phone. Best-effort and awaited (so the write flushes before a short-
// lived GitHub Actions run exits); a Firestore error here must NEVER block the
// Telegram alert, which is the reliable channel.
async function enqueueWhatsApp(text, { plain = false } = {}) {
  try {
    const { db, FieldValue } = require('./firestore');
    // WhatsApp has no HTML: strip the Telegram <b>…</b> tags so names don't show as "<b>name</b>" (07-10-2026)
    await db().collection('wa_outbox').add({
      // HTML alerts: drop <b>/<i> and turn entities back into characters. PLAIN text (sendPlain) is not HTML-encoded,
      // so it only loses stray <b>/<i> as before and is otherwise stored exactly as written.
      text: plain ? String(text).replace(/<\/?(b|i)>/g, '') : String(text).replace(/<\/?(b|i)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      status: 'pending',
      channel: 'staff',
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    });
    return true;
  } catch (e) {
    console.error('wa_outbox enqueue failed (non-fatal):', e.message);
    return false;
  }
}

// Technical/ops alerts (owner 07-10-2026: "very simple reports on my WhatsApp") — Telegram ONLY,
// never mirrored to the owner's WhatsApp. Use for watchdogs, portal/sync failures, backups, price feeds.
// One Telegram send. Never throws; a refusal (bot not started, token revoked, bad markup) or a network
// failure is LOGGED with the bot id and returns false — before 12-10-2026 sendTech/sendPlain ignored the answer.
async function post(token, body, label) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) return true;
    console.error(`${label} telegram REFUSED (bot ${String(token).split(':')[0]}, chat ${body.chat_id}): ${j.description || res.status}`);
  } catch (e) { console.error(`${label} telegram failed (bot ${String(token).split(':')[0]}): ${e.message}`); }
  return false;
}

async function sendTech(text, topic) {
  topic = topic || 'tech';   // technical alerts → the Tech bot unless a topic claims them
  const TOKEN = tokenFor(topic);
  // owner 07-10-2026: "i should receive it one at 11 am and other at 6pm" — every tech alert is also
  // queued into att_alert_state/tech_digest; techDigest.js sends ONE plain WhatsApp message at 11:00 and 18:00.
  try {
    const { db, FieldValue } = require('./firestore');
    const plain = String(text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    await db().collection('att_alert_state').doc('tech_digest').set(
      { items: FieldValue.arrayUnion({ at: new Date().toISOString(), text: plain.slice(0, 600) }) }, { merge: true });
  } catch (e) { console.error('tech digest queue failed (non-fatal):', e.message); }
  if (!TOKEN) { console.log('[DRY tech — no token] would send:\n' + text); return { dry: true }; }
  const ids = await recipients();
  let sent = 0;
  for (const chat_id of ids) {
    if (await post(TOKEN, { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...buttonFor(topic) }, 'tech')) sent++;
  }
  return { ok: sent > 0, sent };
}

// PLAIN messages (digests, one-liners): WhatsApp gets the text exactly as written; the Telegram copy is
// HTML-escaped first, so a "<" or "&" inside a product/worker name can never be parsed as markup
// (push security review 07-10-2026: entities were decoded in sendTech and then reached the HTML sink).
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// QUIET sends (owner 13-10-2026: "Per-worker detail and all system messages go only to Telegram"): pass
// { wa: false } and the message goes to Telegram ONLY. If Telegram does not take it (no token, refused,
// network), it falls back to WhatsApp so a quiet message is never lost.
async function sendPlain(text, topic, { wa: toWa = true } = {}) {
  const TOKEN = tokenFor(topic);
  let wa = toWa ? await enqueueWhatsApp(text, { plain: true }) : undefined;   // callers that must not lose the message check this
  if (!TOKEN) { if (!toWa) wa = await enqueueWhatsApp(text, { plain: true }); console.log('[DRY plain — no token] would send:\n' + text); return { dry: true, wa }; }
  const ids = await recipients();
  let sent = 0;
  for (const chat_id of ids) {
    if (await post(TOKEN, { chat_id, text: escapeHtml(text), parse_mode: 'HTML', disable_web_page_preview: true, ...buttonFor(topic) }, 'plain')) sent++;
  }
  if (!toWa && sent === 0) wa = await enqueueWhatsApp(text, { plain: true });
  if (!toWa && sent === 0 && !wa) console.error('ALERT NOT DELIVERED on Telegram or WhatsApp: ' + String(text).slice(0, 200));
  return { ok: sent > 0, sent, wa };
}

async function sendTelegram(text, topic, { wa: toWa = true } = {}) {
  const TOKEN = tokenFor(topic);
  if (toWa) await enqueueWhatsApp(text); // also deliver on WhatsApp (best-effort, never throws)
  if (!TOKEN) { if (!toWa) await enqueueWhatsApp(text); console.log('[DRY notify — no token] would send:\n' + text); return { dry: true }; }
  const rcpts = await recipients();
  if (!rcpts.length) { if (!toWa) await enqueueWhatsApp(text); console.log('[DRY notify — no chat id] would send:\n' + text); return { dry: true }; }
  // Never throws and never hangs (20 s limit): a Telegram outage must not mark a job failed AFTER its
  // pay / advance / attendance write already succeeded — that led to retries that repeated or dropped the alert.
  let sent = 0;
  for (const chat_id of rcpts) {
    if (await post(TOKEN, { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...buttonFor(topic) }, 'notify')) sent++;
  }
  let wa;
  if (!toWa && sent === 0) {   // quiet message Telegram did not take → WhatsApp
    wa = await enqueueWhatsApp(text);
    if (!wa) console.error('ALERT NOT DELIVERED on Telegram or WhatsApp: ' + String(text).slice(0, 200));
  }
  return { ok: sent > 0, sent, wa };
}

async function sendTelegramDocument(filePath, caption = '', topic) {
  const TOKEN = tokenFor(topic);
  if (!TOKEN || !CHAT_ID) { console.log('[DRY notify] would send document:', filePath); return { dry: true }; }
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([buf]), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error('Telegram doc failed: ' + JSON.stringify(body));
  return body;
}

// channel('attendance') → the same four senders, bound to that topic's bot.
const channel = topic => ({
  sendTelegram: text => sendTelegram(text, topic),
  sendPlain: text => sendPlain(text, topic),
  sendQuiet: text => sendTelegram(text, topic, { wa: false }),        // Telegram only (WhatsApp only if Telegram fails)
  sendPlainQuiet: text => sendPlain(text, topic, { wa: false }),
  sendTech: text => sendTech(text, topic),
  sendTelegramDocument: (filePath, caption = '') => sendTelegramDocument(filePath, caption, topic),
});

module.exports = { sendTelegram, sendTelegramDocument, sendTech, sendPlain, channel, escapeHtml };
