/* Convoy — everyone on one map.
 *
 * Three things, and nothing else:
 *   1. Invite people with a link; anyone in the group can start one.
 *   2. Anyone can set the destination. Everyone sees every car and each
 *      person's arrival time at that destination.
 *   3. A notification when the destination changes, or someone joins or leaves.
 *
 * Positions, destinations and arrival times travel as small JSON messages on one
 * public MQTT topic per room. There is no server and no account.
 *
 * One honest limit: notifications only arrive while the app is open, because
 * without a server there is nothing to wake a closed app. The in-app banner and
 * the phone's vibration always fire; the system notification needs the app alive.
 */
(function () {
  'use strict';

  const CFG = {
    topicPrefix: 'sarvam-convoy/v1',
    // Public, no-signup MQTT brokers over WebSocket. Tried in order.
    brokers: [
      { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
      { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
      { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/' },
    ],
    publishMs: 5000,          // broadcast our position at least this often
    renderMs: 3000,           // sweep the list and the view
    etaMs: 60000,             // recompute our arrival time this often
    staleMs: 90000,           // silence this long and a person counts as out of contact
    awayMs: 180000,           // backgrounded this long counts as out of contact too
    // A room stays open this long after anyone last used it. Nobody is ever dropped
    // from the room while it is open — a quiet phone just sits there as out of contact.
    roomDays: 7,
    minMoveM: 12,             // publish early if we moved this far
    fallbackCenter: { lat: -33.8688, lng: 151.2093 },  // Sydney, until GPS arrives
    fallbackZoom: 11,
    // One tap zooms out, two zoom in. The wait is how long a single tap is held back to
    // see whether a second one is coming, and the tolerance is how far a finger may
    // wander before it counts as a pan rather than a tap.
    tapZoom: { delayMs: 260, moveTolerancePx: 12 },
  };

  const PALETTE = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de',
                   '#5ac8fa', '#ffcc00', '#ff2d55', '#30d158', '#5856d6'];

  const LS = { name: 'convoy.name', room: 'convoy.room', id: 'convoy.me',
               invite: 'convoy.invite' };

  const state = {
    me: null,
    peers: new Map(),     // id -> person
    seen: new Set(),      // ids we have announced, so a join notifies once
    room: null,
    topic: null,
    joined: false,
    dest: null,           // { lat, lng, label, by }
    myEta: null,          // { dur, dist, ts }
    autoFit: true,
    wakeLock: null,
    lastPublish: 0,
    lastSentFix: null,
    destTs: 0,            // when the destination was last set or cleared; newest wins
    away: false,          // true while our own app is in the background
    roomExpires: 0,       // when this room lapses, for the note in the sheet
  };

  let map = null;
  let client = null;
  let brokerIdx = 0;
  let publishTimer = null;
  let renderTimer = null;
  let etaTimer = null;
  let reconnectTimer = null;
  let myLine = null;
  let destMarker = null;
  let lastAutoView = 0;
  let lastFitAt = 0;

  const AUTOFIT_MS = 4000;

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function rand(n) {
    const a = new Uint8Array(n);
    (crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n);
  }

  // One identity per device, kept across sessions. Without this, closing and reopening
  // the app would look like a brand new person to everyone else.
  function myId() {
    try {
      let id = localStorage.getItem(LS.id);
      if (!id) { id = 'c-' + rand(8); localStorage.setItem(LS.id, id); }
      return id;
    } catch (e) { return 'c-' + rand(8); }
  }

  // The room code can arrive as #r=... or ?r=... — some chat apps and link handlers keep
  // only one of the two, so both are accepted.
  function roomFromUrl() {
    try {
      const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('r');
      if (fromHash) return fromHash;
      return new URLSearchParams(location.search).get('r') || '';
    } catch (e) { return ''; }
  }

  function normRoom(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
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
    if (m == null || isNaN(m)) return '';
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
  }

  function fmtClock(ms) {
    if (!ms || isNaN(ms)) return '—';
    try {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '—';
    }
  }

  function fmtAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + 'h ago';
  }

  const isStale = (p) => Date.now() - p.ts > CFG.staleMs;

  // Where each person stands. "away" is something they told us; "lost" is what we
  // infer when the messages simply stop. A force-kill cannot announce itself — that
  // is the one thing a killed app cannot do — so it lands here as lost contact.
  function presenceOf(p) {
    if (p.isMe) return 'me';
    // Someone brought back from the room's roster has no position yet, so we have not
    // actually heard from them this session — out of contact until they say something.
    if (p.lat == null) return 'lost';
    if (p.away) return (Date.now() - (p.awayAt || 0) > CFG.awayMs) ? 'lost' : 'away';
    return isStale(p) ? 'lost' : 'live';
  }

  /* The destination is a decision, not a measurement, so it is the one piece of shared
     state worth keeping on the phone: a phone that comes back restores it and announces
     it, and no server has to hold it. Positions are deliberately not kept — a stale
     position is worse than none. */
  /* The room itself is kept on the phone: the code, when it opened, when it lapses, the
     destination, and everyone who has been in it. That is what stops a room closing or
     anyone being quietly dropped — a phone that goes quiet stays on the list, and the
     room is still there a week later. */
  const roomKey = (room) => 'convoy.room.' + room;
  const roomLifeMs = () => CFG.roomDays * 86400000;

  function loadRoom(room) {
    try {
      const raw = localStorage.getItem(roomKey(room));
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j.expiresAt !== 'number') return null;
      if (Date.now() > j.expiresAt) {           // a week of nobody using it: it lapses
        localStorage.removeItem(roomKey(room));
        return null;
      }
      return j;
    } catch (e) { return null; }
  }

  // Every write pushes the room's life forward, so it lapses a week after the last time
  // anyone used it rather than a week after it was made. A room in use never closes.
  function saveRoom(patch) {
    if (!state.room || state.room === 'demo') return null;
    try {
      const now = Date.now();
      const cur = loadRoom(state.room) || { code: state.room, startedAt: now, members: {} };
      const next = Object.assign({}, cur, patch || {});
      next.expiresAt = now + roomLifeMs();
      next.updatedAt = now;
      localStorage.setItem(roomKey(state.room), JSON.stringify(next));
      state.roomExpires = next.expiresAt;
      return next;
    } catch (e) { return null; }
  }

  function saveDest() {
    saveRoom({ dest: state.dest, destTs: state.destTs });
  }

  function loadDest(room) {
    const r = loadRoom(room);
    if (!r) return null;
    return { dest: r.dest || null, ts: typeof r.destTs === 'number' ? r.destTs : 0 };
  }

  // Who has been in this room. Written when someone first appears, and refreshed now and
  // then — not on every position, which would hammer the phone's storage.
  function rememberMember(id, name, seenAt) {
    if (!state.room || !id) return;
    const r = loadRoom(state.room);
    const members = Object.assign({}, (r && r.members) || {});
    const prev = members[id] || {};
    members[id] = { name: name || prev.name || 'Someone', lastSeen: seenAt || Date.now() };
    saveRoom({ members });
  }

  // Pressing Leave is the one thing that takes someone off the roster.
  function forgetMember(id) {
    if (!state.room || !id) return;
    const r = loadRoom(state.room);
    if (!r || !r.members || !r.members[id]) return;
    const members = Object.assign({}, r.members);
    delete members[id];
    saveRoom({ members });
  }

  function roomNoteText(ms) {
    if (!ms || ms <= 0) return '';
    const days = ms / 86400000;
    if (days > 6.5) return 'Room open for another week';
    if (days >= 1) {
      const d = Math.ceil(days);
      return 'Room closes in ' + d + (d === 1 ? ' day' : ' days');
    }
    const h = Math.max(1, Math.ceil(ms / 3600000));
    return 'Room closes in ' + h + (h === 1 ? ' hour' : ' hours');
  }

  /* ---------------------------------------------------------------- *
   * Colours: unique per person, and the same on every phone
   * ---------------------------------------------------------------- */
  function colorFor(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return PALETTE[(h >>> 0) % PALETTE.length];
  }

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

  function refreshColors() {
    if (!assignColors()) return;
    allPeople().forEach((p) => {
      if (p._marker) p._marker.setIcon(makeIcon(p));
      if (p._line) p._line.setStyle({ color: p.color });
    });
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Map
   * ---------------------------------------------------------------- */
  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      rotate: false,
      doubleClickZoom: false,   // we do our own double tap, below
    }).setView([CFG.fallbackCenter.lat, CFG.fallbackCenter.lng], CFG.fallbackZoom);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // Dragging or zooming by hand hands the view back to you.
    map.on('dragstart zoomstart', () => {
      if (Date.now() - lastAutoView > 700) { state.autoFit = false; }
    });
    wireTapZoom(map.getContainer());
  }

  /* ---------------------------------------------------------------- *
   * Tap gestures: one tap zooms out, two zoom in
   * ---------------------------------------------------------------- */
  const tap = { last: 0, timer: null };

  // A single tap cannot be acted on straight away — a second one may be on its way — so
  // it is held back briefly. A second tap cancels the first and zooms the other way.
  function handleTap() {
    const now = Date.now();
    if (now - tap.last < CFG.tapZoom.delayMs) {
      tap.last = 0;
      if (tap.timer) { clearTimeout(tap.timer); tap.timer = null; }
      map.zoomIn();
      return 'in';
    }
    tap.last = now;
    if (tap.timer) clearTimeout(tap.timer);
    tap.timer = setTimeout(() => {
      tap.timer = null;
      tap.last = 0;
      map.zoomOut();
    }, CFG.tapZoom.delayMs);
    return 'held';
  }

  function wireTapZoom(container) {
    if (!container || !container.addEventListener) return;
    const tol = CFG.tapZoom.moveTolerancePx;
    let from = null;
    let dragged = false;

    // A tap that lands on a car or a control belongs to that, not to the zoom.
    const ours = (target) => !(target && target.closest &&
      target.closest('.mk, .mk-dest, .leaflet-marker-icon, .leaflet-control'));

    const point = (e) => (e.touches && e.touches[0]) ||
                         (e.changedTouches && e.changedTouches[0]) || e;

    const down = (e) => {
      const p = point(e);
      from = { x: p.clientX, y: p.clientY };
      dragged = false;
    };
    const move = (e) => {
      if (!from) return;
      const p = point(e);
      if (Math.abs(p.clientX - from.x) > tol || Math.abs(p.clientY - from.y) > tol) {
        dragged = true;
      }
    };
    const up = (e) => {
      const started = from;
      const wasDrag = dragged;
      from = null;
      dragged = false;
      if (!started || wasDrag) return;      // that was a pan, not a tap
      if (!ours(e.target)) return;
      handleTap();
    };

    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', () => { from = null; dragged = false; });
  }

  function makeIcon(p) {
    const html =
      '<div class="mk' + (p.isMe ? ' me' : '') + '" style="color:' + p.color + '">' +
        '<span class="dot"></span>' +
        '<span class="lbl">' + esc(p.name) + '</span>' +
      '</div>';
    return L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  function ensureMarker(p) {
    if (p._marker) return p._marker;
    p._marker = L.marker([p.lat, p.lng], {
      icon: makeIcon(p), keyboard: false, zIndexOffset: p.isMe ? 1000 : 0,
    }).addTo(map);
    return p._marker;
  }

  function updateMarker(p) {
    const m = ensureMarker(p);
    m.setLatLng([p.lat, p.lng]);
    const el = m.getElement();
    if (el) el.classList.toggle('stale', !p.isMe && isStale(p));
  }

  function removePeer(id) {
    const p = state.peers.get(id);
    if (!p) return;
    if (p._marker) map.removeLayer(p._marker);
    state.peers.delete(id);
    refreshColors();
  }

  function allPeople() {
    const list = [];
    if (state.me && state.me.lat != null) list.push(state.me);
    state.peers.forEach((p) => list.push(p));
    return list;
  }

  function fitAll() {
    const people = allPeople();
    if (!people.length) return;
    lastAutoView = Date.now();
    if (people.length === 1) { map.setView([people[0].lat, people[0].lng], 15); return; }
    const bounds = L.latLngBounds(people.map((p) => [p.lat, p.lng]));
    if (state.dest) bounds.extend([state.dest.lat, state.dest.lng]);
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16, animate: true });
  }

  // Keep everyone in frame by default; the moment you take control, stop moving.
  function maybeAutoView() {
    if (!state.autoFit) return;
    const people = allPeople();
    if (people.length < 2 && !state.dest) return;
    if (Date.now() - lastFitAt < AUTOFIT_MS) return;
    lastFitAt = Date.now();
    fitAll();
  }

  function drawDest() {
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    if (!state.dest) return;
    destMarker = L.marker([state.dest.lat, state.dest.lng], {
      icon: L.divIcon({ className: 'mk-dest', html: '<span class="pin"></span>',
                        iconSize: [0, 0], iconAnchor: [0, 0] }),
      keyboard: false, zIndexOffset: 500,
    }).addTo(map);
  }

  function drawMyLine(geometry) {
    if (myLine) { map.removeLayer(myLine); myLine = null; }
    if (!geometry || geometry.length < 2) return;
    myLine = L.polyline(geometry, {
      color: state.me ? state.me.color : '#007aff',
      weight: 5, opacity: 0.75, lineJoin: 'round', interactive: false,
    }).addTo(map);
  }

  /* ---------------------------------------------------------------- *
   * Messages
   * ---------------------------------------------------------------- */
  function send(obj) {
    if (!client || !client.connected || !state.topic) return;
    const body = Object.assign({ id: state.me.id, name: state.me.name, ts: Date.now() }, obj);
    try { client.publish(state.topic, JSON.stringify(body)); } catch (e) { /* ignore */ }
    state.lastPublish = Date.now();
  }

  // `force` is for the state push: coming back from a drop, the group needs our position
  // even if we have not moved since the last time we sent it.
  function publishNow(force) {
    const me = state.me;
    if (!me || me.lat == null) return;
    const last = state.lastSentFix;
    if (!force && last && haversine(last, me) < CFG.minMoveM &&
        Date.now() - state.lastPublish < CFG.publishMs) return;
    state.lastSentFix = { lat: me.lat, lng: me.lng };
    send({ t: 'pos', lat: me.lat, lng: me.lng, spd: me.spd, hdg: me.hdg, acc: me.acc });
  }

  // Announce everything this phone knows: who we are, where we are, where we are all
  // going, and how long we will take. This is what makes a server unnecessary — every
  // phone re-pushes its own state, so the room rebuilds itself from the people in it.
  function sendState() {
    send({ t: 'hello' });
    publishNow(true);
    if (state.dest) {
      send({ t: 'dest', lat: state.dest.lat, lng: state.dest.lng,
             label: state.dest.label, by: state.dest.by, ts: state.destTs });
    } else if (state.destTs) {
      // We know it was cleared more recently than anyone's destination, so say so —
      // otherwise a phone that was away would put a stale destination back on the air.
      send({ t: 'dest-clear', ts: state.destTs });
    }
    if (state.myEta) send({ t: 'eta', dur: state.myEta.dur, dist: state.myEta.dist });
  }

  function onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    if (!msg || !msg.id || (state.me && msg.id === state.me.id)) return;

    switch (msg.t) {
      case 'hello':      onHello(msg); return;
      case 'bye':        onBye(msg); return;
      case 'dest':       onDest(msg); return;
      case 'dest-clear': onDestClear(msg); return;
      case 'eta':        onEta(msg); return;
      case 'away':       onAway(msg); return;
      case 'back':       onBack(msg); return;
      case 'pos':        onPos(msg); return;
      default: return;
    }
  }

  function announceJoin(id, name) {
    if (state.seen.has(id)) return false;
    state.seen.add(id);
    // Someone already on the room's roster is coming back, not joining for the first
    // time, so they get a quiet return rather than a "joined" ping.
    const rec = loadRoom(state.room);
    if (rec && rec.members && rec.members[id]) return false;
    notify(name + ' joined', 'They can see the map and set the destination.');
    return true;
  }

  function onHello(msg) {
    announceJoin(msg.id, msg.name || 'Someone');
  }

  // "My app is going to the background." Sent on the way out, so the group can tell a
  // phone that is out of signal from one that has simply been put away.
  function onAway(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    p.away = true;
    p.awayAt = Date.now();
    renderPeople();
  }

  function onBack(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    p.away = false;
    p.awayAt = 0;
    p.ts = Date.now();      // they are here; the position catches up on the next fix
    renderPeople();
  }

  function onBye(msg) {
    if (!state.peers.has(msg.id) && !state.seen.has(msg.id)) return;
    const p = state.peers.get(msg.id);
    const name = (p && p.name) || msg.name || 'Someone';
    removePeer(msg.id);
    state.seen.delete(msg.id);
    forgetMember(msg.id);      // pressing Leave is the one way off the roster
    renderPeople();
    notify(name + ' left', '');
  }

  function onPos(msg) {
    if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number') return;
    let p = state.peers.get(msg.id);
    if (!p) {
      p = {
        id: msg.id, name: (msg.name || 'Someone').slice(0, 24),
        color: colorFor(msg.id), lat: msg.lat, lng: msg.lng,
        spd: msg.spd, hdg: msg.hdg, acc: msg.acc, ts: msg.ts || Date.now(),
        eta: null, isMe: false, demo: false,
        away: false, awayAt: 0, presence: 'live',
      };
      state.peers.set(msg.id, p);
      refreshColors();
      // A position from someone new is also a join, for clients that skip hello.
      announceJoin(msg.id, p.name);
      rememberMember(msg.id, p.name, p.ts);
      p.savedAt = Date.now();
    } else {
      p.lat = msg.lat; p.lng = msg.lng; p.spd = msg.spd; p.hdg = msg.hdg;
      p.acc = msg.acc; p.ts = msg.ts || Date.now();
      p.away = false; p.awayAt = 0;
      if (msg.name) p.name = msg.name.slice(0, 24);
      // Keep the roster's last-seen roughly current without writing on every fix.
      if (!p.savedAt || Date.now() - p.savedAt > 300000) {
        p.savedAt = Date.now();
        rememberMember(msg.id, p.name, p.ts);
      }
    }
    updateMarker(p);
    renderPeople();
    maybeAutoView();
  }

  function onEta(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    p.eta = { dur: msg.dur, dist: msg.dist, ts: msg.ts || Date.now() };
    renderPeople();
  }

  function sameDest(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
  }

  // Destinations carry the moment they were decided, so the newest decision wins and a
  // phone coming back cannot overwrite it with what it remembered from before.
  function onDest(msg) {
    if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number') return;
    const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
    if (ts < state.destTs) return;               // an older announcement: ignore it
    const next = { lat: msg.lat, lng: msg.lng, label: msg.label || 'Destination',
                   by: msg.by || msg.name };
    if (sameDest(state.dest, next)) { state.destTs = ts; return; }   // already have it
    state.destTs = ts;
    state.dest = next;
    state.myEta = null;
    renderDest();
    drawDest();
    refreshRoute();
    saveDest();
    notify((msg.by || msg.name || 'Someone') + ' set the destination', next.label);
  }

  function onDestClear(msg) {
    const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
    if (ts < state.destTs) return;               // an older announcement
    const had = !!state.dest;
    state.destTs = ts;
    state.dest = null;
    state.myEta = null;
    renderDest();
    drawDest();
    drawMyLine(null);
    renderPeople();
    saveDest();
    if (had) notify((msg.by || msg.name || 'Someone') + ' cleared the destination', '');
  }

  /* ---------------------------------------------------------------- *
   * Arrival times
   * ---------------------------------------------------------------- */
  async function refreshRoute() {
    if (!state.dest || !state.me || state.me.lat == null) return;
    if (!window.ConvoyRoute) return;
    const target = state.dest;
    const r = await window.ConvoyRoute.drive(
      { lat: state.me.lat, lng: state.me.lng },
      { lat: target.lat, lng: target.lng });
    if (!r) return;
    if (state.dest !== target) return;      // the destination moved while we waited
    drawMyLine(r.geometry);
    state.myEta = { dur: r.duration, dist: r.distance, ts: Date.now() };
    send({ t: 'eta', dur: r.duration, dist: r.distance });
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Notifications
   * ---------------------------------------------------------------- */
  let bannerTimer = null;

  function banner(text) {
    const el = $('banner');
    el.textContent = text;
    el.classList.add('show');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  function notify(title, body) {
    banner(body ? title + ' — ' + body : title);
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* ignore */ }
    try {
      if (typeof Notification === 'function' && Notification.permission === 'granted') {
        // eslint-disable-next-line no-new
        new Notification(title, {
          body: body || '', icon: 'icons/apple-touch-icon.png',
          tag: 'convoy', renotify: true,
        });
      }
    } catch (e) { /* ignore */ }
  }

  function askToNotify() {
    try {
      if (typeof Notification === 'function' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */
  function setConn(kind, text) {
    const el = $('connState');
    el.className = 'conn' + (kind === 'live' ? ' live' : '');
    el.textContent = text;
  }

  function connect() {
    const b = CFG.brokers[brokerIdx % CFG.brokers.length];
    setConn('', 'connecting');
    let settled = false;

    try {
      client = mqtt.connect(b.url, { clientId: state.me.id, clean: true, reconnectPeriod: 0 });
    } catch (e) {
      retry();
      return;
    }

    client.on('connect', () => {
      settled = true;
      setConn('live', 'live');
      client.subscribe(state.topic, { qos: 0 }, () => {});
      sendState();          // push everything we know, so nobody has to hold it for us
      refreshRoute();
    });
    client.on('message', onMessage);
    client.on('error', () => { if (!settled) retry(); });
    client.on('close', () => {
      setConn('', 'offline');
      if (!settled) retry();
      else scheduleReconnect();
    });
  }

  function retry() {
    brokerIdx++;
    setConn('', 'trying another relay');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, 1200);
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, 4000);
  }

  /* ---------------------------------------------------------------- *
   * Location
   * ---------------------------------------------------------------- */
  function startWatching() {
    if (!navigator.geolocation) { banner('This device cannot share its location'); return; }
    navigator.geolocation.watchPosition(onFix, onGeoError, {
      enableHighAccuracy: true, maximumAge: 4000, timeout: 20000,
    });
  }

  function onFix(pos) {
    const me = state.me;
    if (!me) return;
    const c = pos.coords;
    if (me.lat != null && c.accuracy > 200) return;    // ignore a wild fix
    me.lat = c.latitude; me.lng = c.longitude;
    me.acc = c.accuracy;
    me.spd = c.speed == null ? null : c.speed;
    me.hdg = c.heading == null || isNaN(c.heading) ? me.hdg : c.heading;
    me.ts = pos.timestamp || Date.now();

    updateMarker(me);
    renderPeople();
    publishNow();
    if (me._first) { me._first = false; map.setView([me.lat, me.lng], 15); }
    maybeAutoView();
  }

  function onGeoError(err) {
    banner({
      1: 'Location is blocked — allow it so the group can see you',
      2: 'Location is unavailable right now',
      3: 'Location timed out, retrying',
    }[err.code] || 'Location error');
    // If this is the browser built into a chat app, that is usually why — say so.
    if (window.ConvoyInstall && window.ConvoyInstall.showOpenInBrowser) {
      window.ConvoyInstall.showOpenInBrowser();
    }
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */
  function renderPeople() {
    const ul = $('people');
    const me = state.me;
    const rows = [];

    if (me) rows.push(rowFor(me, null));
    Array.from(state.peers.values())
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .forEach((p) => rows.push(rowFor(p, me)));

    $('peopleCount').textContent = rows.length + (rows.length === 1 ? ' person' : ' people');

    if (!rows.length) {
      ul.innerHTML = '<li class="empty">Waiting for others to join…</li>';
    } else {
      ul.innerHTML = rows.join('');
    }

    // Keep the recenter button clear of the sheet.
    const sheet = $('sheet');
    if (sheet) {
      document.documentElement.style.setProperty('--sheet-h', sheet.offsetHeight + 'px');
    }
    renderRoomNote();
  }

  function renderRoomNote() {
    const el = $('roomNote');
    if (!el) return;
    el.textContent = state.joined ? roomNoteText(state.roomExpires - Date.now()) : '';
  }

  function etaCell(p) {
    if (!state.dest) return '<span class="peta">no destination</span>';
    const eta = p.isMe ? state.myEta : p.eta;
    if (!eta) return '<span class="peta">—</span>';
    const arrive = eta.ts + eta.dur * 1000;
    return '<span class="peta"><b>' + esc(fmtClock(arrive)) + '</b>' +
           esc(fmtDist(eta.dist)) + '</span>';
  }

  function rowFor(p, me) {
    const kind = presenceOf(p);
    let meta = '';
    if (p.isMe) {
      meta = state.away ? 'app in the background' : 'you';
    } else if (p.lat == null) {
      meta = 'out of contact';
    } else if (kind === 'away') {
      meta = 'app in the background';
    } else if (kind === 'lost') {
      meta = 'out of contact · ' + fmtAgo(p.ts);
    } else if (me && me.lat != null) {
      meta = fmtDist(haversine(me, p)) + ' ' + compass(bearing(me, p));
    }
    return '<li data-id="' + esc(p.id) + '" class="' +
      (kind === 'lost' ? 'lost ' : '') + (kind === 'away' ? 'away ' : '') + '">' +
      '<span class="pdot" style="background:' + p.color + '"></span>' +
      '<span class="pname">' + esc(p.name) +
        (meta ? '<span class="tag">' + esc(meta) + '</span>' : '') + '</span>' +
      etaCell(p) +
    '</li>';
  }

  function renderDest() {
    const el = $('destText');
    if (state.dest) {
      el.textContent = state.dest.label;
      el.classList.remove('empty');
    } else {
      el.textContent = 'Set a destination';
      el.classList.add('empty');
    }
    const clear = $('btnClearDest');
    if (clear) clear.style.display = state.dest ? '' : 'none';
  }

  function renderTop() {
    $('roomChip').textContent = state.room || '—';
  }

  function toast(msg) { banner(msg); }

  /* ---------------------------------------------------------------- *
   * Destination
   * ---------------------------------------------------------------- */
  function setDest(lat, lng, label) {
    // Accept anything numeric. A service that hands back its coordinates as text must not
    // silently lose the destination — that is a very quiet way for a tap to do nothing.
    const la = typeof lat === 'number' ? lat : parseFloat(lat);
    const ln = typeof lng === 'number' ? lng : parseFloat(lng);
    if (!isFinite(la) || !isFinite(ln)) return;
    lat = la; lng = ln;
    state.destTs = Date.now();
    state.dest = { lat, lng, label: label || 'Destination', by: state.me ? state.me.name : '' };
    state.myEta = null;
    renderDest();
    drawDest();
    refreshRoute();
    saveDest();
    send({ t: 'dest', lat, lng, label: state.dest.label, by: state.dest.by, ts: state.destTs });
    state.autoFit = true;
    lastFitAt = 0;
    fitAll();
  }

  function clearDest() {
    if (!state.dest) return;
    state.destTs = Date.now();
    state.dest = null;
    state.myEta = null;
    renderDest();
    drawDest();
    drawMyLine(null);
    renderPeople();
    saveDest();
    send({ t: 'dest-clear', ts: state.destTs });
  }

  // Watch for people slipping out of contact, and for them coming back. This is the
  // backstop for a force-kill: the app is gone, so nothing was sent, and all the group
  // can honestly say is that the messages stopped.
  function sweepPresence() {
    let changed = false;
    state.peers.forEach((p) => {
      const kind = presenceOf(p);
      if (kind === p.presence) return;
      const was = p.presence;
      p.presence = kind;
      changed = true;
      if (kind === 'lost') {
        notify(p.name + ' — out of contact',
               'No signal, or their app was closed. They reappear when they can.');
      } else if (kind === 'live' && was === 'lost') {
        notify(p.name + ' is back', '');
      }
    });
    if (changed) {
      state.peers.forEach((p) => {
        const el = p._marker && p._marker.getElement();
        if (el) el.classList.toggle('stale', presenceOf(p) === 'lost');
      });
      renderPeople();
    }
  }

  /* ---------------------------------------------------------------- *
   * Session
   * ---------------------------------------------------------------- */
  function startTimers() {
    stopTimers();
    publishTimer = setInterval(publishNow, CFG.publishMs);
    renderTimer = setInterval(() => {
      // Nobody is dropped from the room while it is open. A phone that goes quiet stays
      // on the list as out of contact; only the room itself lapsing clears the roster,
      // and that takes a week of nobody using it.
      state.peers.forEach((p, id) => {
        if (Date.now() - p.ts > roomLifeMs()) { removePeer(id); state.seen.delete(id); }
      });
      sweepPresence();
      renderPeople();
      maybeAutoView();
    }, CFG.renderMs);
    etaTimer = setInterval(refreshRoute, CFG.etaMs);
  }

  function stopTimers() {
    [publishTimer, renderTimer, etaTimer].forEach((t) => { if (t) clearInterval(t); });
    publishTimer = renderTimer = etaTimer = null;
  }

  async function askWakeLock() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* ignore */ }
  }

  function updateGoLabel() {
    const code = normRoom($('inRoom').value);
    $('btnGo').textContent = code ? 'Join group' : 'Start a new group';
  }

  function join(name, room) {
    state.me = {
      id: myId(), name, color: PALETTE[0],
      lat: null, lng: null, spd: null, hdg: null, acc: null,
      ts: Date.now(), isMe: true, _first: true,
    };
    state.room = room;
    state.topic = CFG.topicPrefix + '/' + room + '/bus';
    state.joined = true;
    state.seen = new Set();
    state.away = false;

    // Restore the destination this phone last knew for this room, so a returning phone
    // can put it straight back on the air without asking anybody.
    const saved = loadDest(room);
    state.destTs = saved ? saved.ts : 0;
    state.dest = saved ? saved.dest : null;
    state.myEta = null;

    // And bring back everyone who has been in this room. They have no position yet, so
    // they sit on the list as out of contact until they publish one — nobody silently
    // vanishes just because they were quiet.
    const rec = loadRoom(room);
    state.roomExpires = rec ? rec.expiresAt : 0;
    if (rec && rec.members) {
      Object.keys(rec.members).forEach((id) => {
        if (id === state.me.id || state.peers.has(id)) return;
        const m = rec.members[id] || {};
        state.peers.set(id, {
          id, name: (m.name || 'Someone').slice(0, 24), color: colorFor(id),
          lat: null, lng: null, spd: null, hdg: null, acc: null,
          ts: m.lastSeen || Date.now(), eta: null, isMe: false, demo: false,
          away: false, awayAt: 0,
          presence: 'lost',      // already known, so opening the app does not ping
          restored: true,
        });
        state.seen.add(id);      // known, so their next position is a return, not a join
      });
      refreshColors();
    }
    rememberMember(state.me.id, name);

    try {
      localStorage.setItem(LS.name, name);
      localStorage.setItem(LS.room, room);
    } catch (e) { /* ignore */ }

    try { history.replaceState(null, '', location.pathname + '#r=' + encodeURIComponent(room)); } catch (e) {}

    renderTop();
    renderDest();
    drawDest();
    renderPeople();
    $('join').classList.add('hidden');
    $('sheet').classList.remove('hidden');
    $('btnRecenter').classList.remove('hidden');

    connect();
    startWatching();
    startTimers();
    askWakeLock();
    askToNotify();
  }

  function leave() {
    if (state.joined && client && client.connected) send({ t: 'bye' });
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    stopTimers();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    state.peers.forEach((p) => { if (p._marker) map.removeLayer(p._marker); });
    state.peers.clear();
    state.seen = new Set();
    state.joined = false;
    state.away = false;
    state.me = null;
    state.dest = null;
    state.destTs = 0;
    state.myEta = null;
    state.roomExpires = 0;      // the room itself is left alone; this is just our session
    if (myLine) { map.removeLayer(myLine); myLine = null; }
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    state.autoFit = true;
    try { localStorage.removeItem(LS.room); } catch (e) {}

    renderTop();
    renderDest();
    renderPeople();
    $('join').classList.remove('hidden');
    $('sheet').classList.add('hidden');
    $('btnRecenter').classList.add('hidden');
    updateGoLabel();
  }

  const inviteLink = () => location.origin + location.pathname +
    '#r=' + encodeURIComponent(state.room);

  // The modern clipboard first, then the old way — which is what still works inside the
  // browsers built into chat apps, where the clipboard API is often blocked.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the old way */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  // Last resort: show the link so it can be copied by hand.
  function showLink(url) {
    const card = $('shareCard');
    if (!card) return;
    $('shareUrl').value = url;
    card.classList.remove('hidden');
    setTimeout(() => { try { $('shareUrl').select(); } catch (e) {} }, 80);
  }

  async function share() {
    const url = inviteLink();
    // WhatsApp on Android reads the `text` field and can drop a separate `url`, so the
    // link goes in both. This is the difference between the message arriving with a
    // tappable link and arriving as bare words.
    const text = 'Join my Convoy group: ' + url;

    try {
      if (navigator.share) {
        await navigator.share({ title: 'Convoy', text, url });
        return;
      }
    } catch (e) { /* they dismissed the share sheet, or it is unavailable here */ }

    if (await copyText(url)) { banner('Invite link copied — paste it into your chat'); return; }
    showLink(url);
  }

  /* ---------------------------------------------------------------- *
   * Demo — four simulated cars, so one phone can see the whole thing work
   * ---------------------------------------------------------------- */
  let demoTimer = null;
  let demoDestSet = false;

  function startDemo() {
    const c = CFG.fallbackCenter;
    state.me.lat = c.lat; state.me.lng = c.lng;
    state.me.spd = 11; state.me.hdg = 90; state.me.ts = Date.now();
    updateMarker(state.me);

    const names = ['Priya', 'Rahul', 'Meera', 'Arjun'];
    names.forEach((name, i) => {
      const id = 'demo-' + (i + 1);
      state.peers.set(id, {
        id, name, color: PALETTE[0],
        lat: c.lat + (i - 2) * 0.012, lng: c.lng + (i - 2) * 0.014,
        spd: 11 + i, hdg: 90, acc: 6, ts: Date.now(),
        eta: null, isMe: false, demo: true,
        away: false, awayAt: 0, presence: 'live',
        _spd: 10 + i * 1.5,
      });
    });
    refreshColors();
    state.peers.forEach(updateMarker);
    renderPeople();

    if (!state.dest) {
      demoDestSet = true;
      state.dest = { lat: c.lat + 0.055, lng: c.lng + 0.06, label: 'Demo destination', by: 'Convoy' };
      renderDest();
      drawDest();
    }

    demoTimer = setInterval(() => {
      const t = Date.now();
      const me = state.me;
      me.lat += 0.00004; me.lng += 0.00006; me.ts = t; me.spd = 12;
      updateMarker(me);
      state.peers.forEach((p, i) => {
        p.lat += 0.00003 * (i + 1); p.lng += 0.00005 * (i + 1);
        p.ts = t;
        // a plausible arrival time, so the list shows the real thing
        const d = haversine(p, state.dest) * 1.25;
        p.eta = { dur: d / p._spd, dist: d, ts: t };
        updateMarker(p);
      });
      renderPeople();
      maybeAutoView();
    }, 1000);

    setConn('live', 'demo');
    banner('Demo: five cars on one map');
  }

  function stopDemo() {
    if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
    ['demo-1', 'demo-2', 'demo-3', 'demo-4'].forEach((id) => {
      const p = state.peers.get(id);
      if (p && p._marker) map.removeLayer(p._marker);
      state.peers.delete(id);
    });
    if (demoDestSet) { state.dest = null; demoDestSet = false; drawDest(); renderDest(); }
    if (myLine) { map.removeLayer(myLine); myLine = null; }
    renderPeople();
  }

  // "My app is going to the background." Best effort: a force-kill gives no chance to
  // send it, which is exactly why sweepPresence exists as the backstop.
  function goAway() {
    if (!state.joined || demoTimer || state.away) return;
    state.away = true;
    send({ t: 'away' });
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function wire() {
    $('btnGo').addEventListener('click', () => {
      const name = ($('inName').value || '').trim().slice(0, 24) || 'Someone';
      const code = normRoom($('inRoom').value);
      join(name, code || normRoom('trip-' + rand(5)));
    });
    $('inRoom').addEventListener('input', updateGoLabel);
    ['inName', 'inRoom'].forEach((id) => {
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnGo').click(); });
    });

    $('btnDemo').addEventListener('click', () => {
      const name = ($('inName').value || '').trim().slice(0, 24) || 'You';
      state.me = {
        id: 'me-' + rand(6), name, color: PALETTE[0],
        lat: null, lng: null, spd: null, hdg: null, acc: null,
        ts: Date.now(), isMe: true, _first: true,
      };
      state.joined = true;
      state.room = 'demo';
      renderTop();
      $('join').classList.add('hidden');
      $('sheet').classList.remove('hidden');
      $('btnRecenter').classList.remove('hidden');
      startDemo();
    });

    $('btnInvite').addEventListener('click', share);
    $('btnShareClose').addEventListener('click', () => $('shareCard').classList.add('hidden'));
    $('btnLeave').addEventListener('click', () => { stopDemo(); leave(); });
    $('btnRecenter').addEventListener('click', () => {
      state.autoFit = true;
      lastFitAt = 0;
      fitAll();
    });
    $('destRow').addEventListener('click', () => {
      if (window.ConvoyRoute) window.ConvoyRoute.openSearch();
    });
    $('sheetHead').addEventListener('click', () => {
      document.body.classList.toggle('sheet-collapsed');
      setTimeout(renderPeople, 240);
    });

    // Closing the app is NOT leaving the room. It sends the same "away" note as
    // backgrounding does, so the group sees a phone that has gone quiet rather than
    // someone who walked out — and nobody comes off the roster for it.
    // (pagehide above handles that. Only the Leave button sends a real "bye".)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { goAway(); return; }
      if (!state.joined) return;
      if (state.away) {
        // Back on screen: say so and push our state again.
        state.away = false;
        if (client && client.connected) { send({ t: 'back' }); sendState(); }
        else connect();
      } else if (!client || !client.connected) {
        connect();
      }
      renderPeople();
    });
    window.addEventListener('pagehide', goAway);
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */
  function boot() {
    if (typeof L === 'undefined' || typeof mqtt === 'undefined') {
      document.body.innerHTML =
        '<p style="font:16px -apple-system,sans-serif;padding:24px">Could not load the map ' +
        'libraries. Check your connection and reload.</p>';
      return;
    }
    initMap();
    wire();
    if (window.ConvoyRoute) {
      window.ConvoyRoute.init({
        state, esc, setDest, clearDest, toast,
      });
    }
    if (window.ConvoyInstall) window.ConvoyInstall.init();
    $('sheet').classList.add('hidden');
    $('btnRecenter').classList.add('hidden');
    renderDest();

    // A room in the link, or the one we were in last time.
    const hash = roomFromUrl();
    let savedRoom = '';
    let savedName = '';
    let invited = '';
    try {
      savedRoom = localStorage.getItem(LS.room) || '';
      savedName = localStorage.getItem(LS.name) || '';
      invited = localStorage.getItem(LS.invite) || '';
      // An invite link is worth keeping. If they install the app from the link, the
      // installed app opens at the app root and the link's code would be lost.
      if (hash) {
        invited = normRoom(hash);
        localStorage.setItem(LS.invite, invited);
      }
    } catch (e) { /* ignore */ }

    const room = normRoom(hash || savedRoom || invited);
    $('inName').value = savedName;
    $('inRoom').value = room;
    updateGoLabel();

    if (savedName && room) {
      // Opening the app again should land you straight back on the map.
      join(savedName, room);
    } else if (room) {
      toast('Enter your name to join "' + room + '"');
    }
  }

  window.Convoy = {
    CFG, state, esc, toast, setDest, clearDest, join, leave, share, copyText, inviteLink,
    map: () => map, haversine, bearing, fmtDist, fmtClock, normRoom, roomFromUrl,
    _internals: { PALETTE, assignColors, refreshColors, fitAll, maybeAutoView,
                  onMessage, onFix, notify, startDemo, stopDemo, colorFor,
                  presenceOf, sweepPresence, sendState, goAway, saveDest, loadDest,
                  handleTap, wireTapZoom, tap,
                  loadRoom, saveRoom, rememberMember, forgetMember, roomNoteText,
                  roomLifeMs }, 
  };

  boot();
})();
