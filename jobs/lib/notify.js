// Telegram notifier. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env, falling back
// to the git-ignored telegram.local.json (for local dev). In production these come from
// GitHub Actions secrets. If still missing, runs in DRY mode and prints. Uses global fetch.
const fs = require('fs');
const path = require('path');
let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'telegram.local.json'), 'utf8')); } catch { /* none */ }
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || local.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || local.TELEGRAM_CHAT_ID;

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
async function enqueueWhatsApp(text) {
  try {
    const { db, FieldValue } = require('./firestore');
    await db().collection('wa_outbox').add({
      text,
      status: 'pending',
      channel: 'staff',
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    });
  } catch (e) {
    console.error('wa_outbox enqueue failed (non-fatal):', e.message);
  }
}

async function sendTelegram(text) {
  await enqueueWhatsApp(text); // also deliver on WhatsApp (best-effort, never throws)
  if (!TOKEN) { console.log('[DRY notify — no token] would send:\n' + text); return { dry: true }; }
  const rcpts = await recipients();
  if (!rcpts.length) { console.log('[DRY notify — no chat id] would send:\n' + text); return { dry: true }; }
  let last;
  for (const chat of rcpts) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    last = await res.json().catch(() => ({}));
    if (!res.ok || !last.ok) console.error('Telegram send to ' + chat + ' failed: ' + JSON.stringify(last));
  }
  return last;
}

async function sendTelegramDocument(filePath, caption = '') {
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

module.exports = { sendTelegram, sendTelegramDocument };
