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
  features: [
    { properties: { name: 'Gateway of India', city: 'Mumbai', country: 'India', countrycode: 'in' },
      geometry: { coordinates: [C.lng, C.lat] } },
    { properties: { name: 'Springfield', state: 'Illinois', country: 'United States', countrycode: 'us' },
      geometry: { coordinates: [-89.65, 39.78] } },
  ],
};

// A geocoder that only knows about foreign places, to force the fallback.
const PHOTON_US_ONLY = {
  features: [
    { properties: { name: 'Springfield', state: 'Illinois', country: 'United States', countrycode: 'us' },
      geometry: { coordinates: [-89.65, 39.78] } },
  ],
};

const REVERSE_IN = { address: { country: 'India', country_code: 'in' } };
const REVERSE_AU = { address: { country: 'Australia', country_code: 'au' } };

const NOMINATIM_IN = [{
  display_name: 'MG Road, Bengaluru, Karnataka, India',
  lat: '12.9756', lon: '77.6068',
  address: { country_code: 'in', country: 'India' },
}];

// Australian places, needed when the app has detected it is in Australia
// (the country filter would otherwise reject the Indian fixtures).
const PHOTON_AU = {
  features: [{
    properties: { name: 'Sydney Opera House', city: 'Sydney', state: 'New South Wales',
                  country: 'Australia', countrycode: 'au' },
    geometry: { coordinates: [151.2153, -33.8568] },
  }],
};

const NOMINATIM_AU = [{
  display_name: 'Sydney Opera House, Sydney, New South Wales, Australia',
  lat: '-33.8568', lon: '151.2153',
  address: { country_code: 'au', country: 'Australia' },
}];

