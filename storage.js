// storage.js — file-backed replacement for localStorage, talking to server.py.
//
// All values are loaded into an in-memory cache up front, so pages keep the
// synchronous get/set style they had with localStorage. Writes are debounced
// per key and flushed with keepalive requests when the page is hidden/closed.
//
// Usage:
//   await store.ready;            // wait once before the initial render
//   store.get(key)                // -> string or null
//   store.set(key, value)         // persists in the background
//   store.remove(key)
//   store.keys()                  // -> array of known keys
//   await store.refresh()         // re-pull everything from the server
const store = (() => {
  let cache = {};
  const timers = {};
  const WRITE_DEBOUNCE_MS = 250;

  // Keys we own; also the filter for the one-time localStorage migration.
  // Covers both main (rf-admin-tab, shift-report:*) and station mode
  // (rf-station-tab, station-report:*) so the file is identical on both branches.
  const KEY_PATTERN = /^(rf-admin-tab$|rf-station-tab$|timesheet_|shift-report:|station-report:)/;

  function put(key, immediate = false) {
    clearTimeout(timers[key]);
    delete timers[key];
    const send = () =>
      fetch(`/api/storage/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: cache[key],
        keepalive: true,
      }).catch(() => {});
    if (immediate) send();
    else timers[key] = setTimeout(send, WRITE_DEBOUNCE_MS);
  }

  function get(key) {
    return key in cache ? cache[key] : null;
  }

  function set(key, value) {
    cache[key] = String(value);
    put(key);
  }

  function remove(key) {
    delete cache[key];
    clearTimeout(timers[key]);
    delete timers[key];
    fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {});
  }

  function keys() {
    return Object.keys(cache);
  }

  async function refresh() {
    const res = await fetch('/api/storage', { cache: 'no-store' });
    const server = await res.json();
    // Keep values written locally since the fetch started (still in timers).
    cache = Object.assign({}, server, Object.fromEntries(
      Object.keys(timers).map(k => [k, cache[k]])
    ));
  }

  // One-time migration: copy anything still in localStorage that the server
  // doesn't know about yet. localStorage is left untouched as a backup.
  function migrate() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !KEY_PATTERN.test(k)) continue;
      if (k in cache) continue;
      cache[k] = localStorage.getItem(k);
      put(k, true);
    }
  }

  const ready = refresh().then(migrate).catch(err => {
    console.error('storage.js: could not reach server, data will NOT persist', err);
  });

  // Flush any debounced writes before the page goes away.
  window.addEventListener('pagehide', () => {
    Object.keys(timers).forEach(k => put(k, true));
  });

  return { ready, get, set, remove, keys, refresh };
})();
