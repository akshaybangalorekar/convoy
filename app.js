/* Convoy — live group map
 * No backend, no accounts. Positions are broadcast over a public MQTT
 * broker (WebSocket) and drawn on an OpenStreetMap / Leaflet map.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */
const CFG = {
  topicPrefix: 'sarvam-convoy/v1',
  // Public, no-signup MQTT brokers over WebSocket. Tried in order.
  brokers: [
    { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/' },
  ],
  publishMs: 5000,          // broadcast our position at least this often
  staleMs: 90000,           // peer fades after 90s of silence
  dropMs: 10 * 60 * 1000,   // peer removed after 10 min of silence
  maxTrail: 60,             // breadcrumb points kept per person
  minMoveM: 12,             // publish early if we moved this far
  fallbackCenter: { lat: 12.9716, lng: 77.5946 }, // Bengaluru
  fallbackZoom: 13,

  /* Day / night basemap. Dark after sunset, light after sunrise. */
  theme: {
    auto: true,
    checkMs: 300000,      // re-evaluate every 5 minutes
    light: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      filter: null,
    },
    dark: {
      // OSM's standard tiles are the only keyless raster source, so the night map
      // is those same tiles darkened by a CSS filter. Point `url` at a real dark
      // basemap (CARTO Dark Matter, Stadia, self-hosted) and set filter:null to
      // get a proper night map — those need an API key.
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      filter: 'invert(1) hue-rotate(180deg) brightness(.92) contrast(.92) saturate(.6)',
    },
  },

  /* Tap gestures on the map: one tap zooms out, a double tap zooms in. */
  tapZoom: { enabled: true, delayMs: 260, moveTolerancePx: 12 },
  /* Keep the map aligned with the direction of travel (heading-up). */
  bearing: { enabled: true, minSpeedMps: 0.8, lerp: 0.25 },
};

const PALETTE = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8',
                 '#ff922b', '#20c997', '#f783ac', '#5c7cfa', '#94d82d'];

/* Top-down vehicle glyphs. They draw with currentColor, so each one
 * inherits its owner's colour, and rotate to match their heading. */
const GLYPHS = {
  car:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M8 2.6c-1.9 0-3.4 1.5-3.4 3.4v12c0 1.9 1.5 3.4 3.4 3.4h8c1.9 0 3.4-1.5 3.4-3.4V6c0-1.9-1.5-3.4-3.4-3.4z" ' +
        'fill="currentColor" stroke="#0b1220" stroke-width="1.3"/>' +
      '<rect x="8.3" y="4.7" width="7.4" height="2.5" rx="1.1" fill="#dbe7ff" opacity=".9"/>' +
      '<path d="M6.7 8.7h10.6M6.7 15.3h10.6" stroke="#0b1220" stroke-width="1.1" opacity=".45"/>' +
    '</svg>',
  bike:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="5.9" r="2.7" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="12" cy="18.1" r="2.7" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M12 8.6v6.8M8.9 11.7h6.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>' +
    '</svg>',
  foot:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="7.5" r="3.2" fill="currentColor" stroke="#0b1220" stroke-width="1.2"/>' +
      '<path d="M12 11.4c-2.7 0-4.6 1.9-4.6 4.7V20h9.2v-3.9c0-2.8-1.9-4.7-4.6-4.7z" ' +
        'fill="currentColor" stroke="#0b1220" stroke-width="1.2"/>' +
    '</svg>',
};

let vehicleGlyph = 'car';   // follows the room's route mode

function glyphMarkup() {
  return '<div class="veh" data-g="' + vehicleGlyph + '"><div class="veh-rot">' +
    '<span class="g g-car">' + GLYPHS.car + '</span>' +
    '<span class="g g-bike">' + GLYPHS.bike + '</span>' +
    '<span class="g g-foot">' + GLYPHS.foot + '</span>' +
  '</div></div>';
}

