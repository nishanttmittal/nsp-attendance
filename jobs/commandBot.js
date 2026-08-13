// Two-way NSP Ops command bot. Long-polls Telegram getUpdates for ~RUN_SECONDS, answers
// commands, and exits (a frequent GitHub Actions cron keeps it alive during work hours; the
// read-position/offset is persisted in att_meta/bot_state so nothing is missed between runs).
//
// SECURITY: only the owner + managers (by Telegram chat-id) get answers. Salary commands
// (payslip) are OWNER-ONLY. Everything is read-only except `advance`, which appends to the
// employee's advances array with the admin SDK (same write the app/worker already does).
const fs = require('fs');
const path = require('path');
const { db, FieldValue } = require('./lib/firestore');
const { buildProduction, buildProductionWeek } = require('./welderProduction');
const { buildPayReady } = require('./welderContractorPay');
const { buildPlating, buildPlatingWeek } = require('./platingSummary');
const { buildPayslipText } = require('./lib/payslipText');
const { istToday, prettyDate } = require('./lib/opsdate');

let local = {};
try { local = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'telegram.local.json'), 'utf8')); } catch { /* none */ }
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || local.TELEGRAM_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_CHAT_ID || local.TELEGRAM_CHAT_ID || '');
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 270);
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}
const reply = (chat, text) => tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });

// chatId -> 'owner' | 'manager'
async function authMap() {
  const m = {};
  if (OWNER) m[OWNER] = 'owner';
  try {
    const snap = await db().collection('att_users').get();
    snap.forEach(d => {
      const u = d.data(); const c = u.telegramChatId && String(u.telegramChatId);
      if (c) m[c] = u.role === 'admin' ? 'owner' : 'manager';
    });
  } catch { /* none */ }
  return m;
}

// name/code -> [{code,name}] from the salary master
let _emps;
async function employees() {
  if (_emps) return _emps;
  const snap = await db().collection('att_salary').get();
  _emps = snap.docs.map(d => ({ code: d.id, ...d.data() })).filter(e => e.active !== false);
  return _emps;
}
async function matchEmp(q) {
  const list = await employees();
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const exact = list.filter(e => (e.name || '').toLowerCase() === s || e.code.toLowerCase() === s);
  if (exact.length) return exact;
  const starts = list.filter(e => (e.name || '').toLowerCase().startsWith(s));
  if (starts.length) return starts;
  return list.filter(e => (e.name || '').toLowerCase().includes(s) || e.code.toLowerCase().includes(s));
}

const HELP = [
  '🤖 <b>NSP Ops commands</b>',
  '<b>present</b> / <b>absent</b> / <b>late</b> — today\'s lists',
  '<b>food</b> — dinner headcount',
  '<b>floor</b> — quick summary (counts + per-dept)',
  '<b>production</b> [dd/mm | week] — welder output',
  '<b>plating</b> [dd/mm | week] — plating in/out',
  '<b>pay</b> — welder pay-ready (last 7 days) 🔒',
  '<b>payslip</b> &lt;name&gt; — month-to-date net 🔒',
  '<b>advance</b> &lt;name&gt; &lt;amount&gt; [cash|bank] — record advance',
  '<b>report</b> [may|june|…] [performance|summary|inout] — file to Telegram 🔒',
  '🔒 = owner only',
].join('\n');

