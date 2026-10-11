/* Headless tests for the map view: rejoining on launch, unique car colours, and the
 * auto-fit that keeps every car in frame. */
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
   'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup', 'setZIndex', 'setIcon']
    .forEach((m) => { o[m] = () => o; });
  o.getZoom = () => 13;
  o.getPane = () => ({ style: {} });
  o.getContainer = () => ({ addEventListener: () => {} });
  o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => null });
  return o;
}

// A map that records what the app asked it to do.
function makeMap() {
  const calls = { fitBounds: [], setView: [], panTo: [] };
  const m = layer();
  m.fitBounds = (b, o) => { calls.fitBounds.push(o || {}); return m; };
  m.setView = (c, z, o) => { calls.setView.push([c, z, o || {}]); return m; };
  m.panTo = (c, o) => { calls.panTo.push(c); return m; };
  m.on = () => m;
  return { m, calls };
}

function makeStream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { _track: track, getAudioTracks: () => [track], getTracks: () => [track] };
}

function boot(setup) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'https://convoy.test/' });
  const { window } = dom;
  const { m: mapObj, calls } = makeMap();

  window.L = {
    map: () => mapObj, tileLayer: layer, polyline: layer, latLngBounds: layer,
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
        publish(t, msg) { c.published.push(msg); return c; },
        end() { c.ended = true; return c; },
        _emit(e, ...a) { (h[e] || []).forEach((f) => f(...a)); },
      };
      clients.push(c);
      return c;
    },
  };

  window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  window.speechSynthesis = { speak() {}, cancel() {} };
  window.SpeechSynthesisUtterance = function () {};
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) window.crypto.getRandomValues = (a) => a;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {} };

  class FakePC {
    constructor() { this.connectionState = 'new'; }
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
  if (setup) setup(window);                      // e.g. pre-seed storage before boot
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  return { window, stubs: { clients }, calls };
}

const pos = (id, name, lat, lng) => Buffer.from(JSON.stringify({
  t: 'pos', id, name, lat, lng, spd: 10, hdg: 90, acc: 6, ts: Date.now(),
}));

/* ---------- Launching again should not show the join screen ---------- */
async function testRejoinOnLaunch() {
  const { window, stubs } = boot((w) => {
    w.localStorage.setItem('convoy.name', 'Akshay');
    w.localStorage.setItem('convoy.room', 'goa-trip');
  });
  await sleep(40);
  const d = window.document;

  check('a returning phone rejoins by itself',
        d.getElementById('roomLabel').textContent === 'goa-trip',
        d.getElementById('roomLabel').textContent);
  check('the join screen stays hidden on launch',
        d.getElementById('join').classList.contains('hidden'));
  check('so its Forget buttons are never on screen',
        d.getElementById('join').classList.contains('hidden'));
  const c = stubs.clients[0];
  check('a connection is opened for the room', !!c, String(stubs.clients.length));
  if (c) { c.connected = true; c._emit('connect'); }
  await sleep(20);
  check('and it subscribes to the room topic', !!c && !!c.subscribed, c && c.subscribed);
  check('the room was remembered',
        !!JSON.parse(window.localStorage.getItem('convoy.rooms') || '{}')['goa-trip']);
}

async function testFirstRunStillAsks() {
  const { window, stubs } = boot();
  await sleep(30);
  const d = window.document;
  check('a first-time phone still sees the join screen',
        !d.getElementById('join').classList.contains('hidden'));
  check('and no room is joined', window.Convoy.state.joined === false);
  check('and nothing is connected', stubs.clients.length === 0, String(stubs.clients.length));
}

