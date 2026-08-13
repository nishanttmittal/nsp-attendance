// Quota-saver cache (owner 13-08-2026: "utilize the free limits first"). Heavy, slow-changing
// Firestore reads (all-workers attendance ~70 docs, all punches ~70 docs, roster) are kept in
// IndexedDB with a freshness window, so re-opening the Salary screen or a worker's page doesn't
// re-bill the whole factory's history on every tap. Attendance/punches only change when the portal
// sync jobs run, so a short window is safe. Money data (att_salary) is NEVER cached — always live.
// Failures fall through to a live read; the cache can only save reads, never break the app.
const DB_NAME = 'att-read-cache';
const STORE = 'kv';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Returns the cached value if it is younger than maxAgeMs, else undefined.
export async function cacheGet(key, maxAgeMs) {
  try {
    const d = await idb();
    const v = await new Promise((resolve, reject) => {
      const t = d.transaction(STORE).objectStore(STORE).get(key);
      t.onsuccess = () => resolve(t.result); t.onerror = () => reject(t.error);
    });
    d.close();
    if (v && typeof v.at === 'number' && Date.now() - v.at < maxAgeMs) return v.data;
  } catch { /* cache is best-effort */ }
  return undefined;
}

export async function cachePut(key, data) {
  try {
    const d = await idb();
    await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite').objectStore(STORE).put({ at: Date.now(), data }, key);
      t.onsuccess = () => resolve(); t.onerror = () => reject(t.error);
    });
    d.close();
  } catch { /* best-effort */ }
}

export async function cacheDrop(key) {
  try {
    const d = await idb();
    await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
      t.onsuccess = () => resolve(); t.onerror = () => reject(t.error);
    });
    d.close();
  } catch { /* best-effort */ }
}
