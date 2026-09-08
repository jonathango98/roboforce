// storage.js — file-backed replacement for localStorage, talking to server.py.
//
// All values are loaded into an in-memory cache up front, so pages keep the
// synchronous get/set style they had with localStorage. Writes are debounced
// per key and flushed with keepalive requests when the page is hidden/closed.
//
// If the server goes away, a fixed banner warns the user, failed writes are
// retried every few seconds, and unsent writes are mirrored to localStorage
// so they can be replayed on the next page load if the tab closes first.
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
  const pendingPuts = new Set();
  const pendingDeletes = new Set();
  const WRITE_DEBOUNCE_MS = 250;
  const RETRY_INTERVAL_MS = 5000;
  const BACKUP_PREFIX = 'rf-pending:';

  // Keys we own; also the filter for the one-time localStorage migration.
  // Covers both main (rf-admin-tab, shift-report:*) and station mode
  // (rf-station-tab, station-report:*) so the file is identical on both branches.
  const KEY_PATTERN = /^(rf-admin-tab$|rf-station-tab$|shift-report:|station-report:)/;

  // ---- Connection banner ----
  let online = true;
  let banner = null;
  let bannerHideTimer = null;

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '99999',
      padding: '10px 16px',
      textAlign: 'center',
      font: 'bold 14px system-ui, sans-serif',
      color: '#fff',
      display: 'none',
    });
    (document.body || document.documentElement).appendChild(banner);
    return banner;
  }

  function setOnline(ok) {
    if (ok === online) return;
    online = ok;
    const b = ensureBanner();
    clearTimeout(bannerHideTimer);
    if (!ok) {
      b.style.background = '#c0392b';
      b.textContent =
        '⚠️ Server offline — changes are NOT being saved. Rerun robo-report to go back online.';
      b.style.display = 'block';
    } else {
      b.style.background = '#27ae60';
      b.textContent = '✓ Back online — changes saved.';
      b.style.display = 'block';
      bannerHideTimer = setTimeout(() => { b.style.display = 'none'; }, 4000);
    }
  }

  // ---- localStorage mirror of writes that have not reached the server ----
  function backup(key, op) {
    try {
      localStorage.setItem(
        BACKUP_PREFIX + key,
        JSON.stringify(op === 'del' ? { op: 'del' } : { op: 'put', value: cache[key] })
      );
    } catch (e) { /* quota/private mode: banner still warns the user */ }
  }

  function clearBackup(key) {
    try { localStorage.removeItem(BACKUP_PREFIX + key); } catch (e) {}
  }

  function sendPut(key) {
    if (!(key in cache)) { pendingPuts.delete(key); return Promise.resolve(); }
    return fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: cache[key],
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`);
      pendingPuts.delete(key);
      clearBackup(key);
      setOnline(true);
    }).catch(() => {
      pendingPuts.add(key);
      backup(key, 'put');
      setOnline(false);
    });
  }

  function sendDelete(key) {
    return fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error(`DELETE ${key}: ${res.status}`);
      pendingDeletes.delete(key);
      clearBackup(key);
      setOnline(true);
    }).catch(() => {
      pendingDeletes.add(key);
      backup(key, 'del');
      setOnline(false);
    });
  }

  function put(key, immediate = false) {
    clearTimeout(timers[key]);
    delete timers[key];
    if (immediate) sendPut(key);
    else timers[key] = setTimeout(() => { delete timers[key]; sendPut(key); }, WRITE_DEBOUNCE_MS);
  }

  function get(key) {
    return key in cache ? cache[key] : null;
  }

  function set(key, value) {
    cache[key] = String(value);
    pendingDeletes.delete(key);
    put(key);
  }

  function remove(key) {
    delete cache[key];
    clearTimeout(timers[key]);
    delete timers[key];
    pendingPuts.delete(key);
    sendDelete(key);
  }

  function keys() {
    return Object.keys(cache);
  }

  async function refresh() {
    const res = await fetch('/api/storage', { cache: 'no-store' });
    const server = await res.json();
    // Keep values written locally that the server hasn't confirmed yet
    // (debounced in timers, or failed and awaiting retry).
    const keep = new Set([...Object.keys(timers), ...pendingPuts]);
    cache = Object.assign({}, server, Object.fromEntries(
      [...keep].map((k) => [k, cache[k]])
    ));
    pendingDeletes.forEach((k) => { delete cache[k]; });
    setOnline(true);
  }

  // Replay writes that never reached the server in a previous session
  // (mirrored to localStorage under BACKUP_PREFIX). These are newer than
  // whatever the server has, so they win over the refreshed cache.
  function replayBackups() {
    const backups = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(BACKUP_PREFIX)) backups.push(k);
    }
    for (const bk of backups) {
      const key = bk.slice(BACKUP_PREFIX.length);
      let rec = null;
      try { rec = JSON.parse(localStorage.getItem(bk)); } catch (e) {}
      if (rec && rec.op === 'del') {
        delete cache[key];
        sendDelete(key);
      } else if (rec && typeof rec.value === 'string') {
        cache[key] = rec.value;
        pendingPuts.add(key);
        sendPut(key);
      } else {
        clearBackup(key);
      }
    }
    if (backups.length) console.log('storage.js: replaying unsent writes:', backups);
  }

  // One-time migration: copy anything still in localStorage that the server
  // doesn't know about yet. localStorage is left untouched as a backup.
  function migrate() {
    const migrated = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !KEY_PATTERN.test(k)) continue;
      if (k in cache) continue;
      cache[k] = localStorage.getItem(k);
      put(k, true);
      migrated.push(k);
    }
    if (migrated.length) console.log('storage.js: migrated from localStorage:', migrated);
  }

  let synced = false;

  function syncFromServer() {
    return refresh().then(() => {
      synced = true;
      replayBackups();
      migrate();
    });
  }

  const ready = syncFromServer().catch((err) => {
    setOnline(false);
    console.error('storage.js: could not reach server, data will NOT persist', err);
  });

  // Any HTTP response (even a 404) means the server is up.
  function ping() {
    return fetch('/api/storage/__ping', { cache: 'no-store' })
      .then(() => setOnline(true))
      .catch(() => setOnline(false));
  }

  // Every few seconds: retry anything unsent; otherwise finish the initial
  // sync if it failed, or just ping so the banner appears/clears promptly
  // even when the user isn't typing.
  setInterval(() => {
    if (pendingPuts.size || pendingDeletes.size) {
      pendingPuts.forEach((k) => sendPut(k));
      pendingDeletes.forEach((k) => sendDelete(k));
    } else if (!synced) {
      syncFromServer().catch(() => setOnline(false));
    } else {
      ping();
    }
  }, RETRY_INTERVAL_MS);

  // Flush any debounced writes before the page goes away. Mirror everything
  // unconfirmed to localStorage first: if the keepalive requests don't make
  // it, the next page load replays them (rewriting an already-saved value is
  // harmless).
  window.addEventListener('pagehide', () => {
    Object.keys(timers).forEach((k) => { backup(k, 'put'); put(k, true); });
    pendingPuts.forEach((k) => backup(k, 'put'));
    pendingDeletes.forEach((k) => backup(k, 'del'));
  });

  return { ready, get, set, remove, keys, refresh };
})();