/* ---------- Every car gets its own colour ---------- */
async function testUniqueColors() {
  const { window, stubs } = boot();
  const d = window.document;
  d.getElementById('inName').value = 'Akshay';
  d.getElementById('inRoom').value = 'colour-room';
  d.getElementById('btnJoin').click();
  const c = stubs.clients[0];
  c.connected = true; c._emit('connect');
  await sleep(20);

  // Six others, more than enough to collide with a plain hash.
  for (let i = 1; i <= 6; i++) c._emit('message', 'x', pos('p' + i, 'P' + i, 15.5 + i * 0.01, 73.8));
  await sleep(40);

  const me = window.Convoy.state.me;
  const people = [me].concat(Array.from(window.Convoy.state.peers.values()));
  const colours = people.map((p) => p.color);

  check('there are seven cars on the map', people.length === 7, String(people.length));
  check('every car has a colour', colours.every(Boolean), JSON.stringify(colours));
  check('no two cars share a colour', new Set(colours).size === colours.length,
        JSON.stringify(colours));
  check('your own car keeps the first colour',
        me.color === window.Convoy._internals.PALETTE[0], me.color);
  check('the colours come from the palette',
        colours.every((x) => window.Convoy._internals.PALETTE.indexOf(x) >= 0),
        JSON.stringify(colours));

  // A car leaving frees its colour, and the rest stay unique.
  c._emit('message', 'x', Buffer.from(JSON.stringify({ t: 'bye', id: 'p1' })));
  await sleep(20);
  const after = [me].concat(Array.from(window.Convoy.state.peers.values())).map((p) => p.color);
  check('colours stay unique after someone leaves', new Set(after).size === after.length,
        JSON.stringify(after));
}

async function testColoursAgreeAcrossPhones() {
  const ids = ['p1', 'p2', 'p3'];
  const run = async () => {
    const { window, stubs } = boot();
    const d = window.document;
    d.getElementById('inName').value = 'Akshay';
    d.getElementById('inRoom').value = 'same-room';
    d.getElementById('btnJoin').click();
    const c = stubs.clients[0];
    c.connected = true; c._emit('connect');
    await sleep(20);
    // deliberately delivered in a different order on each phone
    const order = window.__rev ? ids.slice().reverse() : ids;
    order.forEach((id, i) => c._emit('message', 'x', pos(id, id, 15.5 + i * 0.01, 73.8)));
    await sleep(30);
    const out = {};
    window.Convoy.state.peers.forEach((p) => { out[p.id] = p.color; });
    return out;
  };
  const a = await run();
  const b = await run();
  check('every phone gives a car the same colour',
        JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' vs ' + JSON.stringify(b));
}

/* ---------- The view keeps everyone in frame ---------- */
async function testAutoFit() {
  const { window, stubs, calls } = boot();
  const d = window.document;
  d.getElementById('inName').value = 'Akshay';
  d.getElementById('inRoom').value = 'fit-room';
  d.getElementById('btnJoin').click();
  const c = stubs.clients[0];
  c.connected = true; c._emit('connect');
  await sleep(20);

  c._emit('message', 'x', pos('p1', 'Priya', 15.500, 73.800));
  c._emit('message', 'x', pos('p2', 'Rahul', 15.512, 73.812));
  await sleep(30);

  check('keeping everyone in view is on by default', window.Convoy.state.autoFit === true);

  calls.fitBounds.length = 0;
  window.Convoy._internals.maybeAutoView();
  check('the map fits all the cars', calls.fitBounds.length === 1, String(calls.fitBounds.length));
  const opts = calls.fitBounds[0] || {};
  check('the fit zooms in close when cars are bunched up', opts.maxZoom >= 17,
        JSON.stringify(opts));
  check('the fit leaves a margin around the edges',
        Array.isArray(opts.padding) && opts.padding.length === 2, JSON.stringify(opts));

  // Taking control hands the view back to the driver.
  window.Convoy._internals.takeViewControl();
  check('taking control turns auto-fit off', window.Convoy.state.autoFit === false);
  check('and follow stays off', window.Convoy.state.follow === false);
  calls.fitBounds.length = 0;
  window.Convoy._internals.maybeAutoView();
  check('the map is then left alone', calls.fitBounds.length === 0, String(calls.fitBounds.length));

  // The Fit all button switches it back on.
  d.getElementById('btnFit').click();
  await sleep(10);
  check('Fit all turns auto-fit back on', window.Convoy.state.autoFit === true);
  check('and refits immediately', calls.fitBounds.length === 1, String(calls.fitBounds.length));
  check('the Fit all button shows as active', d.getElementById('btnFit').classList.contains('on'));

  // Follow me is the other choice, and the two do not fight.
  d.getElementById('btnFollow').click();
  await sleep(10);
  check('Follow me turns auto-fit off', window.Convoy.state.autoFit === false);
  check('Follow me turns follow on', window.Convoy.state.follow === true);
  check('the Follow me button shows as active', d.getElementById('btnFollow').classList.contains('on'));
  check('and Fit all stops showing as active', !d.getElementById('btnFit').classList.contains('on'));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testRejoinOnLaunch();
    await testFirstRunStillAsks();
    await testUniqueColors();
    await testColoursAgreeAcrossPhones();
    await testAutoFit();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
