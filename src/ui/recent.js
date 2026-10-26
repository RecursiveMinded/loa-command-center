// Records created or updated from LOAs during the current review session, so
// a bulk upload can be followed by one bulk edit (platform, tags, owner…).
const KEY = 'loa.recentFromLoas';
const MAX_AGE = 12 * 3600 * 1000;
const subs = new Set();

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Date.now() - v.at < MAX_AGE && Array.isArray(v.ids)) return v.ids;
  } catch (_) { /* storage unavailable */ }
  return [];
}

function write(ids) {
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ids })); } catch (_) { /* storage unavailable */ }
  for (const fn of subs) fn(ids);
}

export const recentIds = read;
export function addRecent(ids) { write([...new Set([...read(), ...(ids || []).filter(Boolean)])]); }
export function clearRecent() { write([]); }
export function onRecent(fn) { subs.add(fn); return () => subs.delete(fn); }