function setVehicle(mode) {
  vehicleGlyph = (mode === 'bike') ? 'bike' : (mode === 'foot') ? 'foot' : 'car';
  document.querySelectorAll('.mk .veh').forEach((v) => { v.dataset.g = vehicleGlyph; });
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function colorFor(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

// Two ids can hash to the same colour, so hand out unique ones instead. Your own car
// always takes the first colour; everyone else takes their preferred colour, or the next
// free one when that is taken. Every phone computes the same assignment, so a car looks
// the same on every screen.
function assignColors() {
  const taken = new Set();
  let changed = false;
  const give = (p, preferred) => {
    let c = preferred;
    if (taken.has(c)) {
      const start = Math.max(0, PALETTE.indexOf(c));
      for (let k = 1; k <= PALETTE.length; k++) {
        const cand = PALETTE[(start + k) % PALETTE.length];
        if (!taken.has(cand)) { c = cand; break; }
      }
    }
    taken.add(c);
    if (p.color !== c) { p.color = c; changed = true; }
  };
  if (state.me) give(state.me, PALETTE[0]);
  else taken.add(PALETTE[0]);
  Array.from(state.peers.values())
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((p) => give(p, colorFor(p.id)));
  return changed;
}

// Repaint everything if the unique-colour pass moved anyone.
function refreshColors() {
  if (!assignColors()) return;
  allPeople().forEach((p) => {
    if (p._marker) p._marker.setIcon(makeIcon(p));
    if (p._line) p._line.setStyle({ color: p.color });
  });
  renderPeople();
}
function rand(n) {
  const a = new Uint8Array(n); (crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n);
}
function haversine(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b) {
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
            Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
  return (Math.atan2(y, x) * toDeg + 360) % 360;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

function fmtDist(m) {
  if (m == null) return '—';
  if (m < 950) return Math.round(m / 10) * 10 + ' m';
  const km = m / 1000;
  return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
}
function fmtSpeed(mps) {
  if (mps == null || isNaN(mps)) return null;
  return Math.round(mps * 3.6) + ' km/h';
}
function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 10) return 'live';
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function normRoom(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  me: null,           // { id, name, color, lat, lng, spd, hdg, acc, ts, trail, _marker, _line, isMe:true }
  peers: new Map(),   // id -> peer record (same shape, isMe:false)
  room: null,
  topic: null,
  joined: false,
  demo: false,
  follow: false,
  autoFit: true,      // keep every car in view until the user takes control
  wakeLock: null,
  lastPublish: 0,
  lastSentFix: null,
};

let map = null;
let client = null;
let brokerIdx = 0;
let reconnectTimer = null;
let publishTimer = null;
let renderTimer = null;
let demoTimer = null;
let lastAutoView = 0;   // when we last moved the map ourselves — guards the drag/zoom
let lastFitAt = 0;      // listeners against mistaking our own move for the user's
const AUTOFIT_MS = 4000;

// Hooks that route.js plugs into (see the bridge at the bottom of this file).
const hooks = { onRoute: null, onRouteClear: null, tick: null, onFix: null, tap: null,
                onVoice: null, onLeave: null };

const LS = {
  name: 'convoy.name',
  room: 'convoy.room',
  cid: 'convoy.cid',
};

/* ------------------------------------------------------------------ *
 * Sunrise / sunset (NOAA algorithm) and the day-night basemap
 * ------------------------------------------------------------------ */
const RAD = Math.PI / 180, DEG = 180 / Math.PI;

function sunTimes(date, lat, lng) {
  const y = date.getFullYear(), mo = date.getMonth() + 1, dy = date.getDate();
  const jd = Date.UTC(y, mo - 1, dy) / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;

  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const ecc = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
            Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = (L0 + C) - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const e0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obl = e0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(obl * RAD) * Math.sin(lambda * RAD)) * DEG;

  const yv = Math.tan(obl * RAD / 2) ** 2;
  const eqTime = 4 * DEG * (
      yv * Math.sin(2 * L0 * RAD)
    - 2 * ecc * Math.sin(Mr)
    + 4 * ecc * yv * Math.sin(Mr) * Math.cos(2 * L0 * RAD)
    - 0.5 * yv * yv * Math.sin(4 * L0 * RAD)
    - 1.25 * ecc * ecc * Math.sin(2 * Mr));

  const latR = lat * RAD, decR = decl * RAD;
  const cosHA = Math.cos(90.833 * RAD) / (Math.cos(latR) * Math.cos(decR)) -
                Math.tan(latR) * Math.tan(decR);
  const base = Date.UTC(y, mo - 1, dy);
  const noonMin = 720 - 4 * lng - eqTime;
  const noon = new Date(base + noonMin * 60000);

  if (cosHA > 1) return { polar: 'night', sunrise: null, sunset: null, noon };
  if (cosHA < -1) return { polar: 'day', sunrise: null, sunset: null, noon };

  const HA = Math.acos(cosHA) * DEG;
  return {
    polar: null, noon,
    sunrise: new Date(base + (noonMin - 4 * HA) * 60000),
    sunset: new Date(base + (noonMin + 4 * HA) * 60000),
  };
}

// Pure: which basemap should be showing at this moment and place?
function themeFor(date, lat, lng) {
  const t = sunTimes(date, lat, lng);
  if (t.polar === 'day') return 'light';
  if (t.polar === 'night') return 'dark';
  const now = date.getTime();
  return (now < t.sunrise.getTime() || now >= t.sunset.getTime()) ? 'dark' : 'light';
}

let currentTiles = null;
let themeMode = 'light';
let lastThemeCheck = 0;

function setTheme(mode) {
  if (!map) return;
  const cfg = CFG.theme[mode] || CFG.theme.light;
  themeMode = mode;
  if (currentTiles) { map.removeLayer(currentTiles); currentTiles = null; }
  currentTiles = L.tileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution }).addTo(map);
  currentTiles.setZIndex(0);
  // Filter only the tile pane, so routes, trails and markers stay crisp.
  const pane = map.getPane('tilePane');
  if (pane) pane.style.filter = cfg.filter || '';
}

function applyTheme() {
  const override = (location.search.match(/[?&]theme=(dark|light)/) || [])[1];
  const me = state.me;
  if (me && me.lat != null) {
    setTheme(override || themeFor(new Date(), me.lat, me.lng));
  } else {
    // No fix yet: fall back to the local clock.
    const h = new Date().getHours();
    setTheme(override || ((h >= 19 || h < 6) ? 'dark' : 'light'));
  }
}

function maybeUpdateTheme() {
  const now = Date.now();
  if (now - lastThemeCheck < 60000) return;
  lastThemeCheck = now;
  applyTheme();
}

