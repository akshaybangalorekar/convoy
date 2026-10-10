/* Headless logic test for Convoy's app.js using jsdom + stubbed L / mqtt.
 * Verifies the join -> live-message -> render -> leave path and demo mode. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra = '') =>
  results.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStubs(window) {
  const layer = () => {
    const o = {};
    ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds',
     'removeLayer', 'on', 'off', 'getZoom'].forEach((m) => { o[m] = () => o; });
    o.getZoom = () => 13;
    o.getElement = () => ({
      classList: { toggle() {}, add() {}, remove() {} },
      querySelector: () => null,
    });
    return o;
  };
  window.L = {
    map: layer, tileLayer: layer, marker: layer, polyline: layer,
    latLngBounds: layer, control: { zoom: () => ({ addTo: () => {} }) },
    divIcon: (o) => o,
  };

  const clients = [];
  window.mqtt = {
    connect(url, opts) {
      const handlers = {};
      const c = {
        url, opts, connected: false, published: [], subscribed: null,
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
        subscribe(t, o, cb) { c.subscribed = t; cb && cb(null); return c; },
        publish(t, m) { c.published.push(m); return c; },
        end() { c.ended = true; return c; },
        _emit(ev, ...a) { (handlers[ev] || []).forEach((f) => f(...a)); },
      };
      clients.push(c);
      return c;
    },
  };
  return { clients };
}

function boot(html, url = 'https://convoy.test/') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url });
  const { window } = dom;
  const stubs = makeStubs(window);
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) {
    window.crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; };
  }
  window.navigator.geolocation = {
    watchPosition: (ok) => { window.__fix = ok; return 1; },
    clearWatch() {},
  };
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  return { window, stubs };
}

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

/* ---------- Test 1: join flow + inbound live position ---------- */
function testJoin() {
  const { window, stubs } = boot(html);
  const d = window.document;

  check('join overlay visible on load', !d.getElementById('join').classList.contains('hidden'));

  d.getElementById('inName').value = 'Akshay';
  d.getElementById('inRoom').value = 'Goa Trip!!';
  d.getElementById('btnJoin').click();

  check('room normalised', d.getElementById('roomLabel').textContent === 'goa-trip',
        d.getElementById('roomLabel').textContent);
  check('panel shown after join', d.getElementById('panel').classList.contains('show'));
  check('join overlay hidden', d.getElementById('join').classList.contains('hidden'));
  check('hash carries room', window.location.hash.includes('r=goa-trip'), window.location.hash);

  const client = stubs.clients[0];
  check('mqtt client created', !!client);

  client.connected = true;
  client._emit('connect');                 // broker handshake
  check('subscribes to room topic',
        client.subscribed === 'sarvam-convoy/v1/goa-trip/bus', client.subscribed);
  check('status goes online', d.getElementById('status').className.includes('online'),
        d.getElementById('status').className);
  check('hello published on connect',
        client.published.some((m) => m.includes('"t":"hello"')), client.published.join('|'));

  window.__fix({ coords: { latitude: 15.5, longitude: 73.8, accuracy: 8, speed: 9, heading: 120 }, timestamp: Date.now() });
  check('publishes own position after GPS fix',
        client.published.some((m) => m.includes('"t":"pos"')));

  client._emit('message', 'sarvam-convoy/v1/goa-trip/bus',
    Buffer.from(JSON.stringify({ t: 'pos', id: 'peer-1', name: 'Priya', lat: 15.51, lng: 73.81, spd: 12, ts: Date.now() })));
  const list = d.getElementById('people').innerHTML;
  check('peer appears in people list', list.includes('Priya'));
  check('peer row shows a distance', /km|m\b/.test(list));
  check('people count updated', /2 people/.test(d.getElementById('peopleCount').textContent),
        d.getElementById('peopleCount').textContent);

  client._emit('message', 'x', Buffer.from(JSON.stringify({ t: 'bye', id: 'peer-1' })));
  check('peer removed on bye', !d.getElementById('people').innerHTML.includes('Priya'));

  d.getElementById('btnLeave').click();
  check('leave shows join overlay again', !d.getElementById('join').classList.contains('hidden'));
  check('client closed on leave', client.ended === true);
}

/* ---------- Test 2: demo mode ---------- */
async function testDemo() {
  const { window } = boot(html);
  const d = window.document;
  d.getElementById('btnDemo').click();

  check('demo hides overlay', d.getElementById('join').classList.contains('hidden'));
  check('demo room label', d.getElementById('roomLabel').textContent === 'demo');
  const list = d.getElementById('people').innerHTML;
  ['Priya', 'Rahul', 'Meera', 'Arjun'].forEach((n) =>
    check('demo car present: ' + n, list.includes(n)));
  check('demo shows 5 people', /5 people/.test(d.getElementById('peopleCount').textContent),
        d.getElementById('peopleCount').textContent);

  await sleep(1300);                        // let the animation tick
  check('demo animates (positions update)', d.getElementById('people').innerHTML !== list);

  d.getElementById('btnLeave').click();
  check('leaving demo clears cars', !d.getElementById('people').innerHTML.includes('Priya'));
}

/* ---------- Test 3: invite-link auto-join ---------- */
function testInvite() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'https://convoy.test/#r=goa-7f3k9' });
  const { window } = dom;
  makeStubs(window);
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) window.crypto.getRandomValues = (a) => a;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {} };
  window.localStorage.setItem('convoy.name', 'Meera');
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  check('invite link prefills room', window.document.getElementById('inRoom').value === 'goa-7f3k9');
  check('invite link auto-joins when name is known',
        window.document.getElementById('roomLabel').textContent === 'goa-7f3k9',
        window.document.getElementById('roomLabel').textContent);
}

/* ---------- Run ---------- */
(async () => {
  testJoin();
  await testDemo();
  testInvite();

  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
