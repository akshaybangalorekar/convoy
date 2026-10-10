/* Convoy — routing & navigation
 * ------------------------------------------------------------------
 * Adds: address search (start + destination), multi-modal routing
 * (car / cycle / walk), turn-by-turn steps, live navigation with
 * spoken prompts, and room-wide route sharing.
 *
 * Data sources (all free, no API key):
 *   Geocoding : Photon (komoot) -> Nominatim (OSM)
 *   Routing   : FOSSGIS OSRM  routed-car / routed-bike / routed-foot
 *
 * Loaded BEFORE app.js. app.js calls ConvoyRoute.init(api) at boot
 * and pushes GPS updates via api.hooks.tick().
 */
(function () {
  'use strict';

  let API = null;   // bridge object handed over by app.js

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  const CFG = {
    routers: {
      car: ['https://routing.openstreetmap.de/routed-car',
            'https://router.project-osrm.org'],
      bike: ['https://routing.openstreetmap.de/routed-bike'],
      foot: ['https://routing.openstreetmap.de/routed-foot'],
    },
    geocoders: [
      {
        name: 'photon',
        url: (q) => 'https://photon.komoot.io/api/?limit=6&lang=en&q=' + encodeURIComponent(q),
        parse: photonParse,
      },
      {
        name: 'nominatim',
        url: (q) => 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q),
        parse: nominatimParse,
      },
    ],
    suggestDelay: 500,     // ms debounce before hitting the geocoder
    shareMaxPoints: 400,   // downsample shared geometry
    shareMaxSteps: 80,
    offRouteM: 90,         // metres from the line before we call it off-route
    arriveM: 40,           // metres to destination = arrived
  };

  const MODES = {
    car:  { label: 'Car',   icon: 'car',  speak: [500, 200, 60] },
    bike: { label: 'Cycle', icon: 'bike', speak: [300, 120, 30] },
    foot: { label: 'Walk',  icon: 'walk', speak: [250, 100, 25] },
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const R = {
    mode: 'car',
    active: null,      // { mode, distance, duration, geometry, steps, start, end, by, mine }
    nav: false,
    muted: false,
    layer: null,
    startMarker: null,
    endMarker: null,
    stepStart: [],     // cumulative metres at which each step begins
    total: 0,
    cum: [],           // cumulative metres along geometry
    progress: 0,       // metres along the route
    offRoute: false,
    nextIdx: -1,
    spoken: {},        // fired announcement keys
    lastAnnounce: 0,
    from: null,        // chosen start {label, lat, lng}
    to: null,          // chosen destination
    suggestTimer: null,
    busy: false,
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  function fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return '—';
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  function fmtClock(sec) {
    const d = new Date(Date.now() + sec * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function ordinal(n) {
    if (n == null) return '';
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function shortLabel(s, max = 34) {
    s = String(s || '').trim();
    if (s.length <= max) return s;
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    let out = '';
    for (const p of parts) {
      if ((out + ', ' + p).length > max) break;
      out = out ? out + ', ' + p : p;
    }
    return out || s.slice(0, max) + '…';
  }

  /* ------------------------------------------------------------------ *
   * Geocoding
   * ------------------------------------------------------------------ */
  function photonParse(data) {
    const feats = (data && data.features) || [];
    return feats.map((f) => {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [];
      const bits = [p.name, p.street, p.district, p.city, p.state, p.country]
        .filter((x, i, a) => x && a.indexOf(x) === i);
      return { label: bits.join(', '), lat: c[1], lng: c[0] };
    }).filter((r) => r.lat != null);
  }
  function nominatimParse(data) {
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      label: r.display_name || r.name || '',
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    })).filter((r) => !isNaN(r.lat));
  }

  async function geocode(query) {
    const q = String(query || '').trim();
    if (q.length < 3) return [];
    for (const g of CFG.geocoders) {
      try {
        const res = await fetch(g.url(q), { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const out = g.parse(await res.json());
        if (out.length) return out;
      } catch (e) { /* try the next provider */ }
    }
    return [];
  }

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */
  function routeUrl(base, a, b) {
    const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
    return `${base}/route/v1/driving/${coords}` +
           `?overview=full&geometries=geojson&steps=true&alternatives=false`;
  }

  function parseOsrm(data, mode, start, end) {
    if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error((data && data.message) || (data && data.code) || 'no route');
    }
    const rt = data.routes[0];
    const geom = ((rt.geometry && rt.geometry.coordinates) || []).map((c) => [c[1], c[0]]);
    const leg = (rt.legs && rt.legs[0]) || {};
    const steps = (leg.steps || []).map((s) => {
      const m = s.maneuver || {};
      const loc = m.location || [];
      return {
        text: stepText(s),
        dist: s.distance || 0,
        dur: s.duration || 0,
        lat: loc[1], lng: loc[0],
        type: m.type || '', modifier: m.modifier || '',
        name: s.name || '', exit: m.exit,
        icon: stepIcon(m.type, m.modifier),
      };
    });
    return {
      mode,
      distance: rt.distance || leg.distance || 0,
      duration: rt.duration || leg.duration || 0,
      geometry: geom,
      steps,
      start: { lat: start.lat, lng: start.lng, label: start.label },
      end: { lat: end.lat, lng: end.lng, label: end.label },
    };
  }

  async function fetchRoute(start, end, mode) {
    const bases = CFG.routers[mode] || CFG.routers.car;
    let lastErr = null;
    for (const base of bases) {
      try {
        const res = await fetch(routeUrl(base, start, end), { headers: { Accept: 'application/json' } });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        return parseOsrm(await res.json(), mode, start, end);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('routing failed');
  }

  /* ------------------------------------------------------------------ *
   * Turn instructions
   * ------------------------------------------------------------------ */
  const DIR = {
    left: 'left', right: 'right',
    'slight left': 'slightly left', 'slight right': 'slightly right',
    'sharp left': 'sharp left', 'sharp right': 'sharp right',
    straight: 'straight', uturn: 'around',
  };

  function stepText(s) {
    const m = s.maneuver || {};
    const type = m.type || '';
    const mod = DIR[m.modifier] || '';
    const road = s.name ? s.name : '';
    const onto = road ? ' onto ' + road : '';
    const on = road ? ' on ' + road : '';

    switch (type) {
      case 'depart':
        return road ? 'Head out' + on : 'Head out';
      case 'arrive':
        return 'You have arrived' + (road ? ' at ' + road : '');
      case 'turn':
        return mod ? `Turn ${mod}${onto}` : `Turn${onto}`;
      case 'new name':
      case 'continue':
        return mod && mod !== 'straight' ? `Continue ${mod}${onto}` : `Continue${on}`;
      case 'merge':
        return `Merge ${mod || 'ahead'}${onto}`;
      case 'on ramp':
        return `Take the ramp${onto}`;
      case 'off ramp':
        return `Take the exit${onto}`;
      case 'fork':
        return `Keep ${mod || 'straight'}${onto}`;
      case 'end of road':
        return `At the end of the road, turn ${mod || ''}${onto}`.replace('  ', ' ');
      case 'roundabout':
      case 'rotary':
        return m.exit != null
          ? `At the roundabout, take the ${ordinal(m.exit)} exit${onto}`
          : `Enter the roundabout${onto}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Exit the roundabout${onto}`;
      case 'notification':
        return road ? `Continue on ${road}` : 'Continue';
      default:
        return road ? `Continue on ${road}` : 'Continue';
    }
  }

  function stepIcon(type, modifier) {
    if (type === 'arrive') return '⚑';
    if (type === 'depart') return '↑';
    if (type === 'roundabout' || type === 'rotary' ||
        type === 'exit roundabout' || type === 'exit rotary') return '⟳';
    switch (modifier) {
      case 'left': return '←';
      case 'right': return '→';
      case 'slight left': return '↖';
      case 'slight right': return '↗';
      case 'sharp left': return '⤺';
      case 'sharp right': return '⤻';
      case 'uturn': return '⤶';
      default: return '↑';
    }
  }

  /* ------------------------------------------------------------------ *
   * Route geometry maths
   * ------------------------------------------------------------------ */
  const M_PER_DEG_LAT = 111320;
  const mPerDegLng = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

  function buildCumulative(geom) {
    const cum = [0];
    for (let i = 1; i < geom.length; i++) {
      cum.push(cum[i - 1] + API.haversine(
        { lat: geom[i - 1][0], lng: geom[i - 1][1] },
        { lat: geom[i][0], lng: geom[i][1] }));
    }
    return cum;
  }

  // Project a point onto the polyline; returns distance off-route + how far along.
  function nearestOnRoute(geom, cum, p) {
    let best = { dist: Infinity, along: 0 };
    const kx = mPerDegLng(p.lat);
    for (let i = 1; i < geom.length; i++) {
      const a = geom[i - 1], b = geom[i];
      const ax = (a[1] - p.lng) * kx, ay = (a[0] - p.lat) * M_PER_DEG_LAT;
      const bx = (b[1] - p.lng) * kx, by = (b[0] - p.lat) * M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < best.dist) {
        best = { dist: d, along: cum[i - 1] + (cum[i] - cum[i - 1]) * t };
      }
    }
    return best;
  }

  function downsample(geom, max) {
    if (geom.length <= max) return geom;
    const out = [], step = (geom.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(geom[Math.round(i * step)]);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */
  function clearDrawing() {
    const map = API.map();
    if (R.layer) { map.removeLayer(R.layer); R.layer = null; }
    if (R.startMarker) { map.removeLayer(R.startMarker); R.startMarker = null; }
    if (R.endMarker) { map.removeLayer(R.endMarker); R.endMarker = null; }
  }

  function pinIcon(color, glyph, label) {
    return L.divIcon({
      className: '',
      html: `<div class="rp"><div class="rp-dot" style="background:${color}">${glyph}</div>` +
            `<div class="rp-lbl">${API.esc(label)}</div></div>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function drawRoute(route) {
    const map = API.map();
    clearDrawing();
    const shared = !route.mine;
    R.layer = L.polyline(route.geometry, {
      color: shared ? '#ffd43b' : '#4dabf7',
      weight: shared ? 5 : 6,
      opacity: 0.85,
      dashArray: shared ? '8 8' : null,
      interactive: false,
    }).addTo(map);

    R.startMarker = L.marker([route.start.lat, route.start.lng], {
      icon: pinIcon('#51cf66', 'A', route.start.label || 'Start'), interactive: false,
    }).addTo(map);
    R.endMarker = L.marker([route.end.lat, route.end.lng], {
      icon: pinIcon('#ff6b6b', 'B', route.end.label || 'Destination'),
    }).addTo(map);

    try {
      map.fitBounds(R.layer.getBounds(), { padding: [70, 70], maxZoom: 16 });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * UI — route panel
   * ------------------------------------------------------------------ */
  function openPanel(open) {
    $('routepanel').classList.toggle('show', open);
    document.body.classList.toggle('routing', open);
    if (open) setTimeout(() => $('rtTo').focus(), 120);
  }

  function setMode(mode) {
    R.mode = mode;
    document.querySelectorAll('#routeModes .mode').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === mode);
    });
    if (R.active && R.active.mine) { /* user must re-fetch */ }
  }

  function renderSuggestions(which, list) {
    const box = $(which === 'from' ? 'rtFromSugg' : 'rtToSugg');
    if (!list.length) { box.innerHTML = ''; box.classList.remove('show'); return; }
    box.innerHTML = list.map((r, i) =>
      `<div class="sugg-item" data-i="${i}">${API.esc(shortLabel(r.label, 60))}</div>`).join('');
    box.classList.add('show');
    box.querySelectorAll('.sugg-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const r = list[+el.dataset.i];
        setPlace(which, r);
        box.innerHTML = ''; box.classList.remove('show');
      });
    });
  }

  function setPlace(which, place) {
    if (which === 'from') { R.from = place; $('rtFrom').value = shortLabel(place.label, 60); }
    else { R.to = place; $('rtTo').value = shortLabel(place.label, 60); }
  }

  function wireSuggest(which) {
    const input = $(which === 'from' ? 'rtFrom' : 'rtTo');
    input.addEventListener('input', () => {
      if (which === 'from') R.from = null; else R.to = null;
      clearTimeout(R.suggestTimer);
      const q = input.value;
      R.suggestTimer = setTimeout(async () => {
        if (q.trim().length < 3) { renderSuggestions(which, []); return; }
        const list = await geocode(q);
        renderSuggestions(which, list);
      }, CFG.suggestDelay);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        const box = $(which === 'from' ? 'rtFromSugg' : 'rtToSugg');
        box.innerHTML = ''; box.classList.remove('show');
      }, 180);
    });
  }

  function useMyLocation(which) {
    const me = API.state.me;
    if (!me || me.lat == null) { API.toast('No GPS fix yet'); return; }
    setPlace(which, { label: 'My location', lat: me.lat, lng: me.lng });
  }

  function renderSummary(route) {
    const el = $('rtSummary');
    const shared = !route.mine;
    el.innerHTML =
      `<div class="sum-row">` +
        `<span class="sum-mode">${MODES[route.mode].label}</span>` +
        `<span class="sum-big">${API.fmtDist(route.distance)}</span>` +
        `<span class="sum-dur">${fmtDuration(route.duration)}</span>` +
        `<span class="sum-eta">arrive ${fmtClock(route.duration)}</span>` +
      `</div>` +
      (shared ? `<div class="sum-by">Route set by ${API.esc(route.by || 'someone')}</div>` : '') +
      `<div class="sum-actions">` +
        `<button id="rtStart" class="primary small">Start navigation</button>` +
        `<button id="rtClear" class="ghost small">Clear</button>` +
      `</div>`;
    $('rtStart').addEventListener('click', () => { startNav(); openPanel(false); });
    $('rtClear').addEventListener('click', () => clearRoute(true));
  }

  function renderSteps(route) {
    const ol = $('rtSteps');
    if (!route.steps || !route.steps.length) { ol.innerHTML = ''; return; }
    ol.innerHTML = route.steps.map((s) =>
      `<li><span class="st-ico">${s.icon}</span>` +
      `<span class="st-txt">${API.esc(s.text)}</span>` +
      `<span class="st-dist">${s.dist >= 20 ? API.fmtDist(s.dist) : ''}</span></li>`).join('');
  }

  /* ------------------------------------------------------------------ *
   * Applying / clearing a route
   * ------------------------------------------------------------------ */
  function applyRoute(route, opts) {
    opts = opts || {};
    R.active = route;
    R.total = route.distance;
    R.cum = buildCumulative(route.geometry);
    R.stepStart = [];
    let acc = 0;
    route.steps.forEach((s) => { R.stepStart.push(acc); acc += s.dist; });
    R.progress = 0; R.nextIdx = -1; R.offRoute = false; R.spoken = {};

    drawRoute(route);
    renderSummary(route);
    renderSteps(route);

    if (route.mine && API.state.joined && !API.state.demo) {
      API.publishRoute(sharePayload(route));
    }
    if (!opts.silent) {
      API.toast(route.mine
        ? `Route: ${API.fmtDist(route.distance)}, ${fmtDuration(route.duration)}`
        : `${route.by || 'Someone'} set a ${MODES[route.mode].label.toLowerCase()} route`);
    }
  }

  function sharePayload(route) {
    return {
      mode: route.mode,
      distance: route.distance,
      duration: route.duration,
      start: route.start,
      end: route.end,
      geometry: downsample(route.geometry, CFG.shareMaxPoints),
      steps: route.steps.slice(0, CFG.shareMaxSteps).map((s) => ({
        text: s.text, dist: s.dist, dur: s.dur, lat: s.lat, lng: s.lng,
        type: s.type, modifier: s.modifier, name: s.name, exit: s.exit, icon: s.icon,
      })),
    };
  }

  function onRemoteRoute(msg) {
    if (!msg || !msg.geometry || !msg.geometry.length) return;
    const route = {
      mode: msg.mode || 'car',
      distance: msg.distance || 0,
      duration: msg.duration || 0,
      geometry: msg.geometry,
      steps: msg.steps || [],
      start: msg.start || {},
      end: msg.end || {},
      by: msg.by || 'someone',
      mine: false,
    };
    R.mode = route.mode;
    setMode(route.mode);
    applyRoute(route, { silent: false });
    openPanel(true);
  }

  function onRemoteClear() {
    if (!R.active) return;
    clearDrawing();
    R.active = null;
    R.nav = false;
    document.body.classList.remove('navigating');
    $('rtSummary').innerHTML = '';
    $('rtSteps').innerHTML = '';
    API.toast('Route cleared');
  }

  function clearRoute(broadcast) {
    if (R.active && R.active.mine && broadcast) API.clearSharedRoute();
    stopNav();
    clearDrawing();
    R.active = null;
    $('rtSummary').innerHTML = '';
    $('rtSteps').innerHTML = '';
    if (broadcast) API.toast('Route cleared');
  }

  /* ------------------------------------------------------------------ *
   * Getting a route
   * ------------------------------------------------------------------ */
  async function go() {
    if (R.busy) return;
    const me = API.state.me;

    let from = R.from;
    if (!from && $('rtFrom').value.trim()) {
      const list = await geocode($('rtFrom').value);
      if (list.length) { from = list[0]; setPlace('from', from); }
    }
    if (!from && me && me.lat != null) from = { label: 'My location', lat: me.lat, lng: me.lng };

    let to = R.to;
    if (!to && $('rtTo').value.trim()) {
      const list = await geocode($('rtTo').value);
      if (list.length) { to = list[0]; setPlace('to', to); }
    }

    if (!from) { API.toast('Set a start point'); return; }
    if (!to) { API.toast('Set a destination'); return; }

    R.busy = true;
    const btn = $('rtGo');
    btn.disabled = true; btn.textContent = 'Finding route…';
    try {
      const route = await fetchRoute(from, to, R.mode);
      route.mine = true;
      route.by = (me && me.name) || 'you';
      applyRoute(route, { silent: false });
    } catch (e) {
      API.toast('Could not find a route — check your connection');
    } finally {
      R.busy = false;
      btn.disabled = false; btn.textContent = 'Get route';
    }
  }

  /* ------------------------------------------------------------------ *
   * Live navigation
   * ------------------------------------------------------------------ */
  function startNav() {
    if (!R.active) return;
    R.nav = true;
    R.spoken = {};
    document.body.classList.add('navigating');
    openPanel(false);
    speak('Starting navigation');
    tick();
  }

  function stopNav() {
    R.nav = false;
    document.body.classList.remove('navigating');
    try { speechSynthesis.cancel(); } catch (e) {}
  }

  function speak(text) {
    if (R.muted || !text) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function setBanner(icon, main, sub) {
    $('navIco').textContent = icon || '↑';
    $('navMain').textContent = main || '';
    $('navSub').textContent = sub || '';
  }

  // Called by app.js on every GPS fix.
  function tick() {
    if (!R.nav || !R.active) return;
    const me = API.state.me;
    if (!me || me.lat == null) return;

    const n = nearestOnRoute(R.active.geometry, R.cum, me);
    R.offRoute = n.dist > CFG.offRouteM;
    R.progress = Math.max(0, n.along);

    const steps = R.active.steps || [];
    const remaining = Math.max(0, R.total - R.progress);

    // Which manoeuvre is next?
    let next = -1;
    for (let i = 1; i < steps.length; i++) {
      if (R.stepStart[i] > R.progress + 3) { next = i; break; }
    }
    R.nextIdx = next;

    if (R.offRoute) {
      setBanner('⚠', 'Off route', `${API.fmtDist(n.dist)} from the route`);
      announce('offroute', 'You are off the route. Recalculate when safe.');
    } else if (next === -1 || remaining < CFG.arriveM) {
      setBanner('⚑', 'Arriving', R.active.end && R.active.end.label ? shortLabel(R.active.end.label, 28) : 'Destination');
      announce('arrive', 'You have arrived at your destination');
    } else {
      const step = steps[next];
      const d = Math.max(0, R.stepStart[next] - R.progress);
      if (step.type === 'arrive') {
        setBanner('⚑', `Destination in ${API.fmtDist(d)}`, step.name || '');
        if (d < 80) announce('arrive-soon', 'You are arriving at your destination');
      } else {
        setBanner(step.icon, `${API.fmtDist(d)} · ${step.text}`, step.name || '');
        announceStep(next, d, step);
      }
    }

    const pct = R.total ? Math.min(100, Math.round(R.progress / R.total * 100)) : 0;
    const eta = R.total ? R.active.duration * (remaining / R.total) : 0;
    $('navRemain').textContent =
      `${API.fmtDist(remaining)} left · ${fmtDuration(eta)} · ${pct}%`;
  }

  function announceStep(idx, dist, step) {
    const thresholds = (MODES[R.active.mode] || MODES.car).speak;
    for (const t of thresholds) {
      const key = `${idx}:${t}`;
      if (dist <= t && !R.spoken[key]) {
        if (R.muted) return;   // don't consume the announcement while muted
        // mark all larger thresholds for this step as done too
        for (const t2 of thresholds) if (t2 >= t) R.spoken[`${idx}:${t2}`] = true;
        if (t >= 25) speak(`In ${Math.round(dist)} metres, ${step.text}`);
        else speak(step.text);
        return;
      }
    }
  }

  function announce(key, text) {
    if (R.spoken[key]) return;
    R.spoken[key] = true;
    speak(text);
  }

  function recalc() {
    if (!R.active) return;
    const me = API.state.me;
    if (!me || me.lat == null) { API.toast('No GPS fix yet'); return; }
    R.from = { label: 'My location', lat: me.lat, lng: me.lng };
    R.to = { label: R.active.end.label || 'Destination', lat: R.active.end.lat, lng: R.active.end.lng };
    $('rtFrom').value = 'My location';
    $('rtTo').value = shortLabel(R.to.label, 60);
    go();
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  function init(api) {
    API = api;
    if (typeof L === 'undefined') return;

    document.querySelectorAll('#routeModes .mode').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    $('btnRoute').addEventListener('click', () => {
      const open = !$('routepanel').classList.contains('show');
      openPanel(open);
    });
    $('btnRouteClose').addEventListener('click', () => openPanel(false));
    $('rtFromHere').addEventListener('click', () => useMyLocation('from'));
    $('rtToHere').addEventListener('click', () => useMyLocation('to'));
    $('rtGo').addEventListener('click', go);
    $('navStop').addEventListener('click', () => { stopNav(); });
    $('navRecalc').addEventListener('click', recalc);
    $('navMute').addEventListener('click', () => {
      R.muted = !R.muted;
      $('navMute').textContent = R.muted ? 'Muted' : 'Voice';
      $('navMute').classList.toggle('on', !R.muted);
      if (R.muted) { try { speechSynthesis.cancel(); } catch (e) {} }
    });

    wireSuggest('from');
    wireSuggest('to');

    // If a destination address is pasted in and Enter pressed, go.
    ['rtFrom', 'rtTo'].forEach((id) => {
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });

    api.hooks.onRoute = onRemoteRoute;
    api.hooks.onRouteClear = onRemoteClear;
    api.hooks.tick = tick;
  }

  window.ConvoyRoute = { init };
})();
