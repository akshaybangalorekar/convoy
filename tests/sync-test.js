/* Headless tests for shared rooms over GitHub (sync.js).
 * jsdom + stubbed Leaflet, MQTT, WebRTC, getUserMedia and a routed fetch. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function layer() {
  const o = {};
  ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
   'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup', 'setZIndex']
    .forEach((m) => { o[m] = () => o; });
  o.getZoom = () => 13;
  o.getPane = () => ({ style: {} });
  o.getContainer = () => ({ addEventListener: () => {} });
  o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => null });
  return o;
}

function makeStream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { _track: track, getAudioTracks: () => [track], getTracks: () => [track] };
}

// A fetch that behaves like the two GitHub surfaces sync.js talks to.
function router(st) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    st.calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
    if (url.indexOf('raw.githubusercontent.com') >= 0) {
      if (!st.remote) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(st.remote) };
    }
    if (url.indexOf('api.github.com') >= 0) {
      if (!st.tokenOk) return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) };
      if (method === 'PUT') {
        const body = JSON.parse(opts.body);
        st.remote = Buffer.from(body.content, 'base64').toString('utf8');
        st.commits.push(st.remote);
        return { ok: true, status: 201, json: async () => ({ content: {} }) };
      }
      return st.remoteSha
        ? { ok: true, status: 200, json: async () => ({ sha: st.remoteSha }) }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function boot(st) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'https://convoy.test/' });
  const { window } = dom;

  window.L = {
    map: layer, tileLayer: layer, polyline: layer, latLngBounds: layer,
    control: { zoom: () => ({ addTo: () => {} }) }, divIcon: (o) => o, marker: layer,
  };

  const clients = [];
  window.mqtt = {
    connect(url) {
      const h = {};
      const c = {
        url, connected: false, published: [], subscribed: null,
        on(e, f) { (h[e] = h[e] || []).push(f); return c; },
        subscribe(t, o, cb) { c.subscribed = t; cb && cb(null); return c; },
        publish(t, m) { c.published.push(m); return c; },
        end() { c.ended = true; return c; },
        _emit(e, ...a) { (h[e] || []).forEach((f) => f(...a)); },
      };
      clients.push(c);
      return c;
    },
  };

  window.fetch = router(st);
  window.speechSynthesis = { speak() {}, cancel() {} };
  window.SpeechSynthesisUtterance = function () {};
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) window.crypto.getRandomValues = (a) => a;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {} };

  class FakePC {
    constructor() { this.localDescription = null; this.remoteDescription = null; this.connectionState = 'new'; }
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'x' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async createAnswer() { return { type: 'answer', sdp: 'y' }; }
    async addIceCandidate() {}
    close() {}
  }
  window.RTCPeerConnection = FakePC;
  window.RTCSessionDescription = function (d) { return d; };
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia: async () => makeStream() },
  });

  window.eval(fs.readFileSync(path.join(DIR, 'route.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'voice.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  return { window, stubs: { clients } };
}

function join(window, stubs, room, name) {
  const d = window.document;
  d.getElementById('inName').value = name;
  d.getElementById('inRoom').value = room;
  d.getElementById('btnJoin').click();
  const c = stubs.clients[0];
  c.connected = true;
  c._emit('connect');
  return c;
}

const fresh = () => ({ calls: [], commits: [], remote: null, tokenOk: true, remoteSha: null });
const rooms = (window) => JSON.parse(window.localStorage.getItem('convoy.rooms') || '{}');
const has = (st, method) => st.calls.some((x) => x.method === method);

/* ---------- Owner: the token is stored here, and only here ---------- */
async function testOwnerCanSave() {
  const st = fresh();
  const { window, stubs } = boot(st);
  const d = window.document;
  join(window, stubs, 'goa-trip', 'Akshay');
  await sleep(20);

  check('settings start hidden', d.getElementById('settings').classList.contains('hidden'));

  const chip = d.getElementById('roomLabel');
  chip.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await sleep(1000);
  chip.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  check('a long press on the room chip opens the owner settings',
        !d.getElementById('settings').classList.contains('hidden'));

  d.getElementById('inRepo').value = 'akshaybangalorekar/convoy-rooms';
  d.getElementById('inToken').value = 'github_pat_TESTONLY';
  d.getElementById('btnSaveSync').click();
  await sleep(60);

  check('the repo is remembered',
        window.localStorage.getItem('convoy.sync.repo') === 'akshaybangalorekar/convoy-rooms');
  check('the token is remembered on this phone',
        window.localStorage.getItem('convoy.sync.token') === 'github_pat_TESTONLY');
  check('the token is not left sitting in the field', d.getElementById('inToken').value === '');
  check('this phone can save', window.ConvoySync.hasToken() === true);

  const put = st.calls.filter((x) => x.method === 'PUT');
  check('a commit went out', put.length === 1, String(put.length));
  check('the commit carries the saved rooms', /goa-trip/.test(st.remote || ''),
        (st.remote || '').slice(0, 90));
  check('the commit is authenticated with the token',
        (put[0] || {}).headers && put[0].headers.Authorization === 'Bearer github_pat_TESTONLY',
        (put[0] || {}).headers && put[0].headers.Authorization);
  check('the commit names the file', /\/contents\/rooms\.json/.test((put[0] || {}).url || ''),
        (put[0] || {}).url);

  // a second save reuses the existing blob sha
  st.remoteSha = 'sha-abc';
  window.ConvoySync._internals.S.lastPush = 0;
  await window.ConvoySync.push();
  await sleep(20);
  const puts = st.calls.filter((x) => x.method === 'PUT');
  check('a later save still commits', puts.length === 2, String(puts.length));
  check('a later save sends the existing sha',
        JSON.parse(puts[1].body).sha === 'sha-abc', JSON.parse(puts[1].body).sha);

  // clearing the token
  d.getElementById('btnClearSync').click();
  await sleep(10);
  check('clearing forgets the token', window.localStorage.getItem('convoy.sync.token') === null);
  check('and this phone can no longer save', window.ConvoySync.hasToken() === false);
}

