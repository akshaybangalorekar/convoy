/* Convoy — everyone on one map.
 *
 * Three things, and nothing else:
 *   1. Invite people with a link; anyone in the group can start one.
 *   2. Anyone can set the destination. Everyone sees every car and each
 *      person's arrival time at that destination.
 *   3. A notification when the destination changes, or someone joins or leaves.
 *
 * Positions, destinations and arrival times travel as small JSON messages on one
 * public MQTT topic. There is no server and no account.
 *
 * One honest limit: notifications only arrive while the app is open, because
 * without a server there is nothing to wake a closed app. The in-app banner and
 * the phone's vibration always fire; the system notification needs the app alive.
 */
(function () {
  'use strict';

  const CFG = {
    topic: 'sarvam-convoy/v1/convoy/bus',
    // Public, no-signup MQTT brokers over WebSocket. Tried in order.
    // Ordered by how likely each is to be reachable outdoors: the first listens on 443,
    // the one port a mobile network always lets through, and the rest sit on
    // 8081/8084/8884, which carriers routinely block. That is why a laptop on Wi-Fi goes
    // live while a phone on mobile data never connects.
    brokers: [
      { name: 'Eclipse', url: 'wss://mqtt.eclipseprojects.io:443/mqtt' },
      { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
      { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
      { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/' },
    ],
    // The master pin is not written here as a number: what is compared is a hash of it,
    // so the digits do not appear in the source. This keeps honest people honest; it is
    // not security, since anyone reading this file can find a way round it in a minute.
    masterHash: 0x44169612,
    retryMs: 1200,            // pause before trying the next relay
    reconnectMs: 3000,        // pause before reconnecting to one that worked
    keepalive: 30,            // seconds; mobile networks drop idle sockets well before 60
    stableMs: 60000,          // a connection that lasted this long was not a flap
    // Chosen for battery life, which matters more on a long drive than a smooth trail of
    // dots. Thirty seconds is still well inside staleMs, so sharing less often can never
    // make anyone look out of contact.
    publishMs: 30000,         // broadcast our position at least this often
    build: 'v68',             // must match VERSION in sw.js; a test holds them together
    renderMs: 3000,           // sweep the list and the view
    etaMs: 300000,            // recompute our arrival time this often
    staleMs: 90000,           // silence this long and a person counts as out of contact
    awayMs: 180000,           // backgrounded this long counts as out of contact too
    // One blanket rule: anyone who has been in the convoy stays for this long after the
    // last time they were heard from, and is then dropped off on their own. No codes, no
    // lifetime to manage, nothing to administer.
    keepDays: 7,
    arrivedM: 50,             // within this much of the destination counts as arrived
    behindM: 200,             // this much further from it counts as "behind you"
    minMoveM: 12,
    askFreshMs: 1800000,     // a retained request older than half an hour is stale
    lostNoticeMs: 1800000,   // say "out of contact" about a person at most this often
    // In the background a phone keeps reporting, so the group still knows roughly where
    // everyone is: every five minutes, for four hours after you were last on the app, or
    // until you arrive.
    bgMs: 300000,
    bgForMs: 14400000,
    bgStaleMs: 390000,       // a backgrounded phone may be this quiet before it counts as lost
    liveFlashMs: 2000,       // the green bar shows this long once connected, then goes
    fallbackCenter: { lat: -33.8688, lng: 151.2093 },  // Sydney, until GPS arrives
    fallbackZoom: 11,
    // One tap zooms out, two zoom in. The wait is how long a single tap is held back to
    // see whether a second one is coming, and the tolerance is how far a finger may
    // wander before it counts as a pan rather than a tap.
    tapZoom: { delayMs: 260, moveTolerancePx: 12 },
  };

  const PALETTE = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de',
                   '#5ac8fa', '#b58900', '#ff2d55', '#30d158', '#5856d6'];

  const LS = { name: 'convoy.name', id: 'convoy.me', record: 'convoy.record' };

  const state = {
    me: null,
    peers: new Map(),     // id -> person
    seen: new Set(),      // ids we have announced, so a join notifies once
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
    paused: false,        // hidden from the map: deliberately not sharing our position
    arrived: false,       // we have reached the destination (or said we have)
    focused: '',          // the car whose name is showing because it was tapped
    headingUp: true,      // turn the map so the way you are going is up
    relay: '',            // which relay we are on, shown in Help
    lastError: '',        // the last thing the relay actually said, for the connection card
    lastErrorRelay: '',
    joinAsked: false,     // has this phone asked to be let in, and not withdrawn it
                          // (kept in localStorage too, so a reload does not lose it)
    lastHeard: 0,         // when anything last arrived from anyone
    lastActive: 0,        // when you were last actually on the app
    liveAt: 0,            // when the connection last came up, for the green flash
    connWas: '',          // so a transition can be noticed
    bgUntil: 0,           // keep reporting in the background until this moment
    master: false,        // this phone has the pin, so it can add and remove people
    removed: new Set(),   // ids the master has taken off the group
    allowed: new Set(),   // ids the pin has let in; everyone else is kept out
    pending: new Map(),   // people asking to be let in — only a master ever fills this
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
  // arrived, and the group is told once.
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

  // Where each person stands. "away" is something they told us; "lost" is what we
  // infer when the messages simply stop. A force-kill cannot announce itself — that
  // is the one thing a killed app cannot do — so it lands here as lost contact.
  function presenceOf(p) {
    if (p.isMe) return 'me';
    // They told us they are not sharing, so say that rather than guessing from silence.
    if (p.paused) return 'paused';
    if (p.lat == null) {
      // Heard from them, but they have no position to give: a phone with location
      // switched off. That is not being out of contact, and saying so would be wrong.
      return (Date.now() - (p.lastSeen || 0) > CFG.staleMs) ? 'lost' : 'noloc';
    }
    /* A phone in the background reports every five minutes, so it is given much longer
       before it counts as out of contact — and a fresh report always beats the away flag,
       because a phone that is still talking is not a phone that is gone. */
    const limit = p.away ? CFG.bgStaleMs : CFG.staleMs;
    if (Date.now() - (p.ts || 0) > limit) return 'lost';
    return p.away ? 'away' : 'live';
  }

  /* The destination is a decision, not a measurement, so it is the one piece of shared
     state worth keeping on the phone: a phone that comes back restores it and announces
     it, and no server has to hold it. Positions are deliberately not kept — a stale
     position is worse than none. */
  /* One record on the phone, no rooms: who has been in the convoy and when they were last
     heard from, who has been let in and who has been turned away, and the destination.
     A phone that comes back restores all of it, and no server has to hold any of it.
     Positions are deliberately not kept — a stale position is worse than none. */
  const keepMs = () => CFG.keepDays * 86400000;

  function loadRecord() {
    try {
      const raw = localStorage.getItem(LS.record);
      if (!raw) return null;
      const j = JSON.parse(raw);
      return (j && typeof j === 'object') ? j : null;
    } catch (e) { return null; }
  }

  function saveRecord(patch) {
    try {
      const cur = loadRecord() || { members: {} };
      const next = Object.assign({}, cur, patch || {});
      localStorage.setItem(LS.record, JSON.stringify(next));
      return next;
    } catch (e) { return null; }
  }

  function saveDest() {
    saveRecord({ dest: state.dest, destTs: state.destTs });
  }

  function loadDest() {
    const r = loadRecord();
    if (!r) return null;
    return { dest: r.dest || null, ts: typeof r.destTs === 'number' ? r.destTs : 0 };
  }

  // Who has been in the convoy. Written when someone first appears, and refreshed now and
  // then — not on every position, which would hammer the phone's storage.
  function rememberMember(id, name, seenAt) {
    if (!id) return;
    const r = loadRecord();
    const members = Object.assign({}, (r && r.members) || {});
    const prev = members[id] || {};
    members[id] = { name: name || prev.name || 'Someone', lastSeen: seenAt || Date.now() };
    saveRecord({ members });
  }

  function forgetMember(id) {
    if (!id) return;
    const r = loadRecord();
    if (!r || !r.members || !r.members[id]) return;
    const members = Object.assign({}, r.members);
    delete members[id];
    saveRecord({ members });
  }

  /* The blanket rule, applied to the roster as well as the list: anyone whose last sign of
     life is older than a week is taken off both, so they do not come back on a reload. */
  function pruneRoster() {
    const r = loadRecord();
    if (!r || !r.members) return;
    const cut = Date.now() - keepMs();
    const members = {};
    let changed = false;
    Object.keys(r.members).forEach((id) => {
      const m = r.members[id] || {};
      if (typeof m.lastSeen === 'number' && m.lastSeen < cut) { changed = true; return; }
      members[id] = m;
    });
    if (changed) saveRecord({ members });
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
    const changed = assignColors();
    renderDest();                 // the destination dot wears the setter's colour
    if (!changed) return;
    allPeople().forEach((p) => {
      if (p._marker) p._marker.setIcon(makeIcon(p));
      if (p._line) p._line.setStyle({ color: p.color });
    });
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Map
   * ---------------------------------------------------------------- */
  /* The standard OpenStreetMap tiles: keyless, and the only source that reliably is. The
     styled basemaps that look like a phone map all want an API key now, and a key in the
     source is not something this app can ship. Night is the same tiles darkened. */
  const TILES = { day: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' };
  let tiles = null;

  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: false,   // the credit lives in Help, not over the map
      // Only does anything if the rotate plugin loaded; Leaflet ignores what it does not
      // know, so without the plugin this is a plain north-up map.
      rotate: true,
      rotateControl: false,        // we show our own badge instead
      touchRotate: false,
      doubleClickZoom: false,   // we do our own double tap, below
    }).setView([CFG.fallbackCenter.lat, CFG.fallbackCenter.lng], CFG.fallbackZoom);
    tiles = L.tileLayer(TILES.day, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
    const apply = (label) => {
      setDest(lat, lng, label || 'Pinned location');
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

  /* A car rather than a dot, in the person's own colour and turned to face the way they
     are heading. Nothing on the map is ever grey: a colour is how you tell one car from
     another, and greying one out takes that away. */
  function makeIcon(p, showLabel) {
    const hdg = typeof p.hdg === 'number' ? Math.round(p.hdg) : 0;
    const html =
      '<div class="mk' + (p.isMe ? ' me' : '') + '" style="color:' + p.color + '">' +
        '<svg class="car" viewBox="0 0 24 24" aria-hidden="true">' +
          '<g transform="rotate(' + hdg + ' 12 12)">' +
            '<rect x="7" y="2.6" width="10" height="18.8" rx="3.4" ' +
              'fill="currentColor" stroke="#fff" stroke-width="1.7" />' +
            '<rect x="9.1" y="6" width="5.8" height="4.1" rx="1.3" ' +
              'fill="#fff" opacity="0.9" />' +
            '<rect x="9.1" y="14.6" width="5.8" height="3.6" rx="1.3" ' +
              'fill="#fff" opacity="0.55" />' +
          '</g>' +
        '</svg>' +
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
      const hdg = typeof p.hdg === 'number' ? Math.round(p.hdg) : 0;
      if (p._labelled === want && p._hdg === hdg) return;
      p._labelled = want;
      p._hdg = hdg;
      p._marker.setIcon(makeIcon(p, want));
      const el = p._marker.getElement();
      if (el) el.classList.toggle('stale', !p.isMe && isStale(p));
    });
  }

  const hasFix = (o) => !!o && typeof o.lat === 'number' && typeof o.lng === 'number' &&
    isFinite(o.lat) && isFinite(o.lng);

  function updateMarker(p) {
    if (!hasFix(p)) return;              // restored from the roster, no position yet
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

  // Only people whose position we actually know. A phone brought back from the
  // roster has no coordinates yet, and a null in a bounds calculation throws inside
  // Leaflet — which used to take the whole screen down with it, leaving the search sheet
  // stuck open over a destination that had in fact been set.
  function allPeople() {
    const list = [];
    if (hasFix(state.me)) list.push(state.me);
    state.peers.forEach((p) => { if (hasFix(p)) list.push(p); });
    return list;
  }

  function fitAll() {
    const people = allPeople();
    if (!people.length) return;
    lastAutoView = Date.now();
    if (people.length === 1) { map.setView([people[0].lat, people[0].lng], 16); return; }
    const bounds = L.latLngBounds(people.map((p) => [p.lat, p.lng]));
    if (hasFix(state.dest)) bounds.extend([state.dest.lat, state.dest.lng]);
    // fitBounds already zooms in when the cars are close and out when they are spread
    // out; maxZoom is what decides how far in it is allowed to go for a tight group.
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 18, animate: true });
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
    if (!hasFix(state.dest)) return;
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
  /* One topic per phone, retained. Publishing an empty payload clears it, which is how an
     ask is withdrawn, or retired once it has been answered. */
  const askTopic = (id) => state.topic + '/ask/' + id;

  const JOIN_KEY = 'convoy.joinAsked';
  function saveJoinAsked(on) {
    try {
      if (on) localStorage.setItem(JOIN_KEY, '1');
      else localStorage.removeItem(JOIN_KEY);
    } catch (e) { /* ignore */ }
  }
  function loadJoinAsked() {
    try { return localStorage.getItem(JOIN_KEY) === '1'; } catch (e) { return false; }
  }

  function publishAsk() {
    if (!client || !client.connected || !state.me) return;
    try {
      client.publish(askTopic(state.me.id),
        JSON.stringify({ id: state.me.id, name: state.me.name, ts: Date.now() }),
        { retain: true, qos: 0 });
    } catch (e) { /* ignore */ }
  }

  function clearAsk() {
    if (!client || !client.connected || !state.me) return;
    try {
      client.publish(askTopic(state.me.id), '', { retain: true, qos: 0 });
    } catch (e) { /* ignore */ }
  }

  function send(obj) {
    if (!client || !client.connected || !state.topic) return;
    const body = Object.assign({ id: state.me.id, name: state.me.name, ts: Date.now() }, obj);
    // Every message says whether we are asking to be let in. This deliberately does not
    // consult the allowed list: a phone whose list still contained its own id — after being
    // removed, say — used to send no ask at all, and the pin phone never knew there was a
    // request to show.
    body.ask = !!state.joinAsked;
    try { client.publish(state.topic, JSON.stringify(body)); } catch (e) { /* ignore */ }
    state.lastPublish = Date.now();
  }

  // `force` is for the state push: coming back from a drop, the group needs our position
  // even if we have not moved since the last time we sent it.
  function publishNow(force) {
    const me = state.me;
    if (!me) return;
    if (state.joinAsked && !state.allowed.has(me.id)) publishAsk();
    if (state.paused) return;          // deliberately not sharing
    if (me.lat == null) {
      // Nothing to place on the map — but a phone whose location is switched off is still
      // in the group, and staying quiet would age it into "out of contact" while it sits
      // there. sendState() has already said hello, so only the periodic tick does this.
      if (!force) send({ t: 'hello' });
      return;
    }
    const last = state.lastSentFix;
    if (!force && last && haversine(last, me) < CFG.minMoveM &&
        Date.now() - state.lastPublish < CFG.publishMs) return;
    state.lastSentFix = { lat: me.lat, lng: me.lng };
    send({ t: 'pos', lat: me.lat, lng: me.lng, spd: me.spd, hdg: me.hdg, acc: me.acc,
           fixTs: me.ts, bg: !!state.away });
  }

  // Announce everything this phone knows: who we are, where we are, where we are all
  // going, and how long we will take. This is what makes a server unnecessary — every
  // phone re-pushes its own state, so the group rebuilds itself from the people in it.
  function sendState() {
    send({ t: 'hello' });
    if (state.allowed.size) send({ t: 'allowed', ids: Array.from(state.allowed) });
    if (state.removed.size) send({ t: 'removed', ids: Array.from(state.removed) });
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
    if (state.paused) send({ t: 'paused' });
    if (state.arrived) send({ t: 'arrived', on: true });
  }

  /* A phone whose location is switched off has no position to give, but it is still in the
     convoy — it says hello, it can read the destination, it can set one. Positions are only
     one thing a person can tell us, so anyone we hear from at all goes on the list. Until
     this, a laptop with location off got a "joined" notification and then never appeared. */
  function ensurePeer(msg) {
    let p = state.peers.get(msg.id);
    if (!p) {
      p = {
        id: msg.id, name: (msg.name || 'Someone').slice(0, 24),
        color: colorFor(msg.id), lat: null, lng: null,
        spd: null, hdg: null, acc: null, ts: Date.now(),
        eta: null, isMe: false, demo: false,
        away: false, awayAt: 0, presence: 'live',
        lastSeen: Date.now(), paused: false, arrived: false,
      };
      state.peers.set(msg.id, p);
      refreshColors();
      // A first word from someone is also a join, whether or not they ever send a fix.
      announceJoin(msg.id, p.name);
      rememberMember(msg.id, p.name, p.ts);
      p.savedAt = Date.now();
      renderPeople();
    }
    if (msg.name) p.name = String(msg.name).slice(0, 24);
    p.lastSeen = Date.now();
    return p;
  }

  function onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    if (!msg || !msg.id || (state.me && msg.id === state.me.id)) return;
    state.lastHeard = Date.now();

    // Who is in the group is decided by the phone with the pin, so the two messages that
    // carry that decision are honoured from anyone — they are how a newcomer learns it has
    // been let in.
    if (msg.t === 'allowed') { onAllowed(msg); return; }
    if (msg.t === 'removed') { onRemoved(msg); return; }

    // A retained request, handed over because we have only just connected.
    if (msg.t === 'ask') {
      if (Date.now() - (msg.ts || 0) > CFG.askFreshMs) { return; }
      if (!state.allowed.has(msg.id) && state.master) askedToJoin(msg);
      return;
    }

    if (msg.ask === true) {
      /* It says it is asking. If we have already let it in, its own copy of the list is
         stale — it missed the broadcast, which on a bad link is easy. Tell it again, and
         then treat it like anyone else rather than as a request: otherwise the same person
         is announced and offered a Let in button for ever, and never joins the list. */
      announceAllowed();
      if (!state.allowed.has(msg.id)) {
        if (state.master) askedToJoin(msg);
        return;
      }
    }

    if (!state.allowed.has(msg.id)) {
      // Not in yet. Whoever is arriving needs the current list: the broadcast that
      // carried their approval may have gone out before they were listening, and that is
      // what leaves a phone waiting for ever.
      announceAllowed();
      // Only the master is shown the request; everyone else sees nothing at all, which is
      // the whole point.
      if (state.master && msg.t !== 'bye') askedToJoin(msg);
      return;
    }

    // Any word at all from someone is proof they were still there just now — and for
    // anyone new, it is what puts them on the list. Leaving is the one exception: we do
    // not want to add someone just to remove them.
    const knownBefore = state.peers.has(msg.id) || state.seen.has(msg.id);
    if (msg.t !== 'bye') ensurePeer(msg);

    switch (msg.t) {
      case 'hello':      onHello(msg, knownBefore); return;
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
      default: return;
    }
  }

  function announceJoin(id, name) {
    if (state.seen.has(id)) return false;
    state.seen.add(id);
    // Someone already on the roster is coming back, not joining for the first
    // time, so they get a quiet return rather than a "joined" ping.
    const rec = loadRecord();
    if (rec && rec.members && rec.members[id]) return false;
    notify(name + ' joined', 'They can see the map and set the destination.');
    return true;
  }

  // The master's list of who is in. Every phone keeps it, so a phone that was let in stays
  // let in, and a newcomer finds out the moment the decision reaches it.
  function onAllowed(msg) {
    if (!Array.isArray(msg.ids)) return;
    const wasInConvoy = !!(state.me && state.allowed.has(state.me.id));
    const before = state.allowed.size;
    msg.ids.map(String).slice(0, 500).forEach((id) => state.allowed.add(id));
    saveRecord({ allowed: Array.from(state.allowed) });
    state.pending.forEach((v, id) => { if (state.allowed.has(id)) state.pending.delete(id); });
    const justLetIn = !!(state.me && state.allowed.has(state.me.id) &&
                         !wasInConvoy);
    if (state.me && state.allowed.has(state.me.id)) {
      if (state.joinAsked) clearAsk();          // answered, so stop advertising it
      state.joinAsked = false;
      saveJoinAsked(false);
    }
    // Having just been let in, say so at once. Otherwise the pin phone does not put us on
    // its list until our next tick, which is up to half a minute of them wondering whether
    // it worked.
    if (justLetIn) sendState();
    renderPeople();
  }

  // Someone is asking. Only a master ever gets this far.
  function askedToJoin(msg) {
    if (!state.me) return;
    if (msg.ask === false) {
      // They withdrew. Stop showing them as a request rather than leaving a stale row.
      if (state.pending.delete(msg.id)) renderPeople();
      return;
    }
    const had = state.pending.get(msg.id);
    state.pending.set(msg.id, {
      id: msg.id, name: (msg.name || (had && had.name) || 'Someone').slice(0, 24),
      at: Date.now(),
    });
    if (!had) {
      const who = msg.name || 'Someone';
      banner(who + ' wants to join');
      // Every phone holding the pin gets this, and any of them can let them in.
      notify(who + ' wants to join', 'Open Convoy to let them in');
    }
    renderPeople();
  }

  function letIn(id) {
    if (!state.master || !id) return;
    id = String(id);
    state.allowed.add(id);
    /* Letting someone in has to take them off the removed list as well. It used to, back
       when there was a separate add-back button; when that button went, this was the only
       place left that could do it, and it did not. The result was a person who was let in
       staying filtered off the list, and — because the removed list is broadcast with the
       allowed one — being pushed straight back out on their own phone, so they never got
       the four buttons. */
    state.removed.delete(id);
    state.pending.delete(id);
    saveRecord({ allowed: Array.from(state.allowed), removed: Array.from(state.removed) });
    send({ t: 'allowed', ids: Array.from(state.allowed) });
    send({ t: 'removed', ids: Array.from(state.removed) });
    renderPeople();
  }

  function keepOut(id) {
    if (!state.master || !id) return;
    const req = state.pending.get(String(id));
    state.pending.delete(String(id));
    state.removed.add(String(id));
    saveRecord({ removed: Array.from(state.removed) });
    send({ t: 'removed', ids: Array.from(state.removed) });
    renderPeople();
  }

  // The master's list of who is out, which every phone honours.
  function onRemoved(msg) {
    if (!Array.isArray(msg.ids)) return;
    const mine = state.me ? state.me.id : '';
    const all = msg.ids.map(String).slice(0, 200);
    /* My own id is acted on but never kept in the list. Keeping it meant this phone went on
       broadcasting itself as removed, and the pin phone — which is sent both lists — put it
       straight back, undoing a let-in before it could take effect. */
    setRemoved(all.filter((id) => id !== mine));
    /* A removal is authoritative: whoever it happened to comes off the allowed list here
       too. Without this, a pin phone that did not do the removing kept a stale entry, so
       when that person asked again it looked like a message from someone already in — the
       request was swallowed and no notification ever appeared. */
    let allowedChanged = false;
    all.forEach((id) => {
      if (state.allowed.delete(id)) allowedChanged = true;
      if (state.peers.has(id)) removePeer(id);
    });
    if (allowedChanged) saveRecord({ allowed: Array.from(state.allowed) });

    /* Being turned away has to reach the phone it happened to, whether or not it was in.
       It used to be handled only when it had been in the group, so a phone that was merely
       asking kept its "Cancel request" button: the next press cancelled instead of asking
       again, and the request never arrived. */
    if (mine && all.indexOf(mine) >= 0) {
      state.allowed.delete(mine);
      state.joinAsked = false;
      saveJoinAsked(false);
      clearAsk();
      saveRecord({ allowed: Array.from(state.allowed) });
    }
    renderPeople();
  }

  /* Whoever arrives needs the current list of who is in. The single broadcast that carried
     their approval may have gone out before they were listening, which leaves a phone
     waiting for ever — so any phone that knows the list passes it on when someone speaks. */
  let allowedAt = 0;
  function announceAllowed() {
    if (!state.allowed.size) return;
    const now = Date.now();
    if (now - allowedAt < 5000) return;      // a burst of hellos should not become a storm
    allowedAt = now;
    send({ t: 'allowed', ids: Array.from(state.allowed) });
    // Whoever is arriving needs to know who is out as well as who is in, or a removal that
    // went out while they were not listening is one they will never hear.
    if (state.removed.size) send({ t: 'removed', ids: Array.from(state.removed) });
  }

  /* Someone has just said hello: a phone opening, or one coming back from a refresh. If we
     did not know them, answer at once — otherwise they sit looking at an empty map until
     everybody else's next tick, which is up to half a minute. Once per person per twenty
     seconds, so two phones meeting cannot set each other off. */
  const helloReplied = new Map();

  function onHello(msg, known) {
    announceJoin(msg.id, msg.name || 'Someone');
    announceAllowed();
    if (known) return;
    const last = helloReplied.get(msg.id) || 0;
    if (Date.now() - last < 20000) return;
    helloReplied.set(msg.id, Date.now());
    publishNow(true);          // our position, or our hello if we have none
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
    const p = state.peers.get(msg.id) || ensurePeer(msg);
    if (typeof msg.hdg === 'number') p.hdg = msg.hdg;
    p.lat = msg.lat; p.lng = msg.lng; p.spd = msg.spd; p.hdg = msg.hdg;
    p.acc = msg.acc; p.ts = msg.ts || Date.now();
    if (typeof msg.fixTs === 'number') p.fixTs = msg.fixTs;
    // A position sent from the background leaves them put away, not back on screen.
    p.away = !!msg.bg;
    p.awayAt = p.away ? Date.now() : 0;
    // Keep the roster's last-seen roughly current without writing on every fix.
    if (!p.savedAt || Date.now() - p.savedAt > 300000) {
      p.savedAt = Date.now();
      rememberMember(msg.id, p.name, p.ts);
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
                   by: msg.by || msg.name, byId: msg.byId || '' };
    if (sameDest(state.dest, next)) { state.destTs = ts; return; }   // already have it
    state.destTs = ts;
    state.dest = next;
    state.myEta = null;
    resetArrivals();                 // a new destination: nobody is there yet
    renderDest();
    drawDest();
    refreshRoute();
    saveDest();
    if (state.away) startBgHeartbeat();      // a destination again: report again
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
    if (state.away) stopBgHeartbeat();       // nowhere to go: no need to report
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

  /* A notification that actually arrives on both phones. Safari on iOS refuses to show one
     made by the page itself — it has to come from the service worker — so that is tried
     first and the plain constructor is the fallback. No tag: each of these is its own
     event, and a shared tag would make them replace each other so you only ever saw the
     last one. */
  let swReg = null;
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((r) => { swReg = r; }).catch(() => {});
    }
  } catch (e) { /* ignore */ }

  function notify(title, body) {
    ping();
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* ignore */ }
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return;
    const opts = { body: body || '', icon: 'icons/apple-touch-icon.png' };
    try {
      if (swReg && typeof swReg.showNotification === 'function') {
        swReg.showNotification(title, opts).catch(() => {});
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      // eslint-disable-next-line no-new
      new Notification(title, opts);
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

    const errLine = $('connError');
    if (errLine) {
      errLine.textContent = state.lastError
        ? 'Last from ' + (state.lastErrorRelay || 'a relay') + ': ' + state.lastError
        : '';
    }

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
    } else if (!client || !client.connected) {
      connect();          // one of them answers, so try the real thing again
    }
  }

  function setConn(kind, text) {
    const el = $('connState');
    el.className = 'conn' + (kind === 'live' ? ' live'
      : kind === 'down' ? ' down'
      : kind === 'waiting' ? ' waiting' : '');
    el.textContent = text;
    state.conn = kind || 'waiting';
    renderWaiting();
  }

  /* While you are not in, say what is actually happening in plain words and keep a bar
     moving, so a wait never looks like a dead app. Once you are in, none of this is needed. */
  /* Everything the Help card reports about this phone: the version and relay it is on,
     whether it holds the pin, and whether notifications can arrive at all. All three were
     otherwise invisible, and all three are the first things to check when something is not
     working. */
  function fillHelp() {
    const v = $('settingsVersion');
    if (v) v.textContent = 'Version ' + CFG.build + (state.relay ? ' · relay ' + state.relay : '');
    const pin = $('pinState');
    if (pin) {
      pin.textContent = state.master
        ? 'This phone can let people in'
        : 'This phone cannot let anyone in';
    }
    const note = $('notifyNote');
    if (note) {
      const perm = (typeof Notification === 'function') ? Notification.permission : 'unsupported';
      note.textContent = perm === 'granted' ? 'Notifications on'
        : perm === 'denied' ? 'Notifications blocked in this browser'
        : perm === 'default' ? 'Notifications not allowed yet'
        : 'Notifications not available here';
    }
  }

  /* The same line and the same bar whether you are in or not: a lost connection matters just
     as much once you are in, and it should not be something you have to work out. There is
     nothing here that treats the phone with the pin differently from any other. */
  let renderWaitTimer = null;

  function renderWaiting() {
    const bar = $('waitBar');
    const line = $('waitLine');
    if (!bar || !line) return;

    const me = state.me;
    const inConvoy = !!(me && state.allowed.has(me.id));
    const conn = state.conn || 'waiting';
    const asking = !inConvoy && !!state.joinAsked;

    let text = '';
    if (conn === 'down') {
      text = asking
        ? 'No connection. Your request is kept.'
        : inConvoy
          ? 'No connection. Nobody can see where you are.'
          : 'No connection. Retrying…';
    } else if (conn !== 'live') {
      text = 'Connecting to the relay…';
    } else if (asking) {
      text = 'Request sent. Waiting for the pin phone…';
    } else if (!inConvoy) {
      text = 'Press Join the convoy to ask to be let in.';
    }

    /* The strip across the top: amber and moving while it is connecting, red and still
       when the link is gone, green and still for two seconds when it comes up — then out
       of the way, because a working connection is not news. */
    if (conn !== state.connWas) {
      if (conn === 'live') state.liveAt = Date.now();
      state.connWas = conn;
    }
    const justUp = conn === 'live' && Date.now() - (state.liveAt || 0) < CFG.liveFlashMs;
    const showBar = conn === 'down' || conn !== 'live' || justUp || asking;
    bar.classList.toggle('hidden', !showBar);
    bar.classList.toggle('up', conn === 'live');
    bar.classList.toggle('down', conn === 'down');

    line.textContent = text;
    line.classList.toggle('hidden', !text);

    // Come back in two seconds to put the green away, rather than waiting for a tick.
    if (justUp) {
      if (renderWaitTimer) clearTimeout(renderWaitTimer);
      renderWaitTimer = setTimeout(() => { renderWaitTimer = null; renderWaiting(); },
        CFG.liveFlashMs);
    }
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

  let flapping = 0;
  let connFailures = 0;
  let toldAboutRelay = false;

  /* A phone on mobile data very often cannot reach any of these relays: they listen on
     ports 8081, 8084 and 8884, and carriers block everything but 80 and 443. Sitting on
     "connecting" for ever tells nobody anything, so after a few failures the app says
     what it thinks is happening. */
  function noteRelayFailure() {
    connFailures++;
    if (connFailures < 3) return;
    setConn('', 'no relay');
    if (toldAboutRelay) return;
    toldAboutRelay = true;
  }

  const connLabel = (whileTrying) =>
    (connFailures >= 3 ? 'no relay' : whileTrying);

  /* What the relay actually said. This was being thrown away: the error handler took no
     argument, so a refused connection looked exactly like a blocked port and there was no
     way to tell the two apart. MQTT 5 reason codes are spelled out where we get them. */
  const MQTT_CODES = {
    128: 'unspecified error', 129: 'malformed packet', 130: 'protocol error',
    131: 'implementation specific error', 132: 'unsupported protocol version',
    133: 'client id not valid', 134: 'bad user name or password', 135: 'not authorized',
    136: 'server unavailable', 137: 'server busy', 138: 'banned',
    140: 'bad authentication method', 144: 'topic filter invalid', 145: 'topic name invalid',
    148: 'packet too large', 149: 'message rate too high', 150: 'quota exceeded',
    151: 'administrative action', 153: 'payload format invalid',
  };

  function noteError(err, pkt) {
    let text = '';
    if (pkt && typeof pkt.reasonCode === 'number') {
      text = 'reason ' + pkt.reasonCode +
        (MQTT_CODES[pkt.reasonCode] ? ' (' + MQTT_CODES[pkt.reasonCode] + ')' : '');
      if (pkt.reasonString) text += ' — ' + pkt.reasonString;
    } else if (err) {
      const m = err.message || err.code || String(err);
      text = /timeout/i.test(m) ? 'timed out'
        : /unauthor|not authori|401|403/i.test(m) ? 'not authorized'
        : /refused/i.test(m) ? 'connection refused'
        : /websocket|socket|network/i.test(m) ? 'socket failed'
        : m;
    }
    if (!text) return;
    state.lastError = String(text).slice(0, 120);
    state.lastErrorRelay = state.relay || '';
  }

  function connect() {
    const b = CFG.brokers[brokerIdx % CFG.brokers.length];
    state.relay = b.name;
    setConn('waiting', connLabel('connecting'));
    let settled = false;
    let counted = false;
    const fail = () => { if (counted) return; counted = true; noteRelayFailure(); };

    // The library comes from a CDN. Without it every attempt throws before it reaches the
    // network — which used to cycle through the relays for ever, looking exactly like a
    // blocked network. Say so instead.
    if (typeof mqtt === 'undefined' || !mqtt || !mqtt.connect) {
      fail();
      setConn('down', 'no library');
      return;
    }

    try {
      client = mqtt.connect(b.url, {
        // A unique id per attempt. Two copies of the app on one phone share the same
        // device id, and a broker kicks the older session when a second client arrives
        // with the same one — which looks like a connection that keeps dropping.
        clientId: state.me.id + '-' + rand(4),
        clean: true,
        reconnectPeriod: 0,
        // Mobile networks drop idle sockets long before MQTT's default minute is up.
        keepalive: CFG.keepalive,
      });
    } catch (e) {
      fail();
      retry();
      return;
    }

    let liveAt = 0;
    client.on('connect', () => {
      settled = true;
      liveAt = Date.now();
      connFailures = 0;
      toldAboutRelay = false;
      setConn('live', 'live');
      client.subscribe(state.topic, { qos: 0 }, () => {});
      // Retained requests: each phone asks on its own topic, so the broker keeps the ask
      // and hands it to a pin phone that connects later. Without this a request sent while
      // nobody with the pin was connected was simply lost.
      client.subscribe(askTopic('+'), { qos: 0 }, () => {});
      if (state.joinAsked) publishAsk();
      sendState();          // push everything we know, so nobody has to hold it for us
      refreshRoute();
    });
    client.on('message', onMessage);
    client.on('error', (err) => { noteError(err); if (!settled) { fail(); retry(); } });
    client.on('disconnect', (pkt) => { noteError(null, pkt); });
    client.on('close', () => {
      if (!state.lastError) noteError(new Error('socket closed'));
      setConn('down', 'offline');
      if (!settled) { fail(); retry(); return; }
      // A connection that lasted a while ended normally; one that dies straight after
      // connecting is a flap, and two of those in a row mean this relay is not the one.
      if (Date.now() - liveAt >= CFG.stableMs) flapping = 0;
      else flapping++;
      if (flapping >= 2) {
        flapping = 0;
        brokerIdx++;
        retry();
        return;
      }
      scheduleReconnect();
    });
  }

  function retry() {
    brokerIdx++;
    setConn('waiting', connLabel('trying…'));
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, CFG.retryMs);
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (state.joined) connect(); }, CFG.reconnectMs);
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
  /* High accuracy while the app is on screen — that is what draws the map. In the
     background it drops to the cheap kind: the GPS chip is what costs battery, not the
     messages, and a five-minute beat does not need metre precision. */
  let wantPrecise = true;

  function startWatching() {
    if (!navigator.geolocation) { state.geoUnavailable = true; renderPeople(); return; }
    stopWatching();
    try {
      geoWatch = navigator.geolocation.watchPosition(onFix, onGeoError, {
        enableHighAccuracy: wantPrecise,
        maximumAge: wantPrecise ? 4000 : 30000,
        timeout: 20000,
      });
    } catch (e) { state.geoUnavailable = true; renderPeople(); }
  }

  const haveMyPosition = () => !!(state.me && state.me.lat != null && state.me.lng != null);

  function nudgeForLocation() {
    if (!state.joined || state.paused || haveMyPosition()) return;
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
    applyHeading();
    applySun();
  }

  /* The map is turned so the way you are going is up, the way a sat-nav does it — but only
     while the view is following you. Once you have taken the map yourself it is left alone.
     The badge in the corner says which way that is, and turns it off. */
  const canRotate = () => !!(map && typeof map.setBearing === 'function');

  /* How high the sun is, in degrees, for a time and a place. Low-precision solar position —
     good to about a hundredth of a degree, which is far more than day or night needs. */
  function sunElevation(ms, lat, lng) {
    const rad = Math.PI / 180;
    const n = ms / 86400000 + 2440587.5 - 2451545.0;        // days since J2000
    const L = 280.46 + 0.9856474 * n;                        // mean longitude
    const g = (357.528 + 0.9856003 * n) * rad;               // mean anomaly
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const ha = (gmst * 15 + lng) * rad - ra;                 // hour angle
    const sinEl = Math.sin(lat * rad) * Math.sin(dec) +
                  Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, sinEl))) / rad;
  }

  /* Day or night, by the sun where you are, not by a clock or a phone setting. Sunset is
     when the sun's upper edge drops below the horizon, which is -0.833 degrees. */
  function applySun() {
    const el = $('map');
    if (!el) return;
    const me = state.me;
    const at = me && me.lat != null ? me : CFG.fallbackCenter;
    const up = sunElevation(Date.now(), at.lat, at.lng);
    const night = up < -0.833;
    el.classList.toggle('night-tiles', night);
    state.sunUp = up;
    state.night = night;
  }

  function applyHeading() {
    const me = state.me;
    const hdg = me && typeof me.hdg === 'number' && isFinite(me.hdg) ? me.hdg : null;
    const el = $('btnHeading');
    if (el) {
      const on = hdg != null;
      el.classList.toggle('hidden', !on);
      el.classList.toggle('up', !!(on && state.headingUp));
      if (on) $('headingText').textContent = compass(hdg);
    }
    if (!canRotate()) return;
    if (hdg == null || !state.headingUp || !state.autoFit) {
      if (map.getBearing && map.getBearing() !== 0) map.setBearing(0);
      return;
    }
    // Bearing is the other way round from a heading: turning the map by the negative of
    // where you are going puts that direction at the top.
    map.setBearing(-hdg);
  }

  function onGeoError(err) {
    state.geoProblem = { 1: 'Location is blocked', 2: 'Location unavailable',
                         3: 'Location timed out' }[err.code] || 'Location problem';
    renderPeople();
    // If this is the browser built into a chat app, that is usually why — say so.
    if (window.ConvoyInstall && window.ConvoyInstall.showOpenInBrowser) {
      window.ConvoyInstall.showOpenInBrowser();
    }
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */
  // Someone asking to be let in. Only a master ever has one of these to draw.
  function pendingRow(r) {
    return '<li class="asking">' +
      '<span class="pdot"></span>' +
      '<span class="pname">' + esc(r.name) +
        '<span class="tag">wants to join</span></span>' +
      '<button class="row-act yes" data-yes="' + esc(r.id) + '">Let in</button>' +
      '<button class="row-act" data-no="' + esc(r.id) + '" aria-label="Do not let in">&#215;</button>' +
    '</li>';
  }

  function renderPeople() {
    renderControls();      // one button or four, depending on whether you are in yet
    const ul = $('people');
    const me = state.me;
    const rows = [];
    const inConvoy = !!(me && state.allowed.has(me.id));

    if (inConvoy) {
      if (me) rows.push(rowFor(me, null));
      Array.from(state.peers.values())
        .filter((p) => !state.removed.has(p.id))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .forEach((p) => rows.push(rowFor(p, me)));
    }
    const people = rows.length;
    // Requests come first: they are the only thing anyone has to act on.
    if (state.master) state.pending.forEach((r) => rows.unshift(pendingRow(r)));

    $('peopleCount').textContent = inConvoy
      ? people + (people === 1 ? ' person' : ' people') +
        (state.dest ? '' : ' · no destination')
      : (state.me && state.removed.has(state.me.id) ? 'not in the convoy' : 'waiting to be let in');

    const el = document.activeElement;
    const editing = !!(el && el.classList && el.classList.contains('myname'));
    if (!editing) {
      if (!inConvoy) {
        ul.innerHTML = '<li class="empty">' +
          (state.joinAsked ? 'The phone with the pin has been asked.'
            : 'Nobody outside can see the map until they let you in.') + '</li>';
      } else {
        ul.innerHTML = rows.length ? rows.join('')
          : '<li class="empty">Waiting for others to join…</li>';
      }
    }

    renderMarkers();

    // The sheet's height is what the map has to work around.
    const sheet = $('sheet');
    if (sheet) {
      document.documentElement.style.setProperty('--sheet-h', sheet.offsetHeight + 'px');
    }
  }

  function etaCell(p) {
    // One mention in the header beats five in the rows. Repetition at that density stops
    // being information and becomes texture.
    if (!state.dest) return '';
    // Nobody presses the button if they do not have to: coming within reach of the
    // destination is arriving. Until that happens the arrival time stays on screen — it is
    // the one thing everyone actually watches.
    if (p.arrived || (p.isMe && state.arrived)) {
      // The green "arrived" badge on the row already says this.
      return '';
    }
    const eta = p.isMe ? state.myEta : p.eta;
    if (!eta) return '';      // no time yet is not worth a dash on every row
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

  // When we last heard from someone: this session if we have, otherwise what the roster
  // roster remembered from last time. "Out of contact" on its own is too vague to act on.
  function lastSeenOf(p) {
    if (p.lastSeen) return p.lastSeen;
    if (p.lat != null && p.ts) return p.ts;
    const rec = loadRecord();
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
      // Say so plainly rather than showing a bare "you" with no dot on the map. Location
      // trouble used to be a banner; it belongs on your own row, where it cannot be missed.
      meta = state.geoProblem || state.geoUnavailable ? (state.geoProblem || 'No location here')
           : p.lat == null ? 'waiting for your location · tap anywhere'
           : state.away ? 'app in the background' : 'you';
      if (state.arrived) tag = 'arrived';
    } else if (kind === 'paused') {
      meta = 'location hidden';
      tag = 'hidden';
    } else if (kind === 'noloc') {
      meta = 'not sharing their location';
    } else if (p.lat == null) {
      const seen = lastSeenOf(p);
      meta = seen ? 'Lost network · ' + fmtAgo(seen) : 'Lost network';
    } else if (kind === 'away') {
      // Put away and still reporting is one thing; put away and silent is another.
      const fresh = Date.now() - (p.ts || 0) <= CFG.staleMs;
      const oldFix = p.fixTs && Date.now() - p.fixTs > CFG.staleMs;
      meta = fresh ? (oldFix ? 'In the background · no new position' : 'In the background')
        : 'Shut down app';
    } else if (kind === 'lost') {
      // Silence, which in practice means the network went, so say the thing people
      // actually want to know and keep the how-long beside it.
      meta = 'Lost network · ' + fmtAgo(lastSeenOf(p));
    } else {
      meta = behindAhead(me, p) || (me && me.lat != null ? nearText(me, p) : '');
    }
    // "You you": never let the tag repeat the name it sits beside.
    if (p.isMe && meta && String(p.name).toLowerCase() === meta.toLowerCase()) meta = '';
    if (p.arrived && !p.isMe) { tag = 'arrived'; meta = ''; }
    // Only the phone with the pin sees the control, and never on itself.
    let act = '';
    if (state.master && !p.isMe) {
      act = '<button class="row-act" data-remove="' + esc(p.id) +
            '" aria-label="Remove from the group">&#215;</button>';
    }
    const inner = p.isMe
      ? '<input class="myname" maxlength="24" aria-label="Your name" value="' +
        esc(p.name) + '" />'
      : esc(p.name);
    return '<li data-id="' + esc(p.id) + '" class="' +
      (kind === 'lost' ? 'lost ' : '') + (kind === 'away' ? 'away ' : '') +
      (kind === 'paused' ? 'paused ' : '') +
      (state.removed.has(p.id) ? 'removed ' : '') + '">' +
      '<span class="pdot" style="background:' + p.color + '"></span>' +
      '<span class="pname">' + inner +
        (meta ? '<span class="tag">' + esc(meta) + '</span>' : '') + '</span>' +
      (tag ? '<span class="ptag">' + esc(tag) + '</span>' : '') +
      etaCell(p) + act +
    '</li>';
  }

  /* The dot on the destination row wears the colour of whoever set it, as they appear on
     this phone's list — so it is the same green or purple you see beside their name. Colours
     are assigned per phone, so this is a lookup, not a hash: your own car is always the first
     colour on your own screen, and someone else's is whatever they were given here. */
  function destColor() {
    const d = state.dest;
    if (!d) return '';
    const byId = d.byId || '';
    if (byId && state.me && byId === state.me.id) return state.me.color || '';
    const p = byId ? state.peers.get(byId) : null;
    if (p && p.color) return p.color;
    // An older phone sends no id, so fall back to the name; failing that, a stable colour.
    const named = Array.from(state.peers.values()).find((x) => x.name && x.name === d.by);
    if (named && named.color) return named.color;
    return byId ? colorFor(byId) : '';
  }

  const tint = (hex, a) => {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return 'transparent';
    const n = parseInt(h, 16);
    if (!isFinite(n)) return 'transparent';
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  };

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

    const pin = document.querySelector('.dest-pin');
    if (pin) {
      const c = destColor();
      pin.style.background = c || '';
      pin.style.boxShadow = c ? '0 0 0 3px ' + tint(c, 0.18) : '';
    }
  }

  function renderTop() {
    // Nothing in the bar any more: the destination is the only thing up there.
  }

  /* Your name is the only thing you can set, and it is set from the sheet: opening the app
     already puts you on the map, so there is no form to fill in first. */
  function setName(name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!state.me || !clean || clean === state.me.name) return;
    state.me.name = clean;
    try { localStorage.setItem('convoy.name', clean); } catch (e) { /* ignore */ }
    send({ t: 'hello' });        // so everyone else's list updates
    renderTop();
    renderPeople();
  }

  // The one switch in the sheet. Internally this is still "paused"; on screen it says what
  // it actually does, which is take you off the map.
  function renderControls() {
    renderWaiting();
    // Not in yet: one Join button and nothing else to press.
    const inConvoy = !!(state.me && state.allowed.has(state.me.id));
    const join = $('btnJoin');
    if (join) join.classList.toggle('hidden', inConvoy);
    const joinLabel = $('joinLabel');
    if (joinLabel) {
      joinLabel.textContent = state.joinAsked ? 'Cancel request' : 'Join the convoy';
    }
    ['btnInvite', 'btnPause', 'btnCentre', 'btnSettings'].forEach((id) => {
      const b = $(id);
      if (b) b.classList.toggle('hidden', !inConvoy);
    });

    const el = $('btnPause');
    if (!el) return;
    el.classList.toggle('hiding', !!state.paused);
    // The button is an icon over one short word, so it keeps the same size either way.
    const label = $('pauseLabel');
    if (label) label.textContent = state.paused ? 'Hidden' : 'Sharing';
    el.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
    el.setAttribute('aria-label',
      state.paused ? 'You are hidden — tap to share again' : 'Hide my location');
  }

  /* Every car on screen at once, yours included — and the view starts following again, so
     it keeps them there. Zooming in on one car is a pinch away, which is the better way to
     ask for it than a button that guesses which car you meant. */
  function showEveryone() {
    if (!state.me) return;
    if (state.me.lat == null) startWatching();      // nothing to frame yet
    state.autoFit = true;
    lastFitAt = 0;
    fitAll();
  }

  // Tapping a person brings the map to them. It also stops the view chasing everybody.
  function focusPeer(id) {
    const p = state.peers.get(id);
    if (!hasFix(p)) return;              // restored from the roster, no position yet
    state.autoFit = false;
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
  }

  // Pasting a whole invite link into the code box should just work.
  /* Opening the app should put you on the map with no questions. A name is the one thing
     the others need, so if none has been set we take the device's own — an iPhone shows as
     "iPhone 4a", a laptop as "Mac 3f" — and it can be changed from the sheet. */
  // FNV-1a over a salted string: a hash, so the pin itself is nowhere in the source.
  function pinHash(text) {
    let h = 0x811c9dc5;
    const s = 'convoy:' + String(text || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;   // 32-bit multiply: * would lose precision
    }
    return h >>> 0;
  }

  /* Only the phone that has the pin can take someone off the group. The removal is
     broadcast and remembered by every phone, so a removed person is ignored from then on
     — but they can still receive, because there is no server to stop them. */
  function setRemoved(ids) {
    state.removed = new Set(ids);
    saveRecord({ removed: Array.from(state.removed) });
  }

  /* The cross is the whole action: the person comes off the group, off the list and off
     the map, and their name goes with them. They are also taken off the allowed list and
     remembered as removed, so they cannot put themselves back. */
  function removePerson(id) {
    if (!state.master || !id || (state.me && id === state.me.id)) return;
    id = String(id);
    state.allowed.delete(id);
    state.removed.add(id);
    state.pending.delete(id);
    removePeer(id);            // the row and the car on the map
    forgetMember(id);          // and the roster, so a reopened app does not bring them back
    saveRecord({ allowed: Array.from(state.allowed), removed: Array.from(state.removed) });
    send({ t: 'allowed', ids: Array.from(state.allowed) });
    send({ t: 'removed', ids: Array.from(state.removed) });
    renderPeople();
  }

  function deviceName() {
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows';
    return 'Phone';
  }

  function defaultName() {
    return (deviceName() + ' ' + myId().slice(-2)).slice(0, 24);
  }

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
    state.dest = {
      lat, lng, label: label || 'Destination',
      by: state.me ? state.me.name : '',
      byId: state.me ? state.me.id : '',     // whose colour the dot wears
    };
    state.myEta = null;
    resetArrivals();                 // a new destination: nobody is there yet
    renderDest();
    // From here on it is drawing and telling the group. None of that may be allowed to
    // stop the caller: a map or network hiccup must never leave a screen stuck.
    try {
      drawDest();
      refreshRoute();
      saveDest();
      if (state.away) startBgHeartbeat();      // a destination again: report again
      send({ t: 'dest', lat, lng, label: state.dest.label, by: state.dest.by,
             byId: state.dest.byId, ts: state.destTs });
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
    if (state.away) stopBgHeartbeat();       // nowhere to go: no need to report
    send({ t: 'dest-clear', ts: state.destTs });
  }

  // Watch for people slipping out of contact, and for them coming back. This is the
  // backstop for a force-kill: the app is gone, so nothing was sent, and all the group
  // can honestly say is that the messages stopped.
  /* Waiting to be let in, connected, and nothing heard from anybody: most likely the group
     is on a different relay. Walk the list rather than sit there — there are only a few. */
  let lastHop = 0;
  function huntForTheGroup() {
    if (!state.me || state.allowed.has(state.me.id)) return;
    if (!state.joinAsked) return;                 // not asking, so nothing to wait for
    if (!client || !client.connected) return;
    const quiet = Date.now() - (state.lastHeard || 0);
    if (quiet < 8000 || Date.now() - lastHop < 8000) return;
    lastHop = Date.now();
    brokerIdx++;                                  // the next relay in the list
    try { client.end(true); } catch (e) { /* ignore */ }
    client = null;
    connect();
  }

  function sweepPresence() {
    let changed = false;
    state.peers.forEach((p) => {
      const kind = presenceOf(p);
      if (kind === p.presence) return;
      const was = p.presence;
      p.presence = kind;
      changed = true;
      if (kind === 'lost') {
        /* Only when we watched them go, and only while it is still news. A roster entry
           restored when the app opens was never live to begin with, and a phone that left
           days ago is not worth a notification — that was how the same person got
           announced as "out of contact" over and over. */
        const silentFor = Date.now() - (p.ts || 0);
        const watched = was === 'live' || was === 'away' || was === 'noloc';
        // And at most once every half hour per person. A phone that keeps flapping — an old
        // device still running the app somewhere — would otherwise announce itself every
        // few minutes, which is the noise this became.
        const quietSince = Date.now() - (p.lostNotifiedAt || 0);
        // The window is the longer of the two: a backgrounded phone only counts as out of
        // contact after six and a half minutes, so it has to still be news then.
        const fresh = Math.max(CFG.awayMs, CFG.bgStaleMs) * 2;
        if (watched && silentFor < fresh && quietSince > CFG.lostNoticeMs) {
          p.lostNotifiedAt = Date.now();
          notify(p.name + ' — out of contact',
                 'No signal, or their app was closed. They reappear when they can.');
        }
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
      // The blanket rule: a week after their last sign of life, someone is dropped from
      // the list and from the roster, on every phone, without anyone having to act.
      state.peers.forEach((p, id) => {
        if (Date.now() - (p.ts || 0) > keepMs()) {
          removePeer(id);
          state.seen.delete(id);
          forgetMember(id);
        }
      });
      pruneRoster();
      huntForTheGroup();
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


  function join(name) {
    state.me = {
      id: myId(), name, color: PALETTE[0],
      lat: null, lng: null, spd: null, hdg: null, acc: null,
      ts: Date.now(), isMe: true, _first: true,
    };
    state.topic = CFG.topic;
    state.joined = true;
    state.lastActive = Date.now();
    state.seen = new Set();
    state.away = false;
    state.focused = '';
    try { state.master = localStorage.getItem('convoy.master') === '1'; } catch (e) { /* ignore */ }

    // A fresh session: anyone on the map belongs to the one before it.
    state.peers.forEach((p) => { if (p._marker) map.removeLayer(p._marker); });
    state.peers = new Map();

    // Restore the destination this phone last knew, so a returning phone can put it
    // straight back on the air without asking anybody.
    const saved = loadDest();
    state.destTs = saved ? saved.ts : 0;
    state.dest = saved ? saved.dest : null;
    state.myEta = null;

    // And bring back everyone who has been in the convoy within the last week. They have
    // no position yet, so they sit on the list as out of contact until they publish one.
    pruneRoster();
    const rec = loadRecord();
    state.removed = new Set((rec && Array.isArray(rec.removed)) ? rec.removed.map(String) : []);
    state.allowed = new Set((rec && Array.isArray(rec.allowed)) ? rec.allowed.map(String) : []);
    state.pending = new Map();
    // The phone holding the pin is in by definition; everyone else waits to be
    // let in by it.
    if (state.master) state.allowed.add(state.me.id);
    // An ask that was still standing when the app was last closed is still standing.
    state.joinAsked = loadJoinAsked() && !state.allowed.has(state.me.id);
    // A name this phone went by last time, and nobody has arrived yet.
    state.arrived = false;
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
    } catch (e) { /* ignore */ }

    renderTop();
    renderControls();
    renderDest();
    drawDest();
    renderPeople();
    $('sheet').classList.remove('hidden');

    connect();
    startWatching();
    startTimers();
    askWakeLock();
    askToNotify();
  }

  // No code travels in the link any more: opening the app is joining it.
  const inviteLink = () => location.origin + location.pathname;

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
    // There is no code to send: opening the app is joining it. The link goes in the `text`
    // as well as the `url`, because WhatsApp on Android reads `text` and can drop a
    // separate `url`.
    const text = 'Open Convoy and you are on the map with me:\n' + url;

    try {
      if (navigator.share) {
        await navigator.share({ title: 'Convoy', text, url });
        return;
      }
    } catch (e) { /* they dismissed the share sheet, or it is unavailable here */ }

    if (await copyText(url)) {
      const label = $('btnInvite') && $('btnInvite').querySelector('span');
      if (label) {
        const was = label.textContent;
        label.textContent = 'Copied';
        setTimeout(() => { label.textContent = was; }, 2000);
      }
      return;
    }
    showLink(url);
  }

  /* ---------------------------------------------------------------- *
   * Demo — four simulated cars, so one phone can see the whole thing work
   * ---------------------------------------------------------------- */
  let demoTimer = null;
  let demoDestSet = false;

  function startDemo() {
    const c = CFG.fallbackCenter;
    // A preview of a populated map is only worth anything if you can see the list, so the
    // demo puts you in the convoy first.
    if (state.me) state.allowed.add(state.me.id);
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
      rememberMember(id, name);      // so the preview behaves like the real thing
    });
    rememberMember(state.me.id, state.me.name);
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
        // A plausible arrival time, so the list shows the real thing — and none at all
        // when there is no destination, which is what crashed this when one was cleared.
        if (hasFix(state.dest) && hasFix(p)) {
          const d = haversine(p, state.dest) * 1.25;
          p.eta = { dur: d / p._spd, dist: d, ts: t };
        } else {
          p.eta = null;
        }
        updateMarker(p);
      });
      renderPeople();
      maybeAutoView();
    }, 1000);

    setConn('live', 'demo');
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
  let bgTimer = null;

  /* Three things end it, and all three have to hold for it to run:
       1. not having arrived at the destination;
       2. fewer than four hours since you were last on the app;
       3. there is a destination at all. Nobody needs a five-minute position while the
          group has nowhere to go — and setting one again inside the four hours brings it
          straight back. */
  const bgAllowed = () => !!state.me && !state.arrived && !!state.dest &&
    Date.now() < state.bgUntil;

  /* Four hours counted from the last time you were actually on the app, not from now, so
     putting the phone away does not restart the clock. */
  function startBgHeartbeat() {
    stopBgHeartbeat();
    if (!state.me) return;
    state.bgUntil = (state.lastActive || Date.now()) + CFG.bgForMs;
    if (!bgAllowed()) return;
    bgTimer = setInterval(() => {
      if (!bgAllowed()) { stopBgHeartbeat(); return; }
      publishNow(true);        // one position, and no more often than this
    }, CFG.bgMs);
  }

  function stopBgHeartbeat() {
    if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
  }

  function goAway() {
    if (!state.joined || demoTimer) return;
    if (!state.away) { state.away = true; send({ t: 'away' }); }
    // While it is in the background, report on the slower beat instead of the fast one.
    if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
    wantPrecise = false;
    startWatching();                 // cheap location: the GPS chip is the battery cost
    startBgHeartbeat();
    renderPeople();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function wire() {
    $('btnInvite').addEventListener('click', share);
    $('btnShareClose').addEventListener('click', () => $('shareCard').classList.add('hidden'));

    // The one switch in the sheet.
    $('btnPause').addEventListener('click', () => setPaused(!state.paused));

    // The gear: a version, and a field that does not say what it is for.
    $('btnSettings').addEventListener('click', () => {
      fillHelp();
      $('inPin').value = '';
      const note = $('pinNote');
      if (state.master) {
        note.textContent = 'This phone can add and remove people.';
        note.classList.remove('hidden');
      } else {
        note.classList.add('hidden');
      }
      $('settingsCard').classList.remove('hidden');
    });
    $('btnSettingsClose').addEventListener('click',
      () => $('settingsCard').classList.add('hidden'));
    $('inPin').addEventListener('change', () => {
      const pin = $('inPin').value;
      if (!pin) return;
      $('inPin').value = '';
      if (pinHash(pin) !== CFG.masterHash) return;   // nothing to see; the field clears
      state.master = true;
      try { localStorage.setItem('convoy.master', '1'); } catch (e) { /* ignore */ }
      if (state.me) {
        state.allowed.add(state.me.id);
        saveRecord({ allowed: Array.from(state.allowed) });
        send({ t: 'allowed', ids: Array.from(state.allowed) });
      }
      /* Taking the pin on a phone that did not have it means it was not listening for
         requests before now: the retained ones were handed over and dropped. Subscribe
         again so the broker sends what it is still holding. */
      if (client && client.connected) {
        try {
          if (typeof client.unsubscribe === 'function') client.unsubscribe(askTopic('+'), () => {});
          client.subscribe(askTopic('+'), { qos: 0 }, () => {});
        } catch (e) { /* ignore */ }
      }
      const note = $('pinNote');
      note.textContent = 'This phone can add and remove people.';
      note.classList.remove('hidden');
      renderPeople();
    });

    $('btnJoin').addEventListener('click', () => {
      state.joinAsked = !state.joinAsked;
      saveJoinAsked(state.joinAsked);
      if (state.joinAsked) sendState();             // retained, and on the bus
      else { clearAsk(); send({ t: 'hello' }); }            // withdrawn
      renderControls();
    });
    // Help holds the pin field, so it has to stay reachable while you are not in yet.
    let connHold = null;
    const openHelp = () => { fillHelp(); $('settingsCard').classList.remove('hidden'); };
    $('connState').addEventListener('pointerdown', () => {
      connHold = setTimeout(openHelp, 550);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
      $('connState').addEventListener(ev, () => {
        if (connHold) { clearTimeout(connHold); connHold = null; }
      });
    });
    $('btnCentre').addEventListener('click', showEveryone);
    $('btnHeading').addEventListener('click', () => {
      state.headingUp = !state.headingUp;
      applyHeading();
    });

    // Tapping someone brings the map to them; the master's crosses and pluses come first.
    $('people').addEventListener('change', (e) => {
      const inp = e.target;
      if (inp && inp.classList && inp.classList.contains('myname')) setName(inp.value);
    });
    $('people').addEventListener('click', (e) => {
      const node = e.target;
      const near = node && node.closest ? node : null;
      const yes = near ? near.closest('[data-yes]') : null;
      if (yes) { letIn(yes.getAttribute('data-yes')); return; }
      const no = near ? near.closest('[data-no]') : null;
      if (no) { keepOut(no.getAttribute('data-no')); return; }
      const rm = near ? near.closest('[data-remove]') : null;
      if (rm) { removePerson(rm.getAttribute('data-remove')); return; }
      const li = near ? near.closest('li[data-id]') : null;
      if (li) focusPeer(li.getAttribute('data-id'));
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
        state.lastActive = Date.now();
        askWakeLock();      // a refused screen lock is often allowed after a touch
        askToNotify();      // and iOS only offers the permission prompt after a touch
        if (state.joined && !state.paused && !haveMyPosition()) startWatching();
      }, { passive: true });
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

    // Closing the app is NOT leaving the convoy. It sends the same "away" note as
    // backgrounding does, so the group sees a phone that has gone quiet rather than
    // someone who walked out — and nobody comes off the roster for it.
    // (pagehide above handles that. Only the Leave button sends a real "bye".)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { goAway(); return; }
      if (!state.joined) return;
      state.lastActive = Date.now();
      stopBgHeartbeat();
      if (!wantPrecise) { wantPrecise = true; startWatching(); }
      if (!publishTimer) publishTimer = setInterval(publishNow, CFG.publishMs);
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
    applySun();          // day or night before the first fix arrives
    wire();
    if (window.ConvoyRoute) {
      window.ConvoyRoute.init({
        state, esc, setDest, clearDest,
      });
    }
    if (window.ConvoyInstall) window.ConvoyInstall.init();
    $('sheet').classList.add('hidden');
    renderDest();

    // The name is the only thing kept: if this phone has been used before, use the name
    // that was set on it, and otherwise fall back to the roster, which has it too.
    let savedName = '';
    try {
      savedName = localStorage.getItem(LS.name) || '';
    } catch (e) { /* ignore */ }
    if (!savedName) {
      const rec = loadRecord();
      const mine = rec && rec.members && rec.members[myId()];
      if (mine && mine.name) savedName = mine.name;
    }

    // Opening the app puts you straight on the map. The name is the only thing anyone
    // needs, and it has a sensible default, so there is nothing to fill in and no code
    // to type — the first launch included.
    join(savedName || defaultName());
  }

  window.Convoy = {
    CFG, state, esc, setDest, clearDest, join, share, copyText, inviteLink,
    map: () => map, haversine, bearing, fmtDist, fmtClock,
    _internals: { PALETTE, assignColors, refreshColors, fitAll, maybeAutoView,
                  onMessage, onFix, notify, startDemo, stopDemo, colorFor,
                  presenceOf, sweepPresence, sendState, goAway, saveDest, loadDest, allPeople,
                  handleTap, wireTapZoom, tap,
                  loadRecord, saveRecord, rememberMember, forgetMember,
                  keepMs, pruneRoster,
                  // The switches, the arrival logic, and the small helpers behind them.
                  setPaused, checkArrivals, resetArrivals,
                  distToDest, focusPeer, behindAhead, lastSeenOf,
                  defaultName, deviceName, setName, pinHash, removePerson,
                  showEveryone, applyHeading, canRotate, applySun, sunElevation,
                  huntForTheGroup, publishAsk, clearAsk, askTopic, loadJoinAsked,
                  startBgHeartbeat, stopBgHeartbeat, bgAllowed, bgRunning: () => !!bgTimer,
                  renderWaiting,
                  TILES, tileLayer: () => tiles,
                  letIn, keepOut, askedToJoin, onAllowed,
                  renderControls, renderTop, renderPeople,
                  unlockAudio, ping, onMapLongPress, rowFor, publishNow, send,
                  renderMarkers, labelledIds, nearestPeer, nearText, noteRelayFailure,
                  probeRelay, showConnection, checkForUpdate,
                  startWatching, stopWatching, haveMyPosition, nudgeForLocation,
                  askWakeLock },
  };

  boot();
})();
