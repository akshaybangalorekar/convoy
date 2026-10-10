/* Headless tests for Convoy's routing & navigation (route.js).
 * Loads the real index.html + route.js + app.js under jsdom, with
 * stubbed Leaflet, MQTT, fetch and speech synthesis. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra = '') =>
  results.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Fixtures ---------- */
// A ~3 km route: A -> B (depart leg), B -> C (turn), then arrive.
const A = { lat: 18.9220, lng: 72.8347 };
const B = { lat: 18.9300, lng: 72.8500 };
const C = { lat: 18.9350, lng: 72.8600 };
const LEG1 = 1839, LEG2 = 1191;

// Points on the A->B line, a known distance short of the turn at B.
const ON_ROUTE_200 = { lat: 18.9291, lng: 72.8483 };
const ON_ROUTE_150 = { lat: 18.92935, lng: 72.84875 };
const OFF_ROUTE = { lat: 19.5000, lng: 73.0000 };

const fix = (p, extra = {}) => ({
  coords: Object.assign({ latitude: p.lat, longitude: p.lng, accuracy: 8, speed: 8, heading: 40 }, extra),
  timestamp: Date.now(),
});

const OSRM = {
  code: 'Ok',
  routes: [{
    distance: LEG1 + LEG2,
    duration: 600,
    geometry: { type: 'LineString', coordinates: [[A.lng, A.lat], [B.lng, B.lat], [C.lng, C.lat]] },
    legs: [{
      distance: LEG1 + LEG2,
      duration: 600,
      steps: [
        { distance: LEG1, duration: 360, name: 'Marine Drive',
          maneuver: { type: 'depart', modifier: null, location: [A.lng, A.lat] } },
        { distance: LEG2, duration: 240, name: 'MG Road',
          maneuver: { type: 'turn', modifier: 'left', location: [B.lng, B.lat] } },
        { distance: 0, duration: 0, name: 'MG Road',
          maneuver: { type: 'arrive', modifier: null, location: [C.lng, C.lat] } },
      ],
    }],
  }],
  waypoints: [],
};

const PHOTON = {
  features: [{
    properties: { name: 'Gateway of India', city: 'Mumbai', country: 'India' },
    geometry: { coordinates: [C.lng, C.lat] },
  }],
};

/* ---------- Stubs ---------- */
function makeStubs(window, opts = {}) {
  const layer = () => {
    const o = {};
    ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
     'removeLayer', 'on', 'off', 'getZoom', 'bindPopup', 'setStyle']
      .forEach((m) => { o[m] = () => o; });
    o.getZoom = () => 13;
    o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} } });
    return o;
  };
  window.L = {
    map: layer, tileLayer: layer, marker: layer, polyline: layer,
    latLngBounds: layer, control: { zoom: () => ({ addTo: () => {} }) },
    divIcon: (o) => o,
  };

  const clients = [];
  window.mqtt = {
    connect(url) {
      const handlers = {};
      const c = {
        url, connected: false, published: [], subscribed: null,
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
        subscribe(t, o2, cb) { c.subscribed = t; cb && cb(null); return c; },
        publish(t, m) { c.published.push(m); return c; },
        end() { c.ended = true; return c; },
        _emit(ev, ...a) { (handlers[ev] || []).forEach((f) => f(...a)); },
      };
      clients.push(c);
      return c;
    },
  };

  const calls = [];
  const fakeFetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('photon') || u.includes('nominatim')) {
      return { ok: true, status: 200, json: async () => PHOTON };
    }
    if (u.includes('/route/v1/')) {
      if (opts.routingFails) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => OSRM };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // jsdom may expose Node's own fetch; override it outright.
  try {
    Object.defineProperty(window, 'fetch', { value: fakeFetch, writable: true, configurable: true });
  } catch (e) {
    window.fetch = fakeFetch;
  }

  const spoken = [];
  window.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel: () => {} };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };

  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) {
    window.crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; };
  }
  window.navigator.geolocation = {
    watchPosition: (ok) => { window.__fix = ok; return 1; },
    clearWatch() {},
  };

  return { clients, calls, spoken };
}