/* ------------------------------------------------------------------ *
 * Tap gestures and the heading-up bearing
 * ------------------------------------------------------------------ */
let tapTimer = null;

function onMapTap() {
  // While the driving controls are hidden, a tap just brings them back.
  if (document.body.classList.contains('nav-hidden')) {
    if (hooks.tap) hooks.tap();
    return;
  }
  if (!CFG.tapZoom.enabled) return;
  if (tapTimer) {                       // second tap of a double tap
    clearTimeout(tapTimer); tapTimer = null;
    map.zoomIn();
    return;
  }
  tapTimer = setTimeout(() => {
    tapTimer = null;
    map.zoomOut();
  }, CFG.tapZoom.delayMs);
}

function wireTapGestures(container) {
  let down = null;
  const inControl = (e) => !!(e.target && e.target.closest && e.target.closest('.leaflet-control'));
  const onDown = (e) => {
    down = inControl(e) ? null : { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onUp = (e) => {
    const d = down; down = null;
    if (!d || inControl(e)) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CFG.tapZoom.moveTolerancePx) return; // a drag
    if (Date.now() - d.t > 700) return;                                                   // a long press
    onMapTap();
  };
  if (window.PointerEvent) {
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', () => { down = null; });
  } else {
    container.addEventListener('click', onMapTap);
  }
}

let mapBearing = 0;

// Rotate the map so the direction of travel points up. Holds the last bearing
// when stopped, so it doesn't snap back to north at every red light.
function updateBearing(me) {
  if (!CFG.bearing.enabled || !map || typeof map.setBearing !== 'function') return;
  if (!me || me.hdg == null || isNaN(me.hdg)) return;
  if (me.spd != null && me.spd < CFG.bearing.minSpeedMps) return;
  const diff = ((me.hdg - mapBearing + 540) % 360) - 180;   // shortest signed turn
  mapBearing = (mapBearing + diff * CFG.bearing.lerp + 360) % 360;
  try { map.setBearing(mapBearing); } catch (e) { /* plugin unavailable */ }
}

/* ------------------------------------------------------------------ *
 * Map
 * ------------------------------------------------------------------ */
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    doubleClickZoom: false,   // tap gestures are handled below
    rotate: true,             // honoured by leaflet-rotate, ignored without it
    bearing: 0,
    touchRotate: false,
  }).setView([CFG.fallbackCenter.lat, CFG.fallbackCenter.lng], CFG.fallbackZoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setTheme((new Date().getHours() >= 19 || new Date().getHours() < 6) ? 'dark' : 'light');
  wireTapGestures(map.getContainer());
  // Dragging or zooming by hand hands the view back to you.
  map.on('dragstart zoomstart', () => {
    if (Date.now() - lastAutoView > 700) takeViewControl();
  });
}

/* ------------------------------------------------------------------ *
 * Marker / trail rendering
 * ------------------------------------------------------------------ */
function makeIcon(p) {
  const html =
    `<div class="mk${p.isMe ? ' me' : ''}" style="color:${p.color}">` +
      glyphMarkup() +
      `<div class="lbl">${esc(p.name)}${p.isMe ? ' (you)' : ''}</div>` +
    `</div>`;
  return L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
}

function ensureMarker(p) {
  if (p._marker) return p._marker;
  const icon = makeIcon(p);
  p._marker = L.marker([p.lat, p.lng], {
    icon, interactive: true, keyboard: false, bubblingMouseEvents: false,
    zIndexOffset: p.isMe ? 1000 : 0,
  }).addTo(map);
  p._marker.on('click', () => identify(p));
  return p._marker;
}

// Tap a vehicle to find out who it is, without permanently labelling the map.
function identify(p) {
  focusPeer(p.id);
  if (p.isMe) { toast('That is you'); return; }
  const me = state.me;
  const parts = [p.name];
  if (me && me.lat != null) parts.push(fmtDist(haversine(me, p)) + ' away');
  const sp = fmtSpeed(p.spd);
  if (sp) parts.push(sp);
  toast(parts.join(' · '));
}

function updateMarker(p) {
  const m = ensureMarker(p);
  m.setLatLng([p.lat, p.lng]);
  const el = m.getElement();
  if (el) {
    el.classList.toggle('stale', !p.isMe && isStale(p));
    const rot = el.querySelector('.veh-rot');
    if (rot && p.hdg != null && !isNaN(p.hdg)) {
      rot.style.transform = 'rotate(' + Math.round(p.hdg) + 'deg)';
    }
  }

  const pts = p.trail.map((t) => [t.lat, t.lng]);
  if (pts.length >= 2) {
    if (!p._line) {
      p._line = L.polyline(pts, { color: p.color, weight: 3, opacity: 0.45, interactive: false }).addTo(map);
    } else {
      p._line.setLatLngs(pts);
    }
  }
}

function removePeer(id) {
  const p = state.peers.get(id);
  if (!p) return;
  if (p._marker) map.removeLayer(p._marker);
  if (p._line) map.removeLayer(p._line);
  state.peers.delete(id);
  refreshColors();
}

function allPeople() {
  const list = [];
  if (state.me && state.me.lat != null) list.push(state.me);
  state.peers.forEach((p) => list.push(p));
  return list;
}

const isStale = (p) => Date.now() - p.ts > CFG.staleMs;

