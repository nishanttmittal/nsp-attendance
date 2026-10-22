// ONCE A DAY guard for owner messages (owner 23-10-2026: "i am getting food alerts and present alert twice").
// The scheduler sends at the right time; GitHub's fallback cron for the same job fires hours late (17:40 food → ~22:30,
// 12:30 morning → ~18:00) and sent a second copy. Each job now records the IST day it was sent and skips any later run.
// FORCE=1 re-sends on purpose (manual run). Checked BEFORE the portal login, so a skipped run costs no login.
const { db } = require('./firestore');
const REF = () => db().collection('att_alert_state').doc('sent_once');
const istDay = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
async function alreadySent(key) {
  if (process.env.FORCE === '1' || process.env.DRY) return false;
  return (((await REF().get()).data()) || {})[key] === istDay();
}
async function markSent(key) { if (!process.env.DRY) await REF().set({ [key]: istDay(), [key + 'At']: new Date().toISOString() }, { merge: true }); }
module.exports = { alreadySent, markSent };