function boot(opts = {}) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://convoy.test/' });
  const { window } = dom;
  const stubs = makeStubs(window, opts);
  window.eval(fs.readFileSync(path.join(DIR, 'route.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  return { window, stubs };
}

function joinRoom(window, stubs, room = 'test-room') {
  const d = window.document;
  d.getElementById('inName').value = 'Akshay';
  d.getElementById('inRoom').value = room;
  d.getElementById('btnJoin').click();
  const client = stubs.clients[0];
  client.connected = true;
  client._emit('connect');
  return client;
}

/* ---------- Test 1: planning a route ---------- */
async function testRoutePlanning() {
  const { window, stubs } = boot();
  const d = window.document;
  const client = joinRoom(window, stubs);
  window.__fix(fix(A));            // a GPS fix, so "From: my location" has something to use
  await sleep(10);

  check('route button exists', !!d.getElementById('btnRoute'));
  check('route panel hidden at start', !d.getElementById('routepanel').classList.contains('show'));

  d.getElementById('btnRoute').click();
  check('route button opens the panel', d.getElementById('routepanel').classList.contains('show'));
  check('body marked routing', d.body.classList.contains('routing'));

  const bikeBtn = d.querySelector('#routeModes .mode[data-mode="bike"]');
  bikeBtn.click();
  check('cycle mode selectable', bikeBtn.classList.contains('on'));

  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(60);

  check('geocoder was called', stubs.calls.some((u) => u.includes('photon') || u.includes('nominatim')));
  const routeUrl = stubs.calls.find((u) => u.includes('/route/v1/')) || '';
  check('router was called', !!routeUrl);
  check('cycle mode uses the bike server', routeUrl.includes('routed-bike'), routeUrl.slice(0, 80));
  check('router asked for steps + geojson',
        routeUrl.includes('steps=true') && routeUrl.includes('geometries=geojson'));

  const summary = d.getElementById('rtSummary').textContent;
  check('summary shows distance', /3\.0 km|3030 m/.test(summary), summary);
  check('summary shows duration', /10 min/.test(summary), summary);
  check('summary offers Start navigation', !!d.getElementById('rtStart'));

  const steps = d.getElementById('rtSteps').textContent;
  check('step list rendered', d.querySelectorAll('#rtSteps li').length === 3,
        String(d.querySelectorAll('#rtSteps li').length));
  check('turn instruction is human readable', /Turn left onto MG Road/.test(steps), steps);
  check('arrival instruction present', /You have arrived/.test(steps), steps);

  const routeMsgs = client.published.filter((m) => m.includes('"t":"route"'));
  check('route broadcast to the room', routeMsgs.length === 1, String(routeMsgs.length));
  const payload = JSON.parse(routeMsgs[0] || '{}');
  check('shared payload carries geometry', Array.isArray(payload.geometry) && payload.geometry.length >= 3);
  check('shared payload carries steps', Array.isArray(payload.steps) && payload.steps.length === 3);
  check('shared payload names the setter', payload.by === 'Akshay', payload.by);
  check('shared payload carries the mode', payload.mode === 'bike', payload.mode);

  return { window, stubs };
}

/* ---------- Test 2: live navigation ---------- */
async function testNavigation() {
  const { window, stubs } = await testRoutePlanning();
  const d = window.document;

  check('not navigating yet', !d.body.classList.contains('navigating'));
  d.getElementById('rtStart').click();
  check('start switches to navigating', d.body.classList.contains('navigating'));
  check('route panel closed on start', !d.getElementById('routepanel').classList.contains('show'));
  check('spoke a start prompt', stubs.spoken.some((t) => /Starting navigation/.test(t)));

  // Mute first: the turn announcement should be withheld.
  d.getElementById('navMute').click();
  check('mute toggles the label', d.getElementById('navMute').textContent === 'Muted');

  window.__fix(fix(ON_ROUTE_200));
  await sleep(20);
  check('muted: nothing spoken', stubs.spoken.length === 1, stubs.spoken.join('|'));

  const banner = d.getElementById('navMain').textContent;
  check('banner shows the next turn', /Turn left onto MG Road/.test(banner), banner);
  check('banner shows distance to the turn', /\d+\s?(m|km)/.test(banner), banner);
  check('banner icon is a left arrow', d.getElementById('navIco').textContent === '←',
        d.getElementById('navIco').textContent);
  check('remaining distance shown', /left/.test(d.getElementById('navRemain').textContent),
        d.getElementById('navRemain').textContent);
  check('progress percent shown', /%/.test(d.getElementById('navRemain').textContent),
        d.getElementById('navRemain').textContent);

  // Unmute: the withheld announcement should fire now.
  d.getElementById('navMute').click();
  check('unmute restores the label', d.getElementById('navMute').textContent === 'Voice');
  window.__fix(fix(ON_ROUTE_150));
  await sleep(20);
  check('spoke the turn prompt once unmuted',
        stubs.spoken.some((t) => /Turn left onto MG Road/.test(t)), stubs.spoken.join('|'));

  // Wander off the route.
  window.__fix(fix(OFF_ROUTE));
  await sleep(20);
  check('off-route detected', /Off route/.test(d.getElementById('navMain').textContent),
        d.getElementById('navMain').textContent);

  d.getElementById('navStop').click();
  check('stop leaves navigating mode', !d.body.classList.contains('navigating'));
}

/* ---------- Test 3: a route shared by someone else ---------- */
async function testSharedRouteInbound() {
  const { window, stubs } = boot();
  const d = window.document;
  const client = joinRoom(window, stubs, 'shared-room');

  client._emit('message', 'sarvam-convoy/v1/shared-room/bus', Buffer.from(JSON.stringify({
    t: 'route', id: 'peer-9', by: 'Priya', mode: 'foot',
    distance: LEG1 + LEG2, duration: 2400,
    start: { lat: A.lat, lng: A.lng, label: 'Marine Drive' },
    end: { lat: C.lat, lng: C.lng, label: 'Gateway of India' },
    geometry: [[A.lat, A.lng], [B.lat, B.lng], [C.lat, C.lng]],
    steps: [{ text: 'Head out', dist: LEG1, dur: 1400, type: 'depart', icon: '↑' },
            { text: 'Turn left onto MG Road', dist: LEG2, dur: 1000, type: 'turn', icon: '←' },
            { text: 'You have arrived', dist: 0, dur: 0, type: 'arrive', icon: '⚑' }],
  })));
  await sleep(20);

  check('inbound route opens the panel', d.getElementById('routepanel').classList.contains('show'));
  const summary = d.getElementById('rtSummary').textContent;
  check('inbound route credits the setter', /Priya/.test(summary), summary);
  check('inbound route shows its mode', /Walk/.test(summary), summary);
  check('inbound route renders steps', d.querySelectorAll('#rtSteps li').length === 3);
  check('inbound route is not re-broadcast',
        client.published.filter((m) => m.includes('"t":"route"')).length === 0);

  client._emit('message', 'x', Buffer.from(JSON.stringify({ t: 'route-clear', id: 'peer-9' })));
  await sleep(20);
  check('inbound clear empties the summary', d.getElementById('rtSummary').textContent === '');
  check('inbound clear empties the steps', d.getElementById('rtSteps').innerHTML === '');
}

/* ---------- Test 4: failure handling ---------- */
async function testFailureHandling() {
  const { window, stubs } = boot({ routingFails: true });
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(10);
  d.getElementById('rtTo').value = 'Somewhere';
  d.getElementById('rtGo').click();
  await sleep(80);
  check('routing failure surfaces a message',
        /Could not find a route/.test(d.getElementById('toast').textContent),
        d.getElementById('toast').textContent);
  check('no route drawn on failure', d.getElementById('rtSummary').textContent === '');
  check('button restored after failure', d.getElementById('rtGo').textContent === 'Get route',
        d.getElementById('rtGo').textContent);
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testNavigation();
    await testSharedRouteInbound();
    await testFailureHandling();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
