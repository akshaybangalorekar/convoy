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
  follow: true,
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

// Hooks that route.js plugs into (see the bridge at the bottom of this file).
const hooks = { onRoute: null, onRouteClear: null, tick: null };

const LS = {
  name: 'convoy.name',
  room: 'convoy.room',
  cid: 'convoy.cid',
};

/* ------------------------------------------------------------------ *
 * Map
 * ------------------------------------------------------------------ */
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true })
         .setView([CFG.fallbackCenter.lat, CFG.fallbackCenter.lng], CFG.fallbackZoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

/* ------------------------------------------------------------------ *
 * Marker / trail rendering
 * ------------------------------------------------------------------ */
function ensureMarker(p) {
  if (p._marker) return p._marker;
  const html =
    `<div class="mk${p.isMe ? ' me' : ''}" style="color:${p.color}">` +
      glyphMarkup() +
      `<div class="lbl">${esc(p.name)}${p.isMe ? ' (you)' : ''}</div>` +
    `</div>`;
  const icon = L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
  p._marker = L.marker([p.lat, p.lng], {
    icon, interactive: true, keyboard: false, zIndexOffset: p.isMe ? 1000 : 0,
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
  state.follow = false;
  $('btnFollow').classList.remove('on');
  map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
}

function fitAll() {
  const people = allPeople();
  if (people.length < 1) return;
  if (people.length === 1) { map.setView([people[0].lat, people[0].lng], 15); return; }
  const bounds = L.latLngBounds(people.map((p) => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16 });
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

  if (state.follow) map.panTo([me.lat, me.lng], { animate: true, duration: 0.4 });
  if (me._first) { me._first = false; map.setView([me.lat, me.lng], 15); }
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
      id, name, color: PALETTE[(i + 2) % PALETTE.length],
      lat: center.lat, lng: center.lng, spd: 11 + Math.random() * 3,
      hdg: 0, acc: 6, ts: Date.now(), trail: [], isMe: false, demo: true,
      _d: (route.total / names.length) * (i + 1), _spd: 11 + Math.random() * 4,
    };
    state.peers.set(id, p);
    return p;
  });

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
    if (state.follow) map.panTo([state.me.lat, state.me.lng], { animate: true, duration: 0.4 });
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

  try { history.replaceState(null, '', location.pathname + '#r=' + encodeURIComponent(room)); } catch (e) {}
}

function leave(showJoin = true) {
  if (state.joined && !state.demo) send({ t: 'bye', id: state.me.id, ts: Date.now() });
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
      id: 'me-' + rand(6), name, color: colorFor('me-' + name),
      lat: null, lng: null, spd: null, hdg: null, acc: null,
      ts: Date.now(), trail: [], isMe: true, _first: true,
    };
    state.joined = true;
    state.me.color = PALETTE[0];
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
  $('btnFit').addEventListener('click', fitAll);
  $('btnFollow').addEventListener('click', () => {
    state.follow = !state.follow;
    $('btnFollow').classList.toggle('on', state.follow);
    if (state.follow && state.me && state.me.lat != null) map.panTo([state.me.lat, state.me.lng]);
  });

  // Names are off by default so the map stays readable while driving.
  $('btnNames').addEventListener('click', () => {
    const on = document.body.classList.toggle('names');
    $('btnNames').classList.toggle('on', on);
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
  if (window.ConvoyRoute) window.ConvoyRoute.init(window.Convoy);

  // Prefill from URL / storage
  const hashRoom = new URLSearchParams(location.hash.replace(/^#/, '')).get('r');
  const savedName = localStorage.getItem(LS.name) || '';
  const savedRoom = hashRoom || localStorage.getItem(LS.room) || '';
  $('inName').value = savedName;
  $('inRoom').value = savedRoom;

  if (savedName && hashRoom) {
    // Arrived via an invite link and we already know the name — join straight away.
    join(savedName, normRoom(hashRoom));
  } else if (hashRoom) {
    toast('Enter your name to join "' + normRoom(hashRoom) + '"');
  }
}

boot();
