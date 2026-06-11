// Telegram notifier. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env, falling back
// to the git-ignored telegram.local.json (for local dev). In production these come from
// GitHub Actions secrets. If still missing, runs in DRY mode and prints. Uses global fetch.
const fs = require('fs');
const path = require('path');
let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'telegram.local.json'), 'utf8')); } catch { /* none */ }
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || local.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || local.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log('[DRY notify — no TELEGRAM_BOT_TOKEN/CHAT_ID set] would send:\n' + text);
    return { dry: true };
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error('Telegram send failed: ' + JSON.stringify(body));
  return body;
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
