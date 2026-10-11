/* Convoy — shared rooms over GitHub
 * ------------------------------------------------------------------
 * The app has no backend, so a public GitHub repo stands in for one.
 *
 *   owner's phone : holds a token, WRITES rooms.json to the repo
 *   everyone else : no token at all, just READS the public file
 *
 * That is what makes "only my phone can save, others can only join"
 * true: reading a public repo needs no credentials, so nobody else has
 * anything to steal. The token is never sent to the room, never in the
 * source, and never leaves the device it was typed on.
 *
 * Reads go through the raw CDN (no auth, no API rate limit).
 * Writes go through the REST API with the token.
 */
(function () {
  'use strict';

  let API = null;

  const CFG = {
    file: 'rooms.json',
    branch: 'main',
    api: 'https://api.github.com',
    raw: 'https://raw.githubusercontent.com',
    pushDebounceMs: 8000,     // at most one commit every 8s while you are joining rooms
    pullMs: 5 * 60 * 1000,    // re-read the shared list every 5 minutes
  };

  const LS = { repo: 'convoy.sync.repo', token: 'convoy.sync.token' };

  const S = { repo: '', token: '', lastPush: 0, pushTimer: null };

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- *
   * Config
   * ---------------------------------------------------------------- */
  function loadCfg() {
    try {
      S.repo = localStorage.getItem(LS.repo) || '';
      S.token = localStorage.getItem(LS.token) || '';
    } catch (e) { /* ignore */ }
  }

  function saveCfg() {
    try {
      if (S.repo) localStorage.setItem(LS.repo, S.repo);
      else localStorage.removeItem(LS.repo);
      if (S.token) localStorage.setItem(LS.token, S.token);
      else localStorage.removeItem(LS.token);
    } catch (e) { /* ignore */ }
  }

  // Accepts "owner/name" or a pasted repo URL.
  function splitRepo(s) {
    const v = String(s || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
    const m = v.match(/^([\w.-]+)\/([\w.-]+)$/);
    return m ? { owner: m[1], name: m[2] } : null;
  }

  const hasToken = () => !!S.token;
  const configured = () => !!splitRepo(S.repo);

  function setStatus(text) {
    const el = $('syncStatus');
    if (el) el.textContent = text || '';
  }

  /* ---------------------------------------------------------------- *
   * Read (no credentials — this is the "others can only join" half)
   * ---------------------------------------------------------------- */
  async function pull() {
    const r = splitRepo(S.repo);
    if (!r) return 0;
    try {
      const url = CFG.raw + '/' + r.owner + '/' + r.name + '/' + CFG.branch + '/' +
                  CFG.file + '?t=' + Date.now();
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) { setStatus('No shared rooms yet'); return 0; }
      if (!res.ok) { setStatus('Could not read the repo (' + res.status + ')'); return 0; }
      const data = await res.json();
      const n = API.mergeRooms(data && data.rooms ? data.rooms : data);
      setStatus(n ? 'Pulled ' + n + ' room' + (n === 1 ? '' : 's') : 'Up to date');
      return n;
    } catch (e) {
      setStatus('Could not reach GitHub');
      return 0;
    }
  }

  /* ---------------------------------------------------------------- *
   * Write (owner only)
   * ---------------------------------------------------------------- */
  function b64(str) {
    // UTF-8 safe, without depending on TextEncoder being present.
    const utf8 = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
      (m, p) => String.fromCharCode(parseInt(p, 16)));
    return btoa(utf8);
  }

  async function push() {
    if (!S.token) return false;
    const r = splitRepo(S.repo);
    if (!r) { setStatus('Set the repo first'); return false; }

    const body = JSON.stringify({ v: 1, updated: Date.now(), rooms: API.rooms.load() }, null, 1);
    const auth = { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json' };
    const contents = CFG.api + '/repos/' + r.owner + '/' + r.name + '/contents/' + CFG.file;

    setStatus('Saving…');
    try {
      // The API needs the current blob sha to replace an existing file.
      let sha = null;
      const head = await fetch(contents + '?ref=' + CFG.branch, { headers: auth, cache: 'no-store' });
      if (head.ok) {
        const j = await head.json();
        sha = j && j.sha;
      } else if (head.status !== 404) {
        setStatus(head.status === 401 || head.status === 403
          ? 'GitHub rejected the token — check its scope and expiry'
          : 'GitHub said ' + head.status);
        return false;
      }

      const put = await fetch(contents, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
        body: JSON.stringify({
          message: 'Convoy: update saved rooms',
          content: b64(body),
          branch: CFG.branch,
          sha: sha || undefined,
        }),
      });

      if (!put.ok) {
        const err = await put.json().catch(() => ({}));
        setStatus('Save failed: ' + (err.message || put.status));
        return false;
      }
      S.lastPush = Date.now();
      setStatus('Saved to GitHub');
      return true;
    } catch (e) {
      setStatus('Could not reach GitHub');
      return false;
    }
  }

  // Coalesce a burst of joins into one commit.
  function schedulePush() {
    if (!S.token) return;
    if (S.pushTimer) clearTimeout(S.pushTimer);
    const wait = Math.max(0, CFG.pushDebounceMs - (Date.now() - S.lastPush));
    S.pushTimer = setTimeout(() => { S.pushTimer = null; push(); }, wait);
  }

  /* ---------------------------------------------------------------- *
   * The settings panel — reachable only by a long press on the room chip
   * ---------------------------------------------------------------- */
  function openSettings() {
    loadCfg();
    $('inRepo').value = S.repo;
    $('inToken').value = S.token;
    setStatus(configured()
      ? (hasToken() ? 'This phone can save rooms' : 'Read-only on this phone')
      : 'Not set up');
    $('settings').classList.remove('hidden');
  }

  function closeSettings() {
    $('settings').classList.add('hidden');
    $('inToken').value = '';
  }

  function wireSettings() {
    $('btnSettingsClose').addEventListener('click', closeSettings);

    $('btnSaveSync').addEventListener('click', () => {
      S.repo = ($('inRepo').value || '').trim();
      S.token = ($('inToken').value || '').trim();
      if (S.repo && !splitRepo(S.repo)) { setStatus('Repo should look like owner/name'); return; }
      saveCfg();
      $('inToken').value = '';
      if (configured()) { pull(); schedulePush(); }
      else setStatus('Not set up');
    });

    $('btnClearSync').addEventListener('click', () => {
      S.token = '';
      saveCfg();
      $('inToken').value = '';
      setStatus(hasToken() ? 'Token cleared' : 'This phone can no longer save rooms');
    });

    $('btnSyncNow').addEventListener('click', async () => {
      if (hasToken()) await push();
      await pull();
    });
  }

  function wireLongPress() {
    const chip = $('roomLabel');
    if (!chip) return;
    let timer = null;
    const start = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; openSettings(); }, 900);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    ['pointerdown', 'touchstart', 'mousedown'].forEach((e) => chip.addEventListener(e, start, { passive: true }));
    ['pointerup', 'pointerleave', 'pointercancel', 'touchend', 'touchcancel',
     'mouseup', 'mouseleave'].forEach((e) => chip.addEventListener(e, cancel, { passive: true }));
    chip.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function init(api) {
    API = api;
    loadCfg();
    wireSettings();
    wireLongPress();
    setInterval(() => { if (configured()) pull(); }, CFG.pullMs);
  }

  window.ConvoySync = {
    init, pull, push, schedulePush, hasToken, configured,
    _internals: { CFG, LS, S, splitRepo, openSettings, closeSettings, loadCfg },
  };
})();
