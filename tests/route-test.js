/* Headless tests for Convoy's routing & navigation (route.js) and the
 * driving-friendly map markers (app.js).
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
const A = { lat: 18.9220, lng: 72.8347 };
const B = { lat: 18.9300, lng: 72.8500 };
const C = { lat: 18.9350, lng: 72.8600 };
const LEG1 = 1839, LEG2 = 1191;

const ON_ROUTE_200 = { lat: 18.9291, lng: 72.8483 };
const ON_ROUTE_150 = { lat: 18.92935, lng: 72.84875 };
const OFF_ROUTE = { lat: 19.5000, lng: 73.0000 };

const fix = (p, extra = {}) => ({
  coords: Object.assign({ latitude: p.lat, longitude: p.lng, accuracy: 8, speed: 8, heading: 40 }, extra),
  timestamp: Date.now(),
});

const LINE = { type: 'LineString', coordinates: [[A.lng, A.lat], [B.lng, B.lat], [C.lng, C.lat]] };

const OSRM = {
  code: 'Ok',
  routes: [{
    distance: LEG1 + LEG2, duration: 600, geometry: LINE,
    legs: [{
      distance: LEG1 + LEG2, duration: 600,
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

// A quicker route offered after a recalculate (600s -> 400s).
const OSRM_FASTER = {
  code: 'Ok',
  routes: [{
    distance: 2500, duration: 400, geometry: LINE,
    legs: [{
      distance: 2500, duration: 400,
      steps: [
        { distance: 2500, duration: 400, name: 'Coastal Road',
          maneuver: { type: 'depart', modifier: null, location: [A.lng, A.lat] } },
        { distance: 0, duration: 0, name: 'Coastal Road',
          maneuver: { type: 'arrive', modifier: null, location: [C.lng, C.lat] } },
      ],
    }],
  }],
  waypoints: [],
};

// Three alternatives: A is quick-ish and turny, B is quickest but winding,
// C is a little slower yet short and nearly straight -> C should win.
function mkRoute(distance, duration, turnCount) {
  const steps = [{
    distance: distance * 0.6, duration: duration * 0.6, name: 'Marine Drive',
    maneuver: { type: 'depart', modifier: null, location: [A.lng, A.lat] },
  }];
  for (let i = 0; i < turnCount; i++) {
    steps.push({
      distance: (distance * 0.3) / turnCount, duration: (duration * 0.3) / turnCount,
      name: 'Road ' + (i + 1),
      maneuver: { type: 'turn', modifier: i % 2 ? 'left' : 'right',
                  location: [A.lng + 0.001 * (i + 1), A.lat + 0.001 * (i + 1)] },
    });
  }
  steps.push({
    distance: 0, duration: 0, name: 'Gateway of India',
    maneuver: { type: 'arrive', modifier: null, location: [C.lng, C.lat] },
  });
  return { distance, duration, geometry: LINE, legs: [{ distance, duration, steps }] };
}

const OSRM_ALTS = {
  code: 'Ok',
  routes: [mkRoute(3942, 900, 12), mkRoute(4700, 870, 25), mkRoute(3275, 1000, 3)],
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

  // Markers really insert their HTML into the document, so we can inspect them.
  window.L = {
    map: layer, tileLayer: layer, polyline: layer, latLngBounds: layer,
    control: { zoom: () => ({ addTo: () => {} }) },
    divIcon: (o) => o,
    marker(latlng, o) {
      const el = window.document.createElement('div');
      el.className = 'leaflet-marker-icon';
      if (o && o.icon && o.icon.html) el.innerHTML = o.icon.html;
      window.document.body.appendChild(el);
      const m = {};
      ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds',
       'getBounds', 'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup']
        .forEach((k) => { m[k] = () => m; });
      m.getElement = () => el;
      return m;
    },
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
  let routeCalls = 0;
  const fakeFetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('photon') || u.includes('nominatim')) {
      return { ok: true, status: 200, json: async () => PHOTON };
    }
    if (u.includes('/route/v1/')) {
      routeCalls++;
      if (opts.routingFails) return { ok: false, status: 502, json: async () => ({}) };
      if (opts.betterOnRecalc && routeCalls >= 2) {
        return { ok: true, status: 200, json: async () => OSRM_FASTER };
      }
      if (opts.alts) return { ok: true, status: 200, json: async () => OSRM_ALTS };
      return { ok: true, status: 200, json: async () => OSRM };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
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

  return { clients, calls, spoken, routeCalls: () => routeCalls };
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

/* ---------- Test 1: vehicles, labels, planning ---------- */
async function testRoutePlanning() {
  const { window, stubs } = boot();
  const d = window.document;
  const client = joinRoom(window, stubs);
  window.__fix(fix(A, { heading: 90 }));
  await sleep(10);

  // --- markers are vehicles, and names stay hidden by default
  check('a vehicle marker is drawn', d.querySelectorAll('.mk .veh').length >= 1,
        String(d.querySelectorAll('.mk .veh').length));
  check('vehicle defaults to a car', d.querySelector('.mk .veh').dataset.g === 'car',
        d.querySelector('.mk .veh').dataset.g);
  check('marker carries the owner colour', /color:/.test(d.querySelector('.mk').getAttribute('style') || ''));
  check('car is rotated to the heading',
        /90/.test((d.querySelector('.mk.me .veh-rot') || {}).style
          ? d.querySelector('.mk.me .veh-rot').style.transform : ''),
        d.querySelector('.mk.me .veh-rot') && d.querySelector('.mk.me .veh-rot').style.transform);
  check('a name label element exists', d.querySelectorAll('.mk .lbl').length >= 1);
  check('names hidden by default', !d.body.classList.contains('names'));

  d.getElementById('btnNames').click();
  check('Names toggle shows labels', d.body.classList.contains('names'));
  d.getElementById('btnNames').click();
  check('Names toggle hides them again', !d.body.classList.contains('names'));

  // --- planning
  check('route panel hidden at start', !d.getElementById('routepanel').classList.contains('show'));
  d.getElementById('btnRoute').click();
  check('route button opens the panel', d.getElementById('routepanel').classList.contains('show'));

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
  check('router asked for alternatives', routeUrl.includes('alternatives=3'), routeUrl.slice(-40));

  const summary = d.getElementById('rtSummary').textContent;
  check('summary shows distance', /3\.0 km|3030 m/.test(summary), summary);
  check('summary shows duration', /10 min/.test(summary), summary);
  check('summary says why this route', /fastest/.test(summary), summary);
  check('summary offers Start navigation', !!d.getElementById('rtStart'));

  const steps = d.getElementById('rtSteps').textContent;
  check('step list rendered', d.querySelectorAll('#rtSteps li').length === 3,
        String(d.querySelectorAll('#rtSteps li').length));
  check('turn instruction is human readable', /Turn left onto MG Road/.test(steps), steps);
  check('arrival instruction present', /You have arrived/.test(steps), steps);

  check('vehicles switch to the route mode',
        d.querySelector('.mk .veh').dataset.g === 'bike', d.querySelector('.mk .veh').dataset.g);

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

  d.getElementById('navMute').click();
  check('unmute restores the label', d.getElementById('navMute').textContent === 'Voice');
  window.__fix(fix(ON_ROUTE_150));
  await sleep(20);
  check('spoke the turn prompt once unmuted',
        stubs.spoken.some((t) => /Turn left onto MG Road/.test(t)), stubs.spoken.join('|'));

  window.__fix(fix(OFF_ROUTE));
  await sleep(20);
  check('off-route detected', /Off route/.test(d.getElementById('navMain').textContent),
        d.getElementById('navMain').textContent);

  d.getElementById('navStop').click();
  check('stop leaves navigating mode', !d.body.classList.contains('navigating'));
}

