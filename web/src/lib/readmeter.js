// Firestore READ meter — diagnoses who's eating the shared 50k-reads/day free quota.
// Drop-in wrappers for getDoc / getDocs: they do the real read, then tally the doc count and
// (batched) write a running total into usage_reads/{YYYY-MM-DD} under this app's key. One write per
// flush window = negligible. To cover another app, import these wrappers there with its own APP key.
import { getDoc as _getDoc, getDocs as _getDocs, doc, setDoc, serverTimestamp, increment } from 'firebase/firestore';
import { isConfigured, db } from './firebase';

const APP = 'attendance-web';
const istDate = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

let pending = 0;
let timer = null;

function tally(n) {
  pending += n || 0;
  if (pending >= 100) { flush(); return; }          // flush early on a big burst
  if (!timer) timer = setTimeout(flush, 10000);      // otherwise batch every 10s
}

async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const n = pending; pending = 0;
  if (!n || !isConfigured || !db) return;
  try {
    await setDoc(doc(db, 'usage_reads', istDate()),
      { totals: { [APP]: increment(n) }, updatedAt: serverTimestamp() }, { merge: true });
  } catch { pending += n; }                           // keep the count if the write failed
}

// Mobile PWAs rarely fire beforeunload; visibilitychange→hidden is reliable when backgrounded.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

export async function getDoc(ref) { const s = await _getDoc(ref); tally(1); return s; }
export async function getDocs(q) { const s = await _getDocs(q); tally(s.size || 0); return s; }