function pushTrail(p) {
  const last = p.trail[p.trail.length - 1];
  if (!last || haversine(last, p) > 15) {
    p.trail.push({ lat: p.lat, lng: p.lng });
    if (p.trail.length > CFG.maxTrail) p.trail.shift();
  }
}

/* ------------------------------------------------------------------ *
 * UI: people panel + top bar
 * ------------------------------------------------------------------ */
function renderPeople() {
  const ul = $('people');
  const me = state.me;
  const rows = [];

  if (me && me.lat != null) rows.push(rowFor(me, null));
  state.peers.forEach((p) => rows.push(rowFor(p, me)));

  $('peopleCount').textContent =
    `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;

  if (!rows.length) {
    ul.innerHTML = '<li class="empty">Waiting for others to join…</li>';
    return;
  }
  ul.innerHTML = rows.join('');
  ul.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => focusPeer(li.getAttribute('data-id')));
  });
}

function rowFor(p, me) {
  const stale = !p.isMe && isStale(p);
  let meta;
  if (p.isMe) {
    const sp = fmtSpeed(p.spd);
    meta = `<b>${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</b>${sp ? ' · ' + sp : ''}`;
  } else if (me && me.lat != null) {
    const d = haversine(me, p);
    const b = compass(bearing(me, p));
    const sp = fmtSpeed(p.spd);
    meta = `<b>${fmtDist(d)} ${b}</b>${sp ? ' · ' + sp : ''}<br>${fmtAgo(p.ts)}`;
  } else {
    meta = fmtAgo(p.ts);
  }
  return `<li data-id="${esc(p.id)}" class="${stale ? 'stale' : ''}">
      <span class="pdot" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}<span class="tag">${p.isMe ? 'you' : (p.demo ? 'demo' : '')}</span></span>
      <span class="pmeta">${meta}</span>
    </li>`;
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = 'status ' + kind;
  $('statusText').textContent = text;
}

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function focusPeer(id) {
  const p = id === (state.me && state.me.id) ? state.me : state.peers.get(id);
  if (!p || p.lat == null) return;
  takeViewControl();
  lastAutoView = Date.now();
  map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16), { animate: true });
}

// Zoom out just far enough to hold everyone, and in close when the group is bunched up —
// so cars parked together still read as separate pins rather than one blob.
function fitAll() {
  const people = allPeople();
  if (people.length < 1) return;
  lastAutoView = Date.now();
  if (people.length === 1) { map.setView([people[0].lat, people[0].lng], 16); return; }
  const bounds = L.latLngBounds(people.map((p) => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [70, 70], maxZoom: 17, animate: true });
}

// The view follows the group by default. Dragging, zooming, tapping a car or Follow me
// hands it back to you.
function maybeAutoView() {
  const people = allPeople();
  if (state.autoFit && people.length >= 2) {
    if (Date.now() - lastFitAt < AUTOFIT_MS) return;   // don't chase every fix
    lastFitAt = Date.now();
    fitAll();
    return;
  }
  if (state.follow && state.me && state.me.lat != null) {
    lastAutoView = Date.now();
    map.panTo([state.me.lat, state.me.lng], { animate: true, duration: 0.4 });
  }
}

function syncViewButtons() {
  $('btnFit').classList.toggle('on', !!state.autoFit);
  $('btnFollow').classList.toggle('on', !!state.follow);
}

function takeViewControl() {
  if (!state.autoFit && !state.follow) return;
  state.autoFit = false;
  state.follow = false;
  syncViewButtons();
}

/* ------------------------------------------------------------------ *
 * Transport (MQTT over WebSocket)
 * ------------------------------------------------------------------ */
function connect() {
  const b = CFG.brokers[brokerIdx % CFG.brokers.length];
  setStatus('connecting', 'Connecting via ' + b.name + '…');

  let settled = false;
  const c = mqtt.connect(b.url, {
    clientId: state.me.id,
    clean: true,
    keepalive: 30,
    connectTimeout: 8000,
    reconnectPeriod: 0, // we handle retries ourselves for broker failover
  });
  client = c;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { c.end(true); } catch (e) {}
    brokerIdx++;
    scheduleReconnect();
  }, 9000);

  c.on('connect', () => {
    settled = true; clearTimeout(timer);
    c.subscribe(state.topic, { qos: 0 }, (err) => {
      if (err) { setStatus('offline', 'Subscribe failed'); return; }
      setStatus('online', 'Live · ' + b.name);
      hello();
      publishNow(true);
    });
  });

  c.on('message', onMessage);

  c.on('error', () => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    try { c.end(true); } catch (e) {}
    brokerIdx++;
    scheduleReconnect();
  });

  c.on('close', () => {
    if (!settled) return;
    setStatus('offline', 'Reconnecting…');
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !state.joined || state.demo) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

function onMessage(topic, payload) {
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
  if (!msg || !msg.id || msg.id === state.me.id) return;

  if (msg.t === 'bye') { removePeer(msg.id); renderPeople(); return; }
  if (msg.t === 'route') { if (hooks.onRoute) hooks.onRoute(msg); return; }
  if (msg.t === 'route-clear') { if (hooks.onRouteClear) hooks.onRouteClear(msg); return; }
  if (typeof msg.t === 'string' && msg.t.indexOf('voice-') === 0) {
    if (hooks.onVoice) hooks.onVoice(msg);
    return;
  }
  if (msg.t !== 'pos' || typeof msg.lat !== 'number' || typeof msg.lng !== 'number') return;

  let p = state.peers.get(msg.id);
  if (!p) {
    p = {
      id: msg.id, name: (msg.name || 'Someone').slice(0, 24),
      color: colorFor(msg.id), lat: msg.lat, lng: msg.lng,
      spd: msg.spd, hdg: msg.hdg, acc: msg.acc, ts: msg.ts || Date.now(),
      trail: [], isMe: false, demo: false,
    };
    state.peers.set(msg.id, p);
    rememberMember(state.room, msg.id, p.name);
    refreshColors();
    toast(p.name + ' joined');
  } else {
    p.lat = msg.lat; p.lng = msg.lng; p.spd = msg.spd; p.hdg = msg.hdg;
    p.acc = msg.acc; p.ts = msg.ts || Date.now();
    if (msg.name) p.name = msg.name.slice(0, 24);
  }
  pushTrail(p);
  updateMarker(p);
  renderPeople();
}

function send(obj) {
  if (!client || !client.connected) return;
  try { client.publish(state.topic, JSON.stringify(obj), { qos: 0 }); } catch (e) {}
}

function hello() {
  send({ t: 'hello', id: state.me.id, name: state.me.name, ts: Date.now() });
}

function publishNow(force) {
  const me = state.me;
  if (!me || me.lat == null) return;
  const now = Date.now();
  const moved = state.lastSentFix ? haversine(state.lastSentFix, me) : Infinity;
  if (!force && now - state.lastPublish < CFG.publishMs && moved < CFG.minMoveM) return;
  state.lastPublish = now;
  state.lastSentFix = { lat: me.lat, lng: me.lng };
  send({ t: 'pos', id: me.id, name: me.name, lat: me.lat, lng: me.lng,
         spd: me.spd, hdg: me.hdg, acc: me.acc, ts: now });
}

/* ------------------------------------------------------------------ *
 * Geolocation
 * ------------------------------------------------------------------ */
function startGeo() {
  if (!('geolocation' in navigator)) {
    toast('This browser has no location support');
    return;
  }
  navigator.geolocation.watchPosition(onFix, onGeoError, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
  });
}

function onFix(pos) {
  const me = state.me;
  if (!me) return;
  const c = pos.coords;
  const prev = me.lat != null ? { lat: me.lat, lng: me.lng, ts: me.ts } : null;
  me.lat = c.latitude;
  me.lng = c.longitude;
  me.acc = c.accuracy;
  me.hdg = (c.heading != null && !isNaN(c.heading)) ? c.heading : me.hdg;
  if (c.speed != null && !isNaN(c.speed) && c.speed >= 0) {
    me.spd = c.speed;
  } else if (prev) {
    const dt = (pos.timestamp - prev.ts) / 1000;
    if (dt > 0.5) me.spd = haversine(prev, me) / dt;
  }
  me.ts = pos.timestamp || Date.now();

  pushTrail(me);
  updateMarker(me);
  renderPeople();
  publishNow(false);
  if (hooks.tick) hooks.tick();
  if (hooks.onFix) hooks.onFix(me);
  maybeUpdateTheme();
  updateBearing(me);

  if (me._first) { me._first = false; map.setView([me.lat, me.lng], 15); }
  maybeAutoView();
}

function onGeoError(err) {
  const msgs = {
    1: 'Location permission denied — enable it to appear on the map.',
    2: 'Location unavailable right now.',
    3: 'Location timed out. Retrying…',
  };
  toast(msgs[err.code] || 'Location error');
}

/* ------------------------------------------------------------------ *
 * Demo mode — 4 simulated cars on a loop route
 * ------------------------------------------------------------------ */
function buildRoute(center, radius) {
  const pts = [];
  const n = 12;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(center.lat * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.72 + 0.35 * Math.abs(Math.sin(i * 1.7)));
    pts.push({ lat: center.lat + (r / mLat) * Math.sin(a), lng: center.lng + (r / mLng) * Math.cos(a) });
  }
  pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] };
}

function pointAt(route, dist) {
  const d = ((dist % route.total) + route.total) % route.total;
  let i = 1;
  while (i < route.cum.length && route.cum[i] < d) i++;
  const a = route.pts[i - 1], b = route.pts[i];
  const seg = route.cum[i] - route.cum[i - 1] || 1;
  const f = (d - route.cum[i - 1]) / seg;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, hdg: bearing(a, b) };
}

function startDemo() {
  state.demo = true;
  const center = CFG.fallbackCenter;
  const route = buildRoute(center, 2200);

  // Simulated "you" — the demo is fully offline, so it never needs real GPS.
  const me = state.me;
  me.demo = true;
  me.lat = center.lat + 0.004;
  me.lng = center.lng - 0.003;
  me.spd = 12; me.hdg = 0; me.acc = 6; me.ts = Date.now();
  me._d = 0; me._spd = 12;
  pushTrail(me);
  updateMarker(me);

  const names = ['Priya', 'Rahul', 'Meera', 'Arjun'];
  const cars = names.map((name, i) => {
    const id = 'demo-' + (i + 1);
    const p = {
      id, name, color: PALETTE[0],
      lat: center.lat, lng: center.lng, spd: 11 + Math.random() * 3,
      hdg: 0, acc: 6, ts: Date.now(), trail: [], isMe: false, demo: true,
      _d: (route.total / names.length) * (i + 1), _spd: 11 + Math.random() * 4,
    };
    state.peers.set(id, p);
    return p;
  });
  refreshColors();

  const step = (p, dt) => {
    p._spd += (Math.random() - 0.5) * 0.6;
    p._spd = Math.max(6, Math.min(19, p._spd));
    p._d += p._spd * dt;
    const q = pointAt(route, p._d);
    p.lat = q.lat; p.lng = q.lng; p.hdg = q.hdg; p.spd = p._spd; p.ts = Date.now();
    pushTrail(p);
    updateMarker(p);
  };

  setStatus('online', 'Demo mode');
  $('panel').classList.add('show');
  renderPeople();

  demoTimer = setInterval(() => {
    step(state.me, 1);
    cars.forEach((p) => step(p, 1));
    renderPeople();
    maybeAutoView();
  }, 1000);

  map.setView([center.lat, center.lng], 14);
  setTimeout(fitAll, 600);
  toast('Demo: 5 simulated cars on a loop');
}

function stopDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  ['demo-1', 'demo-2', 'demo-3', 'demo-4'].forEach(removePeer);
  state.demo = false;
}

/* ------------------------------------------------------------------ *
 * Timers: publish + render sweep
 * ------------------------------------------------------------------ */
function startTimers() {
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(() => { if (!state.demo) publishNow(false); }, CFG.publishMs);

  if (renderTimer) clearInterval(renderTimer);
  renderTimer = setInterval(() => {
    // drop silent peers
    const now = Date.now();
    state.peers.forEach((p, id) => {
      if (!p.demo && now - p.ts > CFG.dropMs) removePeer(id);
    });
    renderPeople();
  }, 5000);
}

/* ------------------------------------------------------------------ *
 * Join / leave
 * ------------------------------------------------------------------ */
function join(name, room) {
  let cid = localStorage.getItem(LS.cid);
  if (!cid) { cid = 'c-' + rand(10); localStorage.setItem(LS.cid, cid); }
  state.me = {
    id: cid, name, color: colorFor(cid), lat: null, lng: null, spd: null, hdg: null,
    acc: null, ts: Date.now(), trail: [], isMe: true, _first: true,
  };

  state.room = room;
  state.topic = `${CFG.topicPrefix}/${room}/bus`;
  state.joined = true;

  localStorage.setItem(LS.name, name);
  localStorage.setItem(LS.room, room);
  location.hash = 'r=' + encodeURIComponent(room);

  $('roomLabel').textContent = room;
  $('panel').classList.add('show');
  $('join').classList.add('hidden');

  startGeo();
  connect();
  startTimers();
  renderPeople();
  requestWakeLock();
  maybeShowInstallHint();
  rememberRoom(room, name);
  $('btnJoinCancel').style.display = 'none';

  try { history.replaceState(null, '', location.pathname + '#r=' + encodeURIComponent(room)); } catch (e) {}
}

function leave(showJoin = true) {
  if (state.joined && !state.demo) send({ t: 'bye', id: state.me.id, ts: Date.now() });
  if (hooks.onLeave) hooks.onLeave();
  stopDemo();
  if (client) { try { client.end(true); } catch (e) {} client = null; }
  if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
  if (renderTimer) { clearInterval(renderTimer); renderTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  state.peers.forEach((p, id) => removePeer(id));
  if (state.me && state.me._marker) map.removeLayer(state.me._marker);
  if (state.me && state.me._line) map.removeLayer(state.me._line);
  state.me = null;
  state.joined = false;
  state.room = null;
  state.lastSentFix = null;
  releaseWakeLock();

  $('panel').classList.remove('show');
  $('people').innerHTML = '';
  $('peopleCount').textContent = '0 people';
  $('roomLabel').textContent = 'not in a room';
  setStatus('idle', 'idle');
  if (showJoin) $('join').classList.remove('hidden');
}

/* ------------------------------------------------------------------ *
 * Wake lock (keep the screen awake while driving)
 * ------------------------------------------------------------------ */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (e) { /* not critical */ }
}
function releaseWakeLock() {
  if (state.wakeLock) { try { state.wakeLock.release(); } catch (e) {} state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.joined && !state.wakeLock) requestWakeLock();
});

/* ------------------------------------------------------------------ *
 * Share
 * ------------------------------------------------------------------ */
async function share() {
  const url = location.origin + location.pathname + '#r=' + encodeURIComponent(state.room);
  const text = `Join my Convoy room "${state.room}" — open this on your phone:`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Convoy', text, url }); return; }
  } catch (e) { /* fall through to copy */ }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch (e) {
    prompt('Copy this invite link:', url);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  $('btnJoin').addEventListener('click', () => {
    const name = ($('inName').value || '').trim().slice(0, 24) || 'Someone';
    const room = normRoom($('inRoom').value) || normRoom('trip-' + rand(4));
    join(name, room);
  });

  $('btnDemo').addEventListener('click', () => {
    const name = ($('inName').value || '').trim().slice(0, 24) || 'You';
    state.me = {
      id: 'me-' + rand(6), name, color: PALETTE[0],
      lat: null, lng: null, spd: null, hdg: null, acc: null,
      ts: Date.now(), trail: [], isMe: true, _first: true,
    };
    state.joined = true;
    $('roomLabel').textContent = 'demo';
    $('join').classList.add('hidden');
    $('panel').classList.add('show');
    startTimers();
    startDemo();
    renderPeople();
    maybeShowInstallHint();
  });

  $('btnShare').addEventListener('click', share);
  $('btnLeave').addEventListener('click', () => leave(true));
  $('btnFit').addEventListener('click', () => {
    state.autoFit = true;
    state.follow = false;
    syncViewButtons();
    lastFitAt = 0;
    fitAll();
  });
  $('btnFollow').addEventListener('click', () => {
    state.follow = !state.follow;
    if (state.follow) state.autoFit = false;
    syncViewButtons();
    if (state.follow && state.me && state.me.lat != null) {
      lastAutoView = Date.now();
      map.panTo([state.me.lat, state.me.lng]);
    }
  });
  syncViewButtons();

  // Names are off by default so the map stays readable while driving.
  $('btnNames').addEventListener('click', () => {
    const on = document.body.classList.toggle('names');
    $('btnNames').classList.toggle('on', on);
  });

  // Saved rooms: rejoin without retyping the code.
  $('btnRooms').addEventListener('click', () => {
    renderSavedRooms();
    if (window.ConvoySync) window.ConvoySync.pull();
    $('btnJoinCancel').style.display = state.joined ? '' : 'none';
    $('join').classList.remove('hidden');
  });
  $('btnJoinCancel').addEventListener('click', () => {
    if (state.joined) $('join').classList.add('hidden');
  });

  // Enter key joins
  ['inName', 'inRoom'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
  });

  window.addEventListener('beforeunload', () => {
    if (state.joined && !state.demo) send({ t: 'bye', id: state.me.id, ts: Date.now() });
  });
}

/* ------------------------------------------------------------------ *
 * Saved rooms and who was in them
 * ------------------------------------------------------------------ */
const LS_ROOMS = 'convoy.rooms';

function loadRooms() {
  try { return JSON.parse(localStorage.getItem(LS_ROOMS) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveRooms(all) {
  try { localStorage.setItem(LS_ROOMS, JSON.stringify(all)); } catch (e) { /* full */ }
}
function roomRecord(code) {
  const all = loadRooms();
  if (!all[code]) all[code] = { code, firstSeen: Date.now(), members: {} };
  return { all, r: all[code] };
}

function rememberRoom(code, name) {
  if (!code) return;
  const { all, r } = roomRecord(code);
  r.lastSeen = Date.now();
  if (name) r.name = name;
  if (state.me) r.members[state.me.id] = { name: state.me.name, lastSeen: Date.now() };
  saveRooms(all);
  renderSavedRooms();
  if (window.ConvoySync) window.ConvoySync.schedulePush();
}

// Union a shared room list into what is on this phone. The owner's phone is the
// only writer, so a reader never loses anything it already had.
function mergeRooms(remote) {
  if (!remote || typeof remote !== 'object') return 0;
  const all = loadRooms();
  let changed = 0;
  Object.keys(remote).forEach((code) => {
    const r = remote[code];
    if (!r || typeof r !== 'object' || !code) return;
    const cur = all[code];
    if (!cur) {
      all[code] = {
        code, name: r.name,
        firstSeen: r.firstSeen || Date.now(), lastSeen: r.lastSeen || Date.now(),
        members: Object.assign({}, r.members || {}),
      };
      changed++;
      return;
    }
    if ((r.lastSeen || 0) > (cur.lastSeen || 0)) { cur.lastSeen = r.lastSeen; changed++; }
    if (r.name && !cur.name) cur.name = r.name;
    cur.members = cur.members || {};
    Object.keys(r.members || {}).forEach((id) => {
      const rm = r.members[id] || {};
      const cm = cur.members[id];
      if (!cm || (rm.lastSeen || 0) > (cm.lastSeen || 0)) { cur.members[id] = rm; changed++; }
    });
  });
  if (changed) { saveRooms(all); renderSavedRooms(); }
  return changed;
}

function rememberMember(code, id, name) {
  if (!code || !id) return;
  const { all, r } = roomRecord(code);
  r.lastSeen = Date.now();
  const prev = r.members[id] || {};
  r.members[id] = { name: name || prev.name || 'Someone', lastSeen: Date.now() };
  saveRooms(all);
}

function forgetRoom(code) {
  const all = loadRooms();
  delete all[code];
  saveRooms(all);
  renderSavedRooms();
  if (window.ConvoySync) window.ConvoySync.schedulePush();
  toast('Forgot "' + code + '"');
}

function fmtWhen(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return new Date(ts).toLocaleDateString();
}

function renderSavedRooms() {
  const box = $('savedRooms');
  if (!box) return;
  const all = loadRooms();
  const codes = Object.keys(all).sort((a, b) => (all[b].lastSeen || 0) - (all[a].lastSeen || 0));
  if (!codes.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="sr-title">Your rooms</div>' + codes.slice(0, 8).map((c) => {
    const r = all[c];
    const names = Object.values(r.members || {}).map((m) => m.name).filter(Boolean);
    const n = names.length;
    const who = names.slice(0, 4).join(', ') + (n > 4 ? ' +' + (n - 4) : '');
    return '<div class="sr-row" data-code="' + esc(c) + '">' +
      '<div class="sr-main"><div class="sr-code">' + esc(c) + '</div>' +
      '<div class="sr-meta">' + n + (n === 1 ? ' person' : ' people') +
      (who ? ' · ' + esc(who) : '') +
      (r.lastSeen ? ' · ' + fmtWhen(r.lastSeen) : '') + '</div></div>' +
      '<button class="mini sr-forget" data-forget="' + esc(c) + '">Forget</button></div>';
  }).join('');

  box.querySelectorAll('.sr-row').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('sr-forget')) return;
      const code = el.getAttribute('data-code');
      const name = ($('inName').value || '').trim() || (state.me && state.me.name) || 'Someone';
      if (state.joined) leave(false);
      join(name, code);
    });
  });
  box.querySelectorAll('.sr-forget').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); forgetRoom(b.getAttribute('data-forget')); });
  });
}

/* ------------------------------------------------------------------ *
 * Install to the home screen
 * ------------------------------------------------------------------ */
const LS_INSTALL = 'convoy.a2hs';
let deferredInstall = null;

function isStandalone() {
  return (window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

let installReady = false;

// Only offered once the user is in the app, so it never covers the join screen.
function maybeShowInstallHint() {
  if (!installReady || isStandalone()) return;
  if (!state.joined) return;
  if (localStorage.getItem(LS_INSTALL) === 'done') return;
  $('a2hs').classList.add('show');
  document.body.classList.add('a2hs-on');
}

function dismissInstall() {
  $('a2hs').classList.remove('show');
  document.body.classList.remove('a2hs-on');
  localStorage.setItem(LS_INSTALL, 'done');
}

function initInstall() {
  if (isStandalone()) return;

  // Android / Chrome expose a real install flow.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('a2hsTxt').textContent = 'Install Convoy for full-screen, offline use.';
    $('a2hsGo').textContent = 'Install';
    installReady = true;
    maybeShowInstallHint();
  });

  // iOS Safari has no install prompt, so explain where the button lives.
  if (isIOS()) {
    $('a2hsTxt').textContent = 'Add Convoy to your home screen: tap Share, then "Add to Home Screen".';
    $('a2hsGo').textContent = 'Got it';
    installReady = true;
  }

  $('a2hsGo').addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
      deferredInstall = null;
    }
    dismissInstall();
  });
  $('a2hsClose').addEventListener('click', dismissInstall);

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(LS_INSTALL, 'done');
    $('a2hs').classList.remove('show');
  });
}

// Offline support + installability. Requires a secure origin (https or localhost).
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* not fatal */ });
}

/* ------------------------------------------------------------------ *
 * Bridge for route.js
 * ------------------------------------------------------------------ */
function publishRoute(payload) {
  if (!state.me) return;
  send(Object.assign({ t: 'route', id: state.me.id, by: state.me.name, ts: Date.now() }, payload));
}
function clearSharedRoute() {
  if (!state.me) return;
  send({ t: 'route-clear', id: state.me.id, ts: Date.now() });
}

window.Convoy = {
  CFG, $, esc, haversine, bearing, compass, fmtDist, fmtSpeed, fmtAgo, colorFor,
  toast, setStatus, state, send, fitAll, focusPeer, setVehicle,
  map: () => map,
  publishRoute, clearSharedRoute, hooks,
  rooms: { load: loadRooms, save: saveRooms, render: renderSavedRooms, remember: rememberRoom },
  mergeRooms,
  _internals: { sunTimes, themeFor, applyTheme, setTheme, onMapTap, updateBearing,
                getBearing: () => mapBearing, PALETTE, assignColors, refreshColors,
                maybeAutoView, takeViewControl, syncViewButtons },
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  if (typeof L === 'undefined' || typeof mqtt === 'undefined') {
    document.body.innerHTML =
      '<p style="font:16px sans-serif;color:#e8eefc;padding:24px">Could not load the map libraries. ' +
      'Check your internet connection and reload.</p>';
    return;
  }
  initMap();
  wire();
  initInstall();
  initServiceWorker();
  applyTheme();
  setInterval(applyTheme, CFG.theme.checkMs);
  if (window.ConvoyRoute) window.ConvoyRoute.init(window.Convoy);
  if (window.ConvoyVoice) window.ConvoyVoice.init(window.Convoy);
  if (window.ConvoySync) window.ConvoySync.init(window.Convoy);
  renderSavedRooms();
  if (window.ConvoySync) window.ConvoySync.pull();

  // Prefill from URL / storage
  const hashRoom = new URLSearchParams(location.hash.replace(/^#/, '')).get('r');
  const savedName = localStorage.getItem(LS.name) || '';
  const savedRoom = hashRoom || localStorage.getItem(LS.room) || '';
  $('inName').value = savedName;
  $('inRoom').value = savedRoom;

  if (savedName && savedRoom) {
    // An invite link, or just someone opening the app again: go straight into the room,
    // so the join screen (and the Forget buttons on it) does not reappear every launch.
    join(savedName, normRoom(savedRoom));
  } else if (hashRoom) {
    toast('Enter your name to join "' + normRoom(hashRoom) + '"');
  }
}

boot();
