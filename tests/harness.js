/* Shared test harness: a jsdom page with Leaflet, MQTT, fetch, geolocation,
 * notifications and WebRTC stubbed out, running the real app.js and route.js. */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const checks = [];
const check = (name, cond, extra = '') => checks.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function layer() {
  const o = {};
  ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
   'extend', 'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup',
   'setZIndex', 'setIcon', 'getElement']
    .forEach((m) => { o[m] = () => o; });
  o.getZoom = () => 13;
  o.getPane = () => ({ style: {} });
  o.getContainer = () => ({ addEventListener: () => {} });
  o.getElement = () => null;
  return o;
}

function makeMap() {
  const calls = { fitBounds: [], setView: [], panTo: [], zoomIn: 0, zoomOut: 0 };
  const handlers = {};
  const m = layer();
  m.fitBounds = (b, o) => { calls.fitBounds.push(o || {}); return m; };
  m.setView = (c, z, o) => { calls.setView.push([c, z, o || {}]); return m; };
  m.panTo = (c, o) => { calls.panTo.push(c); return m; };
  m.zoomIn = () => { calls.zoomIn++; return m; };
  m.zoomOut = () => { calls.zoomOut++; return m; };
  m.on = (ev, fn) => {
    String(ev).split(/\s+/).forEach((e) => { (handlers[e] = handlers[e] || []).push(fn); });
    return m;
  };
  m.fire = (ev, arg) => { (handlers[ev] || []).forEach((fn) => fn(arg)); };
  return { m, calls, handlers };
}

function makeStream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { _track: track, getAudioTracks: () => [track], getTracks: () => [track] };
}

/**
 * opts.setup(window)  — runs after route.js is loaded, before app.js boots
 *                      (use it to pre-seed localStorage)
 * opts.fetch(url, opts) — replaces the network stub
 */
function boot(opts = {}) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://convoy.test/',
  });
  const { window } = dom;
  const { m: mapObj, calls, handlers: mapHandlers } = makeMap();
  const container = window.document.createElement('div');
  container.className = 'leaflet-container';
  window.document.body.appendChild(container);
  mapObj.getContainer = () => container;

  window.L = {
    map: () => mapObj,
    tileLayer: () => ({ addTo: () => ({}) }),
    polyline: layer, latLngBounds: layer,
    control: { zoom: () => ({ addTo: () => {} }) },
    divIcon: (o) => o, marker: layer,
  };

  const clients = [];
  window.mqtt = {
    connect(url) {
      const h = {};
      const c = {
        url, connected: false, published: [], subscribed: null, ended: false,
        on(e, f) { (h[e] = h[e] || []).push(f); return c; },
        subscribe(t, o, cb) { c.subscribed = t; if (cb) cb(null); return c; },
        publish(t, msg) { c.published.push(msg); return c; },
        end() { c.ended = true; return c; },
        _emit(e, ...a) { (h[e] || []).forEach((f) => f(...a)); },
        connect_() { c.connected = true; c._emit('connect'); },
      };
      clients.push(c);
      return c;
    },
  };

  const netCalls = [];
  window.fetch = async (url, o) => {
    netCalls.push({ url, method: (o && o.method) || 'GET' });
    if (opts.fetch) return opts.fetch(url, o);
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const notes = [];
  function FakeNotification(title, o) { notes.push({ title, body: (o && o.body) || '' }); }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = async () => 'granted';
  window.Notification = FakeNotification;

  window.speechSynthesis = { speak() {}, cancel() {} };
  window.SpeechSynthesisUtterance = function () {};
  if (!window.crypto || !window.crypto.getRandomValues) {
    Object.defineProperty(window, 'crypto', {
      configurable: true, value: { getRandomValues: (a) => a },
    });
  }

  const geo = { ok: null, err: null, watchId: 0 };
  window.navigator.geolocation = {
    watchPosition(ok, err) { geo.ok = ok; geo.err = err; geo.watchId++; return geo.watchId; },
    clearWatch() {},
  };

  const def = (obj, key, value) => Object.defineProperty(obj, key, {
    configurable: true, writable: true, value,
  });
  def(window.navigator, 'mediaDevices', { getUserMedia: async () => makeStream() });
  def(window.navigator, 'vibrate', () => true);
  def(window.navigator, 'share', undefined);
  def(window.navigator, 'clipboard', { writeText: async () => {} });
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

  window.eval(fs.readFileSync(path.join(DIR, 'route.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'install.js'), 'utf8'));
  if (opts.setup) opts.setup(window);
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));

  const api = {
    window,
    document: window.document,
    calls,
    container,
    mapHandlers,
    clients,
    netCalls,
    notes,
    geo,

    /** Fire a Leaflet map event, as the user dragging or zooming would. */
    mapFire(ev, arg) { (mapHandlers[ev] || []).forEach((fn) => fn(arg)); },

    /** Fire the browser's install prompt, as Chrome does when the app is installable. */
    installPrompt(outcome) {
      const e = new window.Event('beforeinstallprompt');
      const seen = { prompted: false };
      Object.defineProperty(e, 'prompt', { configurable: true, value: () => { seen.prompted = true; } });
      Object.defineProperty(e, 'userChoice', {
        configurable: true, value: Promise.resolve({ outcome: outcome || 'accepted' }),
      });
      window.dispatchEvent(e);
      return seen;
    },

    /** Fill in the join card and press the button. */
    join(name, room) {
      const d = window.document;
      d.getElementById('inName').value = name;
      d.getElementById('inRoom').value = room || '';
      d.getElementById('btnGo').click();
      const c = clients[clients.length - 1];
      if (c) c.connect_();
      return c;
    },

    /** Deliver a geolocation fix. */
    fix(lat, lng, extra = {}) {
      if (!geo.ok) return;
      geo.ok({
        coords: Object.assign({ latitude: lat, longitude: lng, accuracy: 8, speed: 12, heading: 90 }, extra),
        timestamp: Date.now(),
      });
    },

    /** Report a geolocation failure, as the browser would. */
    geoError(code) { if (geo.err) geo.err({ code: code || 1 }); },

    /** Feed a message into the room, as if another phone sent it. */
    recv(msg) {
      const c = clients[clients.length - 1];
      if (c) c._emit('message', 'x', Buffer.from(JSON.stringify(msg)));
    },

    /** The last message of a given type this phone published. */
    sent(t) {
      const c = clients[clients.length - 1];
      if (!c) return null;
      const m = c.published.filter((x) => x.indexOf('"t":"' + t + '"') >= 0);
      return m.length ? JSON.parse(m[m.length - 1]) : null;
    },

    sentAll(t) {
      const c = clients[clients.length - 1];
      if (!c) return [];
      return c.published.filter((x) => x.indexOf('"t":"' + t + '"') >= 0).map((x) => JSON.parse(x));
    },
  };
  return api;
}

const pos = (id, name, lat, lng) => ({
  t: 'pos', id, name, lat, lng, spd: 10, hdg: 90, acc: 6, ts: Date.now(),
});

function finish(label) {
  const failed = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(
    `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  <-- ' + c.extra}`));
  console.log(`\n${label ? label + ': ' : ''}${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

function crash(e) {
  checks.push({ name: 'suite crashed: ' + e.message, ok: false,
                extra: e.stack ? String(e.stack).split('\n')[1] : '' });
}

module.exports = { boot, check, sleep, pos, finish, crash, DIR, layer, makeStream };