/* ---------- Test 3: choosing between alternatives ---------- */
async function testAlternativeScoring() {
  const { window, stubs } = boot({ alts: true });
  const d = window.document;
  const client = joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(10);

  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(60);

  const summary = d.getElementById('rtSummary').textContent;
  // alt C (3275 m / 1000 s / 3 turns) should beat the fastest but turnier alt B.
  check('picks the straighter alternative over the quickest', /3\.3 km/.test(summary), summary);
  check('chosen duration is the straighter one', /17 min/.test(summary), summary);
  check('summary reports the turn count', /3 turns/.test(summary), summary);
  check('summary says which it chose and from how many',
        /fewest turns/.test(summary) && /of 3 options/.test(summary), summary);

  const payload = JSON.parse((client.published.filter((m) => m.includes('"t":"route"'))[0]) || '{}');
  check('the shared route is the chosen one', payload.distance === 3275, String(payload.distance));
  check('the shared route carries the turn count too',
        Array.isArray(payload.steps) && payload.steps.length === 5, String((payload.steps || []).length));
}

/* ---------- Test 4: consent before re-routing ---------- */
async function testRerouteConsent() {
  const { window, stubs } = boot({ betterOnRecalc: true });
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(10);

  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(60);
  check('original route is 10 min', /10 min/.test(d.getElementById('rtSummary').textContent),
        d.getElementById('rtSummary').textContent);
  check('no prompt yet', !d.getElementById('reroute').classList.contains('show'));

  d.getElementById('navRecalc').click();
  await sleep(80);

  check('recalculate offers a prompt', d.getElementById('reroute').classList.contains('show'));
  const txt = d.getElementById('rerouteTxt').textContent;
  check('prompt asks permission', /Switch to it\?/.test(txt), txt);
  check('prompt states the saving', /saves 3 min/.test(txt), txt);
  check('route NOT switched without consent',
        /10 min/.test(d.getElementById('rtSummary').textContent),
        d.getElementById('rtSummary').textContent);

  d.getElementById('rerouteKeep').click();
  check('keeping hides the prompt', !d.getElementById('reroute').classList.contains('show'));
  check('keeping leaves the route alone',
        /10 min/.test(d.getElementById('rtSummary').textContent),
        d.getElementById('rtSummary').textContent);

  // Now accept it.
  d.getElementById('navRecalc').click();
  await sleep(80);
  d.getElementById('rerouteUse').click();
  check('accepting switches the route',
        /7 min/.test(d.getElementById('rtSummary').textContent),
        d.getElementById('rtSummary').textContent);
  check('prompt closed after accepting', !d.getElementById('reroute').classList.contains('show'));
}

/* ---------- Test 5: a route shared by someone else ---------- */
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
  check('vehicles follow the shared mode',
        d.querySelector('.mk .veh') ? d.querySelector('.mk .veh').dataset.g === 'foot' : true,
        d.querySelector('.mk .veh') && d.querySelector('.mk .veh').dataset.g);

  client._emit('message', 'x', Buffer.from(JSON.stringify({ t: 'route-clear', id: 'peer-9' })));
  await sleep(20);
  check('inbound clear empties the summary', d.getElementById('rtSummary').textContent === '');
  check('inbound clear empties the steps', d.getElementById('rtSteps').innerHTML === '');
}

/* ---------- Test 6: failure handling ---------- */
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
    await testAlternativeScoring();
    await testRerouteConsent();
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