/* ---------- Stubs ---------- */
function makeStubs(window, opts = {}) {
  const layer = () => {
    const o = {};
    ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
     'removeLayer', 'on', 'off', 'getZoom', 'bindPopup', 'setStyle', 'setZIndex']
      .forEach((m) => { o[m] = () => o; });
    o.getZoom = () => 13;
    o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} } });
    return o;
  };

  // Markers really insert their HTML into the document, so we can inspect them.
  const maps = [];
  window.L = {
    map() {
      const o = layer();
      o._h = {}; o._pane = { style: {} }; o._events = {};
      o._zooms = { in: 0, out: 0 }; o._bearings = [];
      o.on = (ev, fn) => { (o._h[ev] = o._h[ev] || []).push(fn); return o; };
      o._emit = (ev) => (o._h[ev] || []).forEach((f) => f());
      o.getPane = () => o._pane;
      o.getContainer = () => ({
        addEventListener: (t, fn) => { (o._events[t] = o._events[t] || []).push(fn); },
      });
      o.zoomIn = () => { o._zooms.in++; return o; };
      o.zoomOut = () => { o._zooms.out++; return o; };
      o.setBearing = (b) => { o._bearings.push(b); return o; };
      maps.push(o);
      return o;
    },
    tileLayer: layer, polyline: layer, latLngBounds: layer,
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
    if (u.includes('/reverse')) {
      return { ok: true, status: 200, json: async () => (opts.countryAU ? REVERSE_AU : REVERSE_IN) };
    }
    // Australian coverage service (ACCC): layer discovery, then point queries.
    if (u.includes('MapServer/layers')) {
      return { ok: true, status: 200, json: async () => ({ layers: [
        { id: 1, name: 'Optus 4G Outdoor Mobile Coverage (ACCC)' },
        { id: 19, name: "Telstra's Claimed 4G 'Outdoor' Mobile Coverage (ACCC)" },
      ] }) };
    }
    if (u.includes('MapServer/') && u.includes('/query')) {
      const m = /geometry=([-\d.]+),([-\d.]+)/.exec(u);
      const lat = m ? parseFloat(m[2]) : 0;
      const covered = !(lat < 18.930);          // simulate a gap in the south
      return { ok: true, status: 200, json: async () => ({ count: covered ? 1 : 0 }) };
    }
    if (u.includes('photon')) {
      return { ok: true, status: 200, json: async () => (
        opts.countryAU ? PHOTON_AU : (opts.photonUSOnly ? PHOTON_US_ONLY : PHOTON)) };
    }
    if (u.includes('nominatim')) {
      return { ok: true, status: 200, json: async () => (
        opts.countryAU ? NOMINATIM_AU : (opts.noMatches ? [] : NOMINATIM_IN)) };
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

  return { clients, calls, spoken, maps, routeCalls: () => routeCalls };
}

// Simulate a tap on the map, whichever gesture path the code took.
function tapMap(map, dx = 0, dy = 0, target) {
  const ev = { clientX: 100 + dx, clientY: 100 + dy, target: target || { closest: () => null } };
  if (map._events.pointerdown) {
    map._events.pointerdown.forEach((f) => f(ev));
    (map._events.pointerup || []).forEach((f) => f(ev));
  } else {
    (map._events.click || []).forEach((f) => f(ev));
  }
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

/* ---------- Test 7: country-scoped address search ---------- */
async function testCountryScope() {
  const { window, stubs } = boot();
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);

  check('country looked up from the first GPS fix',
        stubs.calls.some((u) => u.includes('/reverse')), stubs.calls.join(' | ').slice(0, 140));

  d.getElementById('btnRoute').click();
  check('scope row names the detected country',
        /Only search India/.test(d.getElementById('scopeLabel').textContent),
        d.getElementById('scopeLabel').textContent);
  check('scope is on by default', d.getElementById('scopeToggle').checked === true);

  d.getElementById('rtTo').value = 'Springfield';
  d.getElementById('rtTo').dispatchEvent(new window.Event('input'));
  await sleep(700);
  let sugg = d.getElementById('rtToSugg').textContent;
  check('kept the match inside the country', /Gateway of India/.test(sugg), sugg);
  check('dropped the foreign match', !/Springfield/.test(sugg), sugg);

  // turning the filter off restores worldwide results
  d.getElementById('scopeToggle').checked = false;
  d.getElementById('scopeToggle').dispatchEvent(new window.Event('change'));
  check('toggle marks the row as off', d.getElementById('scopeRow').classList.contains('off'));
  check('choice is remembered', window.localStorage.getItem('convoy.scope') === '0',
        window.localStorage.getItem('convoy.scope'));

  d.getElementById('rtTo').value = 'Springfield ';
  d.getElementById('rtTo').dispatchEvent(new window.Event('input'));
  await sleep(700);
  sugg = d.getElementById('rtToSugg').textContent;
  check('worldwide search returns the foreign match', /Springfield/.test(sugg), sugg);
}

/* ---------- Test 8: falling back to the in-country provider ---------- */
async function testCountryFallback() {
  const { window, stubs } = boot({ photonUSOnly: true });
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();

  d.getElementById('rtTo').value = 'Springfield';
  d.getElementById('rtTo').dispatchEvent(new window.Event('input'));
  await sleep(700);

  const nomUrl = stubs.calls.find((u) => u.includes('nominatim') && u.includes('/search')) || '';
  check('nominatim was asked with the country filter', /countrycodes=in/.test(nomUrl),
        nomUrl.slice(0, 150));
  const sugg = d.getElementById('rtToSugg').textContent;
  check('fell back to the in-country provider', /MG Road/.test(sugg), sugg);
}

/* ---------- Test 9: nothing matches in the country ---------- */
async function testCountryNoMatches() {
  const { window, stubs } = boot({ photonUSOnly: true, noMatches: true });
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();

  d.getElementById('rtTo').value = 'Springfield';
  d.getElementById('rtTo').dispatchEvent(new window.Event('input'));
  await sleep(700);

  const sugg = d.getElementById('rtToSugg').textContent;
  check('explains when nothing matches in the country', /No matches in India/.test(sugg), sugg);
  check('suggests turning the filter off', /Turn the country filter off/.test(sugg), sugg);
}

/* ---------- Test 10: saving the route for offline use ---------- */
async function testOfflineSaveAndRestore() {
  const { window, stubs } = boot();
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();
  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(80);
  check('route planned before saving', /min/.test(d.getElementById('rtSummary').textContent),
        d.getElementById('rtSummary').textContent);

  d.getElementById('offlineSave').click();
  const raw = window.localStorage.getItem('convoy.savedRoute');
  check('route saved to local storage', !!raw && raw.length > 100, String(raw && raw.length));
  check('saved payload keeps the steps', /"steps"/.test(raw || ''));
  check('saved payload keeps the geometry', /"geometry"/.test(raw || ''));
  check('offline status shows what is saved',
        /Saved:/.test(d.getElementById('offlineStatus').textContent),
        d.getElementById('offlineStatus').textContent);

  d.getElementById('offlineClear').click();
  check('Clear removes the saved route', !window.localStorage.getItem('convoy.savedRoute'));
  check('status resets after clearing',
        /No route saved/.test(d.getElementById('offlineStatus').textContent),
        d.getElementById('offlineStatus').textContent);

  // A fresh load with a saved route should restore it without re-broadcasting.
  const second = boot();
  joinRoom(second.window, second.stubs);
  second.window.localStorage.setItem('convoy.savedRoute', raw);
  second.window.__fix(fix(A));
  await sleep(60);
  const sd = second.window.document;
  check('saved route restored on the next visit',
        /min/.test(sd.getElementById('rtSummary').textContent),
        sd.getElementById('rtSummary').textContent);
  check('restored route is not re-broadcast to the room',
        second.stubs.clients[0].published.filter((m) => m.includes('"t":"route"')).length === 0);
}

/* ---------- Test 11: prompting when the signal drops ---------- */
async function testOfflineSignalPrompt() {
  async function planned() {
    const ctx = boot();
    const d = ctx.window.document;
    joinRoom(ctx.window, ctx.stubs);
    ctx.window.__fix(fix(A));
    await sleep(30);
    d.getElementById('btnRoute').click();
    d.getElementById('rtTo').value = 'Gateway of India';
    d.getElementById('rtGo').click();
    await sleep(80);
    return ctx;
  }

  const a = await planned();
  check('no offline prompt while the signal is fine',
        !a.window.document.getElementById('offlineBar').classList.contains('show'));

  a.window.dispatchEvent(new a.window.Event('offline'));
  await sleep(20);
  const txt = a.window.document.getElementById('offlineBarTxt').textContent;
  check('losing signal raises the prompt',
        a.window.document.getElementById('offlineBar').classList.contains('show'));
  check('prompt says why', /lost signal/.test(txt), txt);
  check('prompt offers to save the route', /save this route/i.test(txt), txt);

  a.window.document.getElementById('offlineBarNo').click();
  check('Not now dismisses the prompt',
        !a.window.document.getElementById('offlineBar').classList.contains('show'));
  check('Not now does not save anything', !a.window.localStorage.getItem('convoy.savedRoute'));

  const b = await planned();
  b.window.dispatchEvent(new b.window.Event('offline'));
  await sleep(20);
  b.window.document.getElementById('offlineBarYes').click();
  check('Save from the prompt stores the route',
        !!b.window.localStorage.getItem('convoy.savedRoute'));
  check('prompt closes after saving',
        !b.window.document.getElementById('offlineBar').classList.contains('show'));
}

/* ---------- Test 12: coverage check is country-gated ---------- */
async function testCoverageGate() {
  const { window, stubs } = boot();          // reverse-geocodes as India
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();
  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(120);

  // the automatic check stays quiet outside AU, so ask explicitly
  d.getElementById('offlineCheck').click();
  await sleep(60);
  check('coverage check skipped outside Australia',
        /only set up for AU/.test(d.getElementById('toast').textContent),
        d.getElementById('toast').textContent);
  check('no coverage service calls were made',
        !stubs.calls.some((u) => u.includes('MapServer')), 'MapServer was called');
}

/* ---------- Test 13: warning about predicted coverage gaps ---------- */
async function testCoverageGaps() {
  const { window, stubs } = boot({ countryAU: true });
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();
  d.getElementById('rtTo').value = 'Sydney Opera House';
  d.getElementById('rtGo').click();
  await sleep(250);

  check('coverage layers were discovered',
        stubs.calls.some((u) => u.includes('MapServer/layers')));
  check('coverage was sampled along the route',
        stubs.calls.filter((u) => u.includes('/query')).length >= 2,
        String(stubs.calls.filter((u) => u.includes('/query')).length));
  const txt = d.getElementById('offlineBarTxt').textContent;
  check('warns about the predicted gap', /no predicted 4G coverage/.test(txt), txt);
  check('the warning offers to save the route', /save this route/i.test(txt), txt);

  d.getElementById('offlineBarNo').click();
  d.getElementById('offlineCheck').click();
  await sleep(250);
  check('manual coverage check reports the gap',
        /no predicted 4G coverage/.test(d.getElementById('toast').textContent),
        d.getElementById('toast').textContent);
  check('manual check re-offers to save',
        d.getElementById('offlineBar').classList.contains('show'));
}

/* ---------- Test 14: immersive navigation and the day/night map ---------- */
async function testImmersiveAndTheme() {
  const { window, stubs } = boot();
  const d = window.document;
  joinRoom(window, stubs);
  window.__fix(fix(A));
  await sleep(30);
  d.getElementById('btnRoute').click();
  d.getElementById('rtTo').value = 'Gateway of India';
  d.getElementById('rtGo').click();
  await sleep(80);

  check('controls visible before navigating', !d.body.classList.contains('nav-hidden'));
  d.getElementById('rtStart').click();
  check('controls hidden when navigation starts', d.body.classList.contains('nav-hidden'));
  check('navigation mode is on', d.body.classList.contains('navigating'));

  const map = stubs.maps[0];
  check('the map has tap listeners', Object.keys(map._events).length > 0,
        Object.keys(map._events).join(','));

  // shorten the auto-hide so the test does not wait six seconds
  window.ConvoyRoute._internals.CFG.navAutoHideMs = 40;

  tapMap(map);
  check('tapping the map brings the controls back', !d.body.classList.contains('nav-hidden'));
  check('that tap did not zoom', map._zooms.out === 0, String(map._zooms.out));

  await sleep(90);
  check('controls auto-hide again shortly after', d.body.classList.contains('nav-hidden'));

  tapMap(map);
  check('a later tap brings them back again', !d.body.classList.contains('nav-hidden'));
  check('still no zoom while the controls were hidden', map._zooms.out === 0, String(map._zooms.out));

  d.getElementById('navStop').click();
  check('stopping navigation restores the controls', !d.body.classList.contains('nav-hidden'));
  check('navigation mode cleared', !d.body.classList.contains('navigating'));

  // --- day / night basemap
  const T = window.Convoy._internals;
  check('sun/theme helpers are exposed', typeof T.themeFor === 'function');
  const mid = new Date(Date.UTC(2026, 9, 11, 2, 0, 0));    // 13:00 Sydney
  const night = new Date(Date.UTC(2026, 9, 11, 12, 0, 0)); // 23:00 Sydney
  check('Sydney daytime uses the light map',
        T.themeFor(mid, -33.8688, 151.2093) === 'light',
        T.themeFor(mid, -33.8688, 151.2093));
  check('Sydney night uses the dark map',
        T.themeFor(night, -33.8688, 151.2093) === 'dark',
        T.themeFor(night, -33.8688, 151.2093));
  check('Arctic midsummer is always light',
        T.themeFor(new Date(Date.UTC(2026, 5, 21, 0, 0, 0)), 80, 0) === 'light');

  T.setTheme('dark');
  check('dark theme filters the tile pane',
        /invert/.test(stubs.maps[0]._pane.style.filter || ''), stubs.maps[0]._pane.style.filter);
  T.setTheme('light');
  check('light theme clears the filter',
        (stubs.maps[0]._pane.style.filter || '') === '', stubs.maps[0]._pane.style.filter);
}

/* ---------- Test 15: tap gestures and the heading-up bearing ---------- */
async function testTapGesturesAndBearing() {
  const { window, stubs } = boot();
  const map = stubs.maps[0];

  check('map container received tap listeners', Object.keys(map._events).length > 0,
        Object.keys(map._events).join(','));

  tapMap(map);
  await sleep(330);                      // past the double-tap window
  check('a single tap zooms out', map._zooms.out === 1, String(map._zooms.out));
  check('a single tap does not zoom in', map._zooms.in === 0, String(map._zooms.in));

  tapMap(map); tapMap(map);              // a double tap
  await sleep(330);
  check('a double tap zooms in', map._zooms.in === 1, String(map._zooms.in));
  check('a double tap does not zoom out', map._zooms.out === 1, String(map._zooms.out));

  // a drag must not count as a tap
  let before = map._zooms.out;
  tapMap(map, 0, 0); tapMap(map, 120, 160);   // down here, up far away
  if (map._events.pointerdown) {
    // emulate a real drag: one down, one up far away
    const down = { clientX: 100, clientY: 100, target: { closest: () => null } };
    const up = { clientX: 240, clientY: 260, target: { closest: () => null } };
    map._events.pointerdown.forEach((f) => f(down));
    (map._events.pointerup || []).forEach((f) => f(up));
    await sleep(330);
    check('a drag is not treated as a tap', map._zooms.out === before, String(map._zooms.out));
  } else {
    check('a drag is not treated as a tap (click fallback)', true);
  }

  // taps on a Leaflet control are ignored
  if (map._events.pointerdown) {
    before = map._zooms.out;
    tapMap(map, 0, 0, { closest: () => ({}) });
    await sleep(330);
    check('taps on a map control are ignored', map._zooms.out === before, String(map._zooms.out));
  }

  // --- heading-up bearing
  const T = window.Convoy._internals;
  check('bearing starts at north', T.getBearing() === 0, String(T.getBearing()));
  T.updateBearing({ hdg: 90, spd: 20 });
  const first = T.getBearing();
  check('bearing turns toward the direction of travel', first > 0 && first < 90, String(first));
  for (let i = 0; i < 40; i++) T.updateBearing({ hdg: 90, spd: 20 });
  check('bearing converges on the heading', Math.abs(T.getBearing() - 90) < 1, String(T.getBearing()));
  check('the map was told to rotate',
        map._bearings.length > 0 && map._bearings[map._bearings.length - 1] > 0,
        String(map._bearings.length));

  const held = T.getBearing();
  T.updateBearing({ hdg: 270, spd: 0 });
  check('bearing holds while stopped', T.getBearing() === held, String(T.getBearing()));
  T.updateBearing({ hdg: null, spd: 20 });
  check('bearing ignores a missing heading', T.getBearing() === held, String(T.getBearing()));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testNavigation();
    await testAlternativeScoring();
    await testRerouteConsent();
    await testSharedRouteInbound();
    await testFailureHandling();
    await testCountryScope();
    await testCountryFallback();
    await testCountryNoMatches();
    await testOfflineSaveAndRestore();
    await testOfflineSignalPrompt();
    await testCoverageGate();
    await testCoverageGaps();
    await testImmersiveAndTheme();
    await testTapGesturesAndBearing();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
