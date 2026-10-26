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
      // On 443, which is the one port a mobile network will always let through. The
      // others above sit on 8081/8084/8884, and carriers routinely block those — which
      // is why a laptop on Wi-Fi goes live while a phone on mobile data never connects.
      { name: 'Eclipse', url: 'wss://mqtt.eclipseprojects.io:443/mqtt' },
    ],
    retryMs: 1200,            // pause before trying the next relay
    // Chosen for battery life, which matters more on a long drive than a smooth trail of
    // dots. Thirty seconds is still well inside staleMs, so sharing less often can never
    // make anyone look out of contact.
    publishMs: 30000,         // broadcast our position at least this often
    build: 'v22',             // must match VERSION in sw.js; a test holds them together
    renderMs: 3000,           // sweep the list and the view
    etaMs: 300000,            // recompute our arrival time this often
    staleMs: 90000,           // silence this long and a person counts as out of contact
    awayMs: 180000,           // backgrounded this long counts as out of contact too
    // A room stays open this long after anyone last used it. Nobody is ever dropped
    // from the room while it is open — a quiet phone just sits there as out of contact.
    roomDays: 7,
    arrivedM: 50,             // within this much of the destination counts as arrived
    behindM: 200,             // this much further from it counts as "behind you"
    minMoveM: 12,             // publish early if we moved this far
    fallbackCenter: { lat: -33.8688, lng: 151.2093 },  // Sydney, until GPS arrives
    fallbackZoom: 11,
    // One tap zooms out, two zoom in. The wait is how long a single tap is held back to
    // see whether a second one is coming, and the tolerance is how far a finger may
    // wander before it counts as a pan rather than a tap.
    tapZoom: { delayMs: 260, moveTolerancePx: 12 },
  };

  const PALETTE = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de',
                   '#5ac8fa', '#b58900', '#ff2d55', '#30d158', '#5856d6'];

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
    paused: false,        // hidden from the map: deliberately not sharing our position
    roomName: '',         // a human name for the room, shared with everyone in it
    roomNameTs: 0,        // when it was last named; newest wins, like the destination
    arrived: false,       // we have reached the destination (or said we have)
    focused: '',          // the car whose name is showing because it was tapped
  };

  let map = null;
  let client = null;
  let brokerIdx = 0;
  let publishTimer = null;
  let renderTimer = null;
  let etaTimer = null;
  let audio = null;                 // lazily built on the first tap; browsers block it before

  /* Sound, so a notification is noticed while driving. iOS has no vibration at all, and
     every browser refuses to make a sound until the user has touched the page — so the
     audio context is built on the first tap and reused from then on. */
  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audio) audio = new Ctx();
      if (audio.state === 'suspended' && audio.resume) audio.resume();
    } catch (e) { audio = null; }
  }

  function ping() {
    if (!audio) return;
    try {
      const now = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    } catch (e) { /* a failed sound is not worth reporting */ }
  }
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

  /* ---------------------------------------------------------------- *
   * Arrivals
   * ---------------------------------------------------------------- */
  function distToDest(p) {
    if (!state.dest || !p || p.lat == null) return null;
    return haversine(p, state.dest);
  }

  // A new destination means nobody has arrived yet.
  function resetArrivals() {
    state.arrived = false;
    state.peers.forEach((p) => { p.arrived = false; });
  }

  // Called on the sweep and on every fix. Whoever is within reach of the destination has
  // arrived, and the room is told once.
  function checkArrivals() {
    if (!state.dest) return;
    let changed = false;
    const mine = distToDest(state.me);
    if (mine != null && mine <= CFG.arrivedM && !state.arrived) {
      state.arrived = true;
      changed = true;
      send({ t: 'arrived', on: true });
      notify('You have arrived', state.dest.label);
      renderControls();
    }
    state.peers.forEach((p) => {
      const d = distToDest(p);
      if (d == null || p.arrived || d > CFG.arrivedM) return;
      p.arrived = true;
      changed = true;
      notify(p.name + ' has arrived', state.dest.label);
    });
    // Redraw here rather than leaving it to the caller, so the arrival time on screen is
    // replaced by "arrived" the moment it happens.
    if (changed) renderPeople();
  }

  function onArrived(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    const on = msg.on !== false;
    if (on && !p.arrived) {
      notify(p.name + ' has arrived', state.dest ? state.dest.label : '');
    }
    p.arrived = on;
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Not sharing my position
   * ---------------------------------------------------------------- */
  function setPaused(on) {
    state.paused = !!on;
    send({ t: state.paused ? 'paused' : 'sharing' });
    if (!state.paused) publishNow(true);
    banner(state.paused ? 'Not sharing your location' : 'Sharing your location again');
    renderControls();
    renderPeople();
  }

  function onPaused(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    p.paused = true;
    renderPeople();
  }

  function onSharing(msg) {
    const p = state.peers.get(msg.id);
    if (!p) return;
    p.paused = false;
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Naming the room
   * ---------------------------------------------------------------- */
  function setRoomName(name) {
    const clean = String(name || '').trim().slice(0, 32);
    state.roomName = clean;
    state.roomNameTs = Date.now();
    saveRoom({ name: clean, nameTs: state.roomNameTs });
    send({ t: 'room-name', name: clean, ts: state.roomNameTs });
    renderTop();
    renderControls();
  }

  // Same rule as the destination: the newest decision wins, so a phone coming back cannot
  // put an old name over a newer one.
  function onRoomName(msg) {
    const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
    if (ts < state.roomNameTs) return;
    state.roomNameTs = ts;
    state.roomName = String(msg.name || '').slice(0, 32);
    saveRoom({ name: state.roomName, nameTs: ts });
    renderTop();
  }

  // Where each person stands. "away" is something they told us; "lost" is what we
  // infer when the messages simply stop. A force-kill cannot announce itself — that
  // is the one thing a killed app cannot do — so it lands here as lost contact.
  function presenceOf(p) {
    if (p.isMe) return 'me';
    // They told us they are not sharing, so say that rather than guessing from silence.
    if (p.paused) return 'paused';
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
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // Dragging or zooming by hand hands the view back to you.
    map.on('dragstart zoomstart', () => {
      if (Date.now() - lastAutoView > 700) { state.autoFit = false; }
    });
    // A long press on a touch screen, or a right-click with a mouse — Leaflet reports both
    // as a contextmenu event, so one handler covers the whole lot.
    map.on('contextmenu', onMapLongPress);
    wireTapZoom(map.getContainer());
  }

  // Set the destination wherever a finger is held down. Then look up what is there, so the
  // row reads as an address rather than a pair of numbers — and if that fails, say so
  // honestly and keep the pin.
  function onMapLongPress(e) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    banner('Setting the destination\u2026');
    const apply = (label) => {
      setDest(lat, lng, label || 'Pinned location');
      banner('Destination set');
    };
    const R = window.ConvoyRoute;
    if (R && R.reverse) {
      R.reverse(lat, lng).then(apply).catch(() => apply(''));
    } else {
      apply('');
    }
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

  /* Every name on the map at once collides into one unreadable stack the moment cars are
     close — which is exactly when the map matters. So the map names your own car, the
     nearest one, and whichever car you have tapped. The dots always show everyone. */
  function nearestPeer() {
    const me = state.me;
    if (!me || me.lat == null) return null;
    let best = null;
    let bestD = Infinity;
    state.peers.forEach((p) => {
      if (p.lat == null) return;
      const d = haversine(me, p);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  function labelledIds() {
    const ids = new Set();
    if (state.me && state.me.id) ids.add(state.me.id);
    const near = nearestPeer();
    if (near) ids.add(near.id);
    if (state.focused) ids.add(state.focused);
    return ids;
  }

  function makeIcon(p, showLabel) {
    const html =
      '<div class="mk' + (p.isMe ? ' me' : '') + '" style="color:' + p.color + '">' +
        '<span class="dot"></span>' +
        (showLabel ? '<span class="lbl">' + esc(p.name) + '</span>' : '') +
      '</div>';
    return L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  function ensureMarker(p) {
    if (p._marker) return p._marker;
    p._labelled = labelledIds().has(p.id);
    p._marker = L.marker([p.lat, p.lng], {
      icon: makeIcon(p, p._labelled), keyboard: false, zIndexOffset: p.isMe ? 1000 : 0,
    }).addTo(map);
    if (!p.isMe) {
      // Tapping a car names it and brings the map to it.
      p._marker.on('click', () => {
        state.focused = p.id;
        focusPeer(p.id);
        renderMarkers();
      });
    }
    return p._marker;
  }

  // Only redraw an icon when whether it carries a name actually changes.
  function renderMarkers() {
    const labels = labelledIds();
    allPeople().forEach((p) => {
      if (!p._marker) return;
      const want = labels.has(p.id);
      if (p._labelled === want) return;
      p._labelled = want;
      p._marker.setIcon(makeIcon(p, want));
      const el = p._marker.getElement();
      if (el) el.classList.toggle('stale', !p.isMe && isStale(p));
    });
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

  // Only people whose position we actually know. A phone brought back from the room's
  // roster has no coordinates yet, and a null in a bounds calculation throws inside
  // Leaflet — which used to take the whole screen down with it, leaving the search sheet
  // stuck open over a destination that had in fact been set.
  function allPeople() {
    const list = [];
    if (state.me && state.me.lat != null && state.me.lng != null) list.push(state.me);
    state.peers.forEach((p) => {
      if (p.lat != null && p.lng != null) list.push(p);
    });
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
    if (state.paused) return;          // deliberately not sharing
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
    if (state.roomName) send({ t: 'room-name', name: state.roomName, ts: state.roomNameTs });
    if (state.paused) send({ t: 'paused' });
    if (state.arrived) send({ t: 'arrived', on: true });
  }

  function onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    if (!msg || !msg.id || (state.me && msg.id === state.me.id)) return;

    // Any word at all from someone is proof they were still there just now.
    const who = state.peers.get(msg.id);
    if (who) who.lastSeen = Date.now();

    switch (msg.t) {
      case 'hello':      onHello(msg); return;
      case 'bye':        onBye(msg); return;
      case 'dest':       onDest(msg); return;
      case 'dest-clear': onDestClear(msg); return;
      case 'eta':        onEta(msg); return;
      case 'away':       onAway(msg); return;
      case 'back':       onBack(msg); return;
      case 'pos':        onPos(msg); return;
      case 'paused':     onPaused(msg); return;
      case 'sharing':    onSharing(msg); return;
      case 'arrived':    onArrived(msg); return;
      case 'room-name':  onRoomName(msg); return;
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
        lastSeen: Date.now(), paused: false, arrived: false,
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
    resetArrivals();                 // a new destination: nobody is there yet
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
    ping();
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
  /* A relay can fail for three very different reasons and they look identical from here:
     the network blocks the port, the broker is down, or the app is at fault. This opens a
     plain WebSocket to each relay and says which of those it is — the one question that
     cannot be answered from inside a connection attempt. */
  function probeRelay(url, ms) {
    return new Promise((resolve) => {
      let done = false;
      let ws = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        try { if (ws) ws.close(); } catch (e) { /* ignore */ }
        resolve(result);
      };
      try {
        ws = new WebSocket(url);
      } catch (e) { resolve('blocked'); return; }
      const timer = setTimeout(() => finish('no answer'), ms);
      ws.onopen = () => { clearTimeout(timer); finish('reached'); };
      ws.onerror = () => { clearTimeout(timer); finish('blocked'); };
      ws.onclose = () => { clearTimeout(timer); finish('blocked'); };
    });
  }

  async function showConnection() {
    const card = $('connCard');
    const list = $('connList');
    if (!card || !list) return;
    card.classList.remove('hidden');
    list.innerHTML = CFG.brokers.map((b) =>
      '<li><span class="rdot"></span>' + esc(b.name) + '<em>checking…</em></li>').join('');

    const buildLine = $('connBuild');
    if (buildLine) buildLine.textContent = 'Build ' + CFG.build + ' · ' + CFG.brokers.length + ' relays';

    const results = await Promise.all(CFG.brokers.map((b) => probeRelay(b.url, 6000)));
    const rows = list.querySelectorAll('li');
    results.forEach((r, i) => {
      const li = rows[i];
      if (!li) return;
      li.className = r === 'reached' ? 'ok' : 'bad';
      const em = li.querySelector('em');
      if (em) em.textContent = r;
    });

    if (results.indexOf('reached') < 0) {
      banner('This network is blocking every relay. Try Wi-Fi.');
    } else if (!client || !client.connected) {
      connect();          // one of them answers, so try the real thing again
    }
  }

  function setConn(kind, text) {
    const el = $('connState');
    el.className = 'conn' + (kind === 'live' ? ' live' : '');
    el.textContent = text;
  }

  /* GitHub Pages serves its files with a ten-minute cache, so a phone can sit on old code
     for a while without anything looking wrong. Ask for a new service worker explicitly
     when the app opens and whenever it comes back to the front. */
  function checkForUpdate() {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = navigator.serviceWorker.getRegistration;
      if (!reg) return;
      reg.call(navigator.serviceWorker).then((r) => { if (r && r.update) r.update(); })
        .catch(() => {});
    } catch (e) { /* ignore */ }
  }

  let connFailures = 0;
  let toldAboutRelay = false;

  /* A phone on mobile data very often cannot reach any of these relays: they listen on
     ports 8081, 8084 and 8884, and carriers block everything but 80 and 443. Sitting on
     "connecting" for ever tells nobody anything, so after a few failures the app says
     what it thinks is happening. */
  function noteRelayFailure() {
    connFailures++;
    if (connFailures < 3) return;
    setConn('', 'relay unreachable');
    if (toldAboutRelay) return;
    toldAboutRelay = true;
    banner('Cannot reach the relay from this network — mobile data often blocks it. Try Wi-Fi.');
  }

  const connLabel = (whileTrying) =>
    (connFailures >= 3 ? 'relay unreachable' : whileTrying);

  function connect() {
    const b = CFG.brokers[brokerIdx % CFG.brokers.length];
    setConn('', connLabel('connecting'));
    let settled = false;
    let counted = false;
    const fail = () => { if (counted) return; counted = true; noteRelayFailure(); };

    try {
      client = mqtt.connect(b.url, { clientId: state.me.id, clean: true, reconnectPeriod: 0 });
    } catch (e) {
      retry();
      return;
    }

    client.on('connect', () => {
      settled = true;
      connFailures = 0;
      toldAboutRelay = false;
      setConn('live', 'live');
      client.subscribe(state.topic, { qos: 0 }, () => {});
      sendState();          // push everything we know, so nobody has to hold it for us
      refreshRoute();
    });
    client.on('message', onMessage);
    client.on('error', () => { if (!settled) { fail(); retry(); } });
    client.on('close', () => {
      setConn('', 'offline');
      if (!settled) { fail(); retry(); }
      else scheduleReconnect();
    });
  }

  function retry() {
    brokerIdx++;
    setConn('', connLabel('trying another relay'));
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, CFG.retryMs);
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, 4000);
  }

  /* ---------------------------------------------------------------- *
   * Location
   * ---------------------------------------------------------------- */
  let geoWatch = null;

  function stopWatching() {
    if (geoWatch == null || !navigator.geolocation) return;
    try { navigator.geolocation.clearWatch(geoWatch); } catch (e) { /* ignore */ }
    geoWatch = null;
  }

  /* Arming this again is the whole point. A phone that has been in the background, or
     whose app was force-quit and reopened, very often comes back with its location watch
     gone — and then you are on nobody's map, not even your own. So it is re-armed every
     time we come back to the screen, and on any touch while we still have no position
     (iOS will not hand over a location until the page has been touched). */
  function startWatching() {
    if (!navigator.geolocation) { banner('This device cannot share its location'); return; }
    stopWatching();
    try {
      geoWatch = navigator.geolocation.watchPosition(onFix, onGeoError, {
        enableHighAccuracy: true, maximumAge: 4000, timeout: 20000,
      });
    } catch (e) { banner('This device cannot share its location'); }
  }

  const haveMyPosition = () => !!(state.me && state.me.lat != null && state.me.lng != null);

  function nudgeForLocation() {
    if (!state.joined || state.paused || haveMyPosition()) return;
    banner('Tap anywhere to share your location');
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

    $('peopleCount').textContent = rows.length + (rows.length === 1 ? ' person' : ' people') +
      (state.dest ? '' : ' · no destination');

    if (!rows.length) {
      ul.innerHTML = '<li class="empty">Waiting for others to join…</li>';
    } else {
      ul.innerHTML = rows.join('');
    }

    renderMarkers();

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
    // One mention in the header beats five in the rows. Repetition at that density stops
    // being information and becomes texture.
    if (!state.dest) return '';
    // Nobody presses the button if they do not have to: coming within reach of the
    // destination is arriving. Until that happens the arrival time stays on screen — it is
    // the one thing everyone actually watches.
    if (p.arrived || (p.isMe && state.arrived)) {
      return '<span class="peta arrived">arrived</span>';
    }
    const eta = p.isMe ? state.myEta : p.eta;
    if (!eta) return '<span class="peta">—</span>';
    const arrive = eta.ts + eta.dur * 1000;
    return '<span class="peta"><b>' + esc(fmtClock(arrive)) + '</b>' +
           esc(fmtDist(eta.dist)) + '</span>';
  }

  // "3.2 km behind you" is more use than a bearing: what matters in a convoy is who is
  // ahead and who has fallen back.
  function behindAhead(me, p) {
    if (!state.dest || !me || me.lat == null || p.lat == null) return '';
    const diff = haversine(p, state.dest) - haversine(me, state.dest);
    if (Math.abs(diff) < CFG.behindM) return 'alongside you';
    return fmtDist(Math.abs(diff)) + (diff > 0 ? ' behind you' : ' ahead of you');
  }

  // When we last heard from someone: this session if we have, otherwise what the room's
  // roster remembered from last time. "Out of contact" on its own is too vague to act on.
  function lastSeenOf(p) {
    if (p.lastSeen) return p.lastSeen;
    if (p.lat != null && p.ts) return p.ts;
    const rec = loadRoom(state.room);
    const m = rec && rec.members && rec.members[p.id];
    return (m && m.lastSeen) || p.ts || 0;
  }

  // A bearing and a zero distance is noise. Inside fifty metres, say what it means.
  function nearText(me, p) {
    const d = haversine(me, p);
    return d < 50 ? 'next to you' : fmtDist(d) + ' ' + compass(bearing(me, p));
  }

  function rowFor(p, me) {
    const kind = presenceOf(p);
    let meta = '';
    let tag = '';
    if (p.isMe) {
      // Say so plainly rather than showing a bare "you" with no dot on the map.
      meta = p.lat == null ? 'waiting for your location'
           : state.away ? 'app in the background' : 'you';
      if (state.arrived) tag = 'arrived';
    } else if (kind === 'paused') {
      meta = 'location hidden';
      tag = 'hidden';
    } else if (p.lat == null) {
      const seen = lastSeenOf(p);
      meta = seen ? 'out of contact · last seen ' + fmtAgo(seen) : 'out of contact';
    } else if (kind === 'away') {
      meta = 'app in the background';
    } else if (kind === 'lost') {
      meta = 'out of contact · last seen ' + fmtAgo(lastSeenOf(p));
    } else {
      meta = behindAhead(me, p) || (me && me.lat != null ? nearText(me, p) : '');
    }
    // "You you": never let the tag repeat the name it sits beside.
    if (p.isMe && meta && String(p.name).toLowerCase() === meta.toLowerCase()) meta = '';
    if (p.arrived && !p.isMe) tag = 'arrived';
    return '<li data-id="' + esc(p.id) + '" class="' +
      (kind === 'lost' ? 'lost ' : '') + (kind === 'away' ? 'away ' : '') +
      (kind === 'paused' ? 'paused ' : '') + '">' +
      '<span class="pdot" style="background:' + p.color + '"></span>' +
      '<span class="pname">' + esc(p.name) +
        (meta ? '<span class="tag">' + esc(meta) + '</span>' : '') + '</span>' +
      (tag ? '<span class="ptag">' + esc(tag) + '</span>' : '') +
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
    // The chip always shows the CODE, never the name. The code is the only thing that puts
    // two phones in the same room, so hiding it behind a friendly name is how someone ends
    // up typing the name into the code box and landing in a different room altogether.
    $('roomChip').textContent = state.room || '—';
    $('roomChip').title = state.roomName || '';
    if ($('inRoomName')) $('inRoomName').value = state.roomName || '';
  }

  // The one switch in the sheet. Internally this is still "paused"; on screen it says what
  // it actually does, which is take you off the map.
  function renderControls() {
    const el = $('btnPause');
    if (!el) return;
    el.classList.toggle('on', !!state.paused);
    el.textContent = state.paused ? 'Location hidden' : 'Hide my location';
    el.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
  }

  // Tapping a person brings the map to them. It also stops the view chasing everybody.
  function focusPeer(id) {
    const p = state.peers.get(id);
    if (!p || p.lat == null) return;
    state.autoFit = false;
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
    banner('Showing ' + p.name);
  }

  // Pasting a whole invite link into the code box should just work.
  function extractRoomCode(text) {
    const m = String(text || '').match(/[#?&]r=([^&\s]+)/i);
    if (!m) return '';
    try { return normRoom(decodeURIComponent(m[1])); }
    catch (e) { return normRoom(m[1]); }
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
    resetArrivals();                 // a new destination: nobody is there yet
    renderDest();
    // From here on it is drawing and telling the room. None of that may be allowed to
    // stop the caller: a map or network hiccup must never leave a screen stuck.
    try {
      drawDest();
      refreshRoute();
      saveDest();
      send({ t: 'dest', lat, lng, label: state.dest.label, by: state.dest.by, ts: state.destTs });
      state.autoFit = true;
      lastFitAt = 0;
      fitAll();
    } catch (e) { /* the destination is set; the rest is best effort */ }
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
      checkArrivals();
      renderPeople();
      maybeAutoView();
    }, CFG.renderMs);
    etaTimer = setInterval(refreshRoute, CFG.etaMs);
  }

  function stopTimers() {
    [publishTimer, renderTimer, etaTimer].forEach((t) => { if (t) clearInterval(t); });
    publishTimer = renderTimer = etaTimer = null;
  }

  /* Keep the screen awake while the app is in front, the way a maps app does. Two things
     make this less simple than one request: the browser drops the lock the moment the page
     is hidden and never gives it back on its own, and iOS refuses outright in Low Power
     Mode. So it is asked for again on every return to the screen and on any touch. */
  async function askWakeLock() {
    if (state.wakeLock) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      // Let go of our copy when the browser takes it away, or we would never ask again.
      if (lock && lock.addEventListener) {
        lock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (e) {
      state.wakeLock = null;      // Low Power Mode, or a browser that will not allow it
    }
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
    state.focused = '';

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
    // A name the room was given last time, and nobody has arrived yet.
    state.roomName = (rec && rec.name) || '';
    state.roomNameTs = (rec && rec.nameTs) || 0;
    state.arrived = false;
    if ($('inRoomName')) $('inRoomName').value = state.roomName;
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
    renderControls();
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

  // `?r=` rather than `#r=`: the app reads either, but a query string survives chat apps,
  // link previewers and shorteners more reliably than a fragment does.
  const inviteLink = () => location.origin + location.pathname +
    '?r=' + encodeURIComponent(state.room);

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
    // The code first, because typing a code into the app beats tapping a link — a link on
    // an iPhone can only ever open Safari. The link is still there for anyone who has not
    // got the app yet, and it goes in the `text` as well as the `url`, because WhatsApp on
    // Android reads `text` and can drop a separate `url`.
    const text = 'Join my Convoy group \u2014 tap this:\n' + url +
                 '\n\nOr open Convoy and use the code ' + state.room +
                 ' (capitals do not matter).';

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

    // Carrying the code from Safari into the installed app is the one manual step an iPhone
    // forces, so make it a copy and a paste rather than reading it off one screen.
    $('btnCopyCode').addEventListener('click', async () => {
      const code = normRoom($('inRoom').value);
      if (!code) { banner('No code to copy yet'); return; }
      banner(await copyText(code) ? 'Code copied' : 'Copy the code: ' + code);
    });

    // The one switch in the sheet.
    $('btnPause').addEventListener('click', () => setPaused(!state.paused));
    $('inRoomName').addEventListener('change', () => setRoomName($('inRoomName').value));

    // Tapping someone brings the map to them.
    $('people').addEventListener('click', (e) => {
      const li = e.target && e.target.closest ? e.target.closest('li[data-id]') : null;
      if (li) focusPeer(li.getAttribute('data-id'));
    });

    // Pasting the whole invite link into the code box should just work.
    $('inRoom').addEventListener('input', () => {
      const code = extractRoomCode($('inRoom').value);
      if (code) { $('inRoom').value = code; updateGoLabel(); }
    });

    // Every browser refuses to make a sound until the page has been touched, so the audio
    // context is built on the first touch of any kind.
    ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
      window.addEventListener(ev, unlockAudio, { once: true, passive: true });
    });
    // And any touch at all, while we still have no position, tries the watch again —
    // which is what iOS needs before it will hand over a location.
    ['pointerdown', 'touchstart'].forEach((ev) => {
      window.addEventListener(ev, () => {
        askWakeLock();      // a refused screen lock is often allowed after a touch
        if (state.joined && !state.paused && !haveMyPosition()) startWatching();
      }, { passive: true });
    });
    $('btnLeave').addEventListener('click', () => { stopDemo(); leave(); });
    $('btnRecenter').addEventListener('click', () => {
      state.autoFit = true;
      lastFitAt = 0;
      fitAll();
    });
    $('btnClearDest').addEventListener('click', clearDest);
    $('connState').addEventListener('click', showConnection);
    checkForUpdate();
    $('btnConnClose').addEventListener('click', () => $('connCard').classList.add('hidden'));
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
      unlockAudio();          // iOS suspends the audio context when the app is put away
      // The screen lock is dropped while we are hidden, and the location watch is often
      // lost too. Both are taken again every time we come back.
      askWakeLock();
      checkForUpdate();
      startWatching();
      if (!haveMyPosition()) setTimeout(nudgeForLocation, 2500);
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

    // If the name went missing but the room did not, the room's own roster has it — we
    // put ourselves in it when we joined. Nothing else is needed to come back.
    if (!savedName) {
      const rec = loadRoom(normRoom(savedRoom || invited));
      const mine = rec && rec.members && rec.members[myId()];
      if (mine && mine.name) savedName = mine.name;
    }

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
                  presenceOf, sweepPresence, sendState, goAway, saveDest, loadDest, allPeople,
                  handleTap, wireTapZoom, tap,
                  loadRoom, saveRoom, rememberMember, forgetMember, roomNoteText,
                  roomLifeMs,
                  // The switches, the arrival logic, and the small helpers behind them.
                  setPaused, checkArrivals, resetArrivals,
                  distToDest, focusPeer, behindAhead, lastSeenOf, extractRoomCode,
                  setRoomName, renderControls, renderTop, renderPeople,
                  unlockAudio, ping, onMapLongPress, rowFor, publishNow, send,
                  renderMarkers, labelledIds, nearestPeer, nearText, noteRelayFailure,
                  probeRelay, showConnection, checkForUpdate,
                  startWatching, stopWatching, haveMyPosition, nudgeForLocation,
                  askWakeLock },
  };

  boot();
})();