async function floorDoc() {
  const d = await db().collection('att_daily_stats').doc('today').get();
  return d.exists ? d.data() : null;
}
function freshness(s) {
  if (!s || !s.publishedAt) return '';
  const mins = Math.round((Date.now() - new Date(s.publishedAt).getTime()) / 60000);
  return mins <= 0 ? ' (just now)' : ` (${mins} min ago)`;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseDate(arg) {
  if (!arg) return istToday();
  const m = arg.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return istToday();
  const yr = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(new Date().getFullYear());
  return `${yr}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

async function handle(msg, role) {
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();
  const [cmdRaw, ...rest] = text.replace(/^\//, '').split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ');
  const ownerOnly = () => reply(chat, '🔒 That command is owner-only.');

  switch (cmd) {
    case 'start': case 'help': case 'commands':
      return reply(chat, HELP);

    case 'floor': case 'status': {
      const s = await floorDoc();
      if (!s) return reply(chat, 'No floor data yet today.');
      const c = s.counts || {};
      const depts = Object.entries(s.deptRatio || {}).map(([d, v]) => `${esc(d)} ${v.present}/${v.total}`).join(' · ');
      return reply(chat, `🏭 <b>Floor${freshness(s)}</b>\nPresent <b>${c.totalPresent}</b> / ${c.totalEmployees} · Absent ${c.totalAbsent} · Late ${c.totalLate}\nDinner headcount: <b>${s.mealHeadcount}</b>\n${depts}`);
    }
    case 'present': {
      const s = await floorDoc();
      if (!s) return reply(chat, 'No floor data yet today.');
      const names = (s.presentRows || []).map(r => `${esc(r.name)} <i>${r.inT || ''}</i>`).join('\n');
      return reply(chat, `✅ <b>Present ${s.counts?.totalPresent || (s.presentRows || []).length}${freshness(s)}</b>\n${names || '—'}`);
    }
    case 'absent': {
      const s = await floorDoc();
      if (!s) return reply(chat, 'No floor data yet today.');
      const names = (s.absent || []).map(r => `${esc(r.name)} <i>${esc(r.dept || '')}</i>`).join('\n');
      return reply(chat, `🔴 <b>Absent ${s.absentCount}${freshness(s)}</b>\n${names || '—'}`);
    }
    case 'late': {
      const s = await floorDoc();
      if (!s) return reply(chat, 'No floor data yet today.');
      const names = (s.late || []).map(r => `${esc(r.name)} <i>${r.inT || ''}</i>`).join('\n');
      return reply(chat, `⏰ <b>Late ${s.lateCount}${freshness(s)}</b>\n${names || '—'}`);
    }
    case 'food': case 'dinner': case 'headcount': {
      const s = await floorDoc();
      if (!s) return reply(chat, 'No floor data yet today.');
      return reply(chat, `🍽️ <b>Dinner headcount: ${s.mealHeadcount}</b>${freshness(s)}\n<i>still in past 17:30, excluding welders</i>`);
    }

    case 'production': case 'prod':
      return reply(chat, /^week$/i.test(arg) ? await buildProductionWeek() : await buildProduction(parseDate(arg)));
    case 'plating':
      return reply(chat, /^week$/i.test(arg) ? await buildPlatingWeek() : await buildPlating(parseDate(arg)));
    case 'pay': case 'payready':
      if (role !== 'owner') return ownerOnly();
      return reply(chat, await buildPayReady());

    case 'payslip': case 'salary': {
      if (role !== 'owner') return ownerOnly();
      if (!arg) return reply(chat, 'Usage: payslip &lt;name&gt;');
      const m = await matchEmp(arg);
      if (!m.length) return reply(chat, `No employee matched “${esc(arg)}”.`);
      if (m.length > 1) return reply(chat, `Which one?\n${m.slice(0, 8).map(e => '• ' + esc(e.name) + ' (' + e.code + ')').join('\n')}`);
      return reply(chat, await buildPayslipText(m[0].code));
    }

    case 'report': {
      if (role !== 'owner') return ownerOnly();
      // "report may performance" → queue a monthly_download job; the worker sends the file here.
      const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const words = arg.toLowerCase().split(/\s+/).filter(Boolean);
      const now = new Date(Date.now() + 5.5 * 3600 * 1000);
      let offset = 0;
      const mi = words.findIndex(w => MONTH_NAMES.some(m => m.startsWith(w) && w.length >= 3));
      if (mi >= 0) {
        const target = MONTH_NAMES.findIndex(m => m.startsWith(words[mi]));
        offset = (now.getUTCMonth() - target + 12) % 12;
        words.splice(mi, 1);
      }
      const kind = words[0] || 'performance';
      const report = /sum/.test(kind) ? 'Button10' : /in.?out|punch/.test(kind) ? 'Button15' : /ot/.test(kind) ? 'Button8' : /late/.test(kind) ? 'Button13' : 'perfbtn';
      await db().collection('att_job_requests').add({
        type: 'monthly_download', payload: { month: offset, scope: 'all', value: '', report },
        requestedBy: 'bot/owner', status: 'pending', createdAt: new Date().toISOString(),
      });
      return reply(chat, `📄 Generating the report — it lands here in a few minutes.`);
    }

    case 'advance': {
      const amt = Number(rest[rest.length - 1] && rest[rest.length - 1].replace(/[,₹]/g, ''));
      // mode optionally last token if it's cash/bank
      let tokens = [...rest]; let mode = 'cash';
      if (/^(cash|bank|account)$/i.test(tokens[tokens.length - 1] || '')) { mode = tokens.pop().toLowerCase(); }
      const amount = Number((tokens.pop() || '').replace(/[,₹]/g, ''));
      const name = tokens.join(' ');
      if (!name || !amount) return reply(chat, 'Usage: advance &lt;name&gt; &lt;amount&gt; [cash|bank]');
      const m = await matchEmp(name);
      if (!m.length) return reply(chat, `No employee matched “${esc(name)}”.`);
      if (m.length > 1) return reply(chat, `Which one?\n${m.slice(0, 8).map(e => '• ' + esc(e.name) + ' (' + e.code + ')').join('\n')}`);
      const emp = m[0];
      const advance = { amount, mode: mode === 'account' ? 'bank' : mode, date: istToday(), paidBy: role === 'owner' ? 'owner (bot)' : 'manager (bot)' };
      const ref = db().collection('att_salary').doc(emp.code);
      const snap = await ref.get();
      // OWNER RULE (13-08-2026): unlocked previous month claims a new advance (mirrors data.js attributeAdvanceMk)
      {
        const ed = snap.exists ? snap.data() : {};
        const dm = advance.date.slice(0, 7);
        const [ay, am] = dm.split('-').map(Number);
        const prevMk = am === 1 ? (ay - 1) + '-12' : ay + '-' + String(am - 1).padStart(2, '0');
        const joined = String(ed.joinDate || '').slice(0, 7);
        const prevMd = (ed.months || {})[prevMk] || {};
        advance.mk = (joined && joined > prevMk) || prevMd.locked || prevMd.payment ? dm : prevMk;
      }
      const advances = (snap.exists && snap.data().advances) || [];
      advances.push(advance);
      await ref.set({ advances }, { merge: true });
      return reply(chat, `💸 Recorded: <b>₹${amount.toLocaleString('en-IN')}</b> advance to <b>${esc(emp.name)}</b> (${advance.mode}, ${prettyDate(advance.date)}).`);
    }

    default:
      return reply(chat, `Didn’t get “${esc(cmd)}”. Send <b>help</b> for the list.`);
  }
}

(async () => {
  if (!TOKEN) { console.log('no token — set TELEGRAM_BOT_TOKEN'); return; }
  const stateRef = db().collection('att_meta').doc('bot_state');
  const st = await stateRef.get();
  let offset = (st.exists && st.data().offset) || 0;
  const auth = await authMap();
  const startedSec = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + RUN_SECONDS * 1000;
  let handled = 0;

  while (Date.now() < deadline) {
    const remain = Math.max(1, Math.min(45, Math.floor((deadline - Date.now()) / 1000)));
    const r = await tg('getUpdates', { offset, timeout: remain, allowed_updates: ['message'] });
    if (!r.ok) { console.log('getUpdates err', JSON.stringify(r).slice(0, 200)); break; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.text || !msg.chat) continue;
      if (msg.date && msg.date < startedSec - 600) continue; // ignore stale (>10 min) on cold start
      const role = auth[String(msg.chat.id)];
      if (!role) { console.log('ignored unauthorized chat', msg.chat.id); continue; }
      try { await handle(msg, role); handled++; }
      catch (e) { console.error('handle err', e.message); await reply(msg.chat.id, '⚠️ Something went wrong with that command.').catch(() => {}); }
    }
    if (r.result.length) await stateRef.set({ offset, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await stateRef.set({ offset, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`bot run done — handled ${handled} command(s), offset ${offset}`);
})().catch(e => { console.error(e); process.exit(1); });