/* ---------- Reader: no token, read-only ---------- */
async function testReaderCanOnlyJoin() {
  const st = fresh();
  st.tokenOk = false;
  st.remote = JSON.stringify({
    v: 1,
    rooms: {
      'shared-1': {
        code: 'shared-1', lastSeen: Date.now(),
        members: { p1: { name: 'Priya', lastSeen: Date.now() } },
      },
    },
  });
  const { window, stubs } = boot(st);
  const d = window.document;

  check('a fresh phone has no token', window.ConvoySync.hasToken() === false);
  check('and nothing is shared yet', Object.keys(rooms(window)).length === 0);

  window.localStorage.setItem('convoy.sync.repo', 'akshaybangalorekar/convoy-rooms');
  window.ConvoySync._internals.loadCfg();
  await window.ConvoySync.pull();
  await sleep(20);

  check('a reader sees the shared rooms', !!rooms(window)['shared-1'], Object.keys(rooms(window)).join(','));
  check('and who was in them',
        Object.values(rooms(window)['shared-1'].members).some((m) => m.name === 'Priya'));
  check('the shared room appears in the list',
        /shared-1/.test(d.getElementById('savedRooms').textContent),
        d.getElementById('savedRooms').textContent);
  check('a reader never writes', !has(st, 'PUT'), JSON.stringify(st.calls.map((x) => x.method)));

  // joining a room as a reader must not try to commit
  st.calls.length = 0;
  join(window, stubs, 'reader-room', 'Akshay');
  await sleep(40);
  check('a reader joining a room does not push', !has(st, 'PUT'),
        JSON.stringify(st.calls.map((x) => x.method)));

  // and reading keeps what the phone already had
  check('reading does not wipe local rooms', !!rooms(window)['reader-room'],
        Object.keys(rooms(window)).join(','));
}

/* ---------- Failures are reported, not swallowed ---------- */
async function testBadToken() {
  const st = fresh();
  st.tokenOk = false;
  const { window } = boot(st);
  const d = window.document;
  window.localStorage.setItem('convoy.sync.repo', 'a/b');
  window.localStorage.setItem('convoy.sync.token', 'bad');
  window.ConvoySync._internals.loadCfg();

  await window.ConvoySync.push();
  await sleep(20);
  check('a rejected token is reported', /rejected the token/.test(d.getElementById('syncStatus').textContent),
        d.getElementById('syncStatus').textContent);
  check('nothing was committed with a bad token', st.commits.length === 0);
}

async function testRepoParsing() {
  const st = fresh();
  const { window } = boot(st);
  const sp = window.ConvoySync._internals.splitRepo;
  check('owner/name parses', JSON.stringify(sp('a/b')) === JSON.stringify({ owner: 'a', name: 'b' }),
        JSON.stringify(sp('a/b')));
  check('a pasted URL parses',
        JSON.stringify(sp('https://github.com/a/b')) === JSON.stringify({ owner: 'a', name: 'b' }));
  check('a .git suffix is stripped', sp('https://github.com/a/b.git').name === 'b');
  check('nonsense is rejected', sp('not a repo') === null);
  check('an empty value is rejected', sp('') === null);

  const d = window.document;
  window.ConvoySync._internals.openSettings();
  d.getElementById('inRepo').value = 'nonsense';
  d.getElementById('btnSaveSync').click();
  await sleep(10);
  check('a bad repo is refused with a hint', /owner\/name/.test(d.getElementById('syncStatus').textContent),
        d.getElementById('syncStatus').textContent);
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testOwnerCanSave();
    await testReaderCanOnlyJoin();
    await testBadToken();
    await testRepoParsing();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
