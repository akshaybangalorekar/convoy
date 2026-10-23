/* Convoy — finding a place, and the drive to it.
 *
 *   search  : Photon (komoot) for type-ahead, Nominatim (OpenStreetMap) as a fallback
 *   drive   : FOSSGIS OSRM, car profile
 *
 * All three are free and need no key. This module also owns the search sheet.
 */
(function () {
  'use strict';

  const CFG = {
    photon: 'https://photon.komoot.io/api/',
    nominatim: 'https://nominatim.openstreetmap.org/search',
    nominatimReverse: 'https://nominatim.openstreetmap.org/reverse',
    osrm: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    // Restrict the search to one country: 'au' Australia, 'in' India, '' anywhere.
    country: 'au',
    countryBox: { au: '112,-44,154,-10', in: '68,6,98,36' },
    minChars: 3,
    debounceMs: 350,
    maxResults: 6,
    timeoutMs: 9000,
    // Nominatim's usage policy is one request a second at most, so calls are spaced out.
    nominatimGapMs: 1100,
    // How long to wait for its second opinion on a street address before going with what
    // Photon already gave us.
    enrichMs: 3000,
  };

  let API = null;
  let seq = 0;
  let lastNominatimAt = 0;
  let pendingEnrich = null;          // a fuller answer still on its way, if any
  const diag = { note: '' };         // what to tell the user when nothing comes back

  // Same query twice in a row should not cost two requests.
  const cache = new Map();
  const CACHE_MAX = 40;

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- *
   * Network
   * ---------------------------------------------------------------- */
  async function getJson(url, ms) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Join the pieces of an address, dropping the empty ones and anything repeated.
  function tidy(list) {
    const out = [];
    list.forEach((v) => {
      String(v == null ? '' : v).split(', ').forEach((piece) => {
        const t = piece.trim();
        if (t && out.indexOf(t) < 0) out.push(t);
      });
    });
    return out.join(', ');
  }

  // Which of the area names to show. The important part is that anything more local than
  // the city wins: given "Melbourne" in city and "Carnegie" in one of the finer fields,
  // the answer must be Carnegie, not Melbourne. A plain order of preference gets this
  // wrong whenever the city happens to come first in the list.
  function pickArea(p) {
    const city = p.city || '';
    const candidates = [p.suburb, p.neighbourhood, p.city_district, p.district,
                        p.locality, p.county].filter(Boolean);
    const local = candidates.filter((c) => c !== city)[0];
    return local || city || '';
  }

  function pickNominatimArea(a) {
    const city = a.city || a.town || a.village || a.municipality || '';
    const candidates = [a.suburb, a.neighbourhood, a.city_district, a.borough,
                        a.quarter, a.hamlet].filter(Boolean);
    const local = candidates.filter((c) => c !== city)[0];
    return local || city || a.county || '';
  }

  // Photon hands back the parts of an address separately. Put them back together the way
  // an address is written: number and street, then the suburb, then the state and
  // postcode. The country only appears when nothing else places it.
  function addressFrom(p) {
    const num = p.housenumber || '';
    const road = p.street || '';
    const line1 = (num && road) ? (num + ' ' + road) : (road || p.name || num || '');
    const region = [p.state, p.postcode].filter(Boolean).join(' ') || p.country || '';
    return tidy([line1, pickArea(p), region]);
  }

  // The same, from Nominatim's address breakdown.
  function addressFromNominatim(r) {
    const a = r.address || {};
    const num = a.house_number || '';
    const road = a.road || '';
    const line1 = (num && road) ? (num + ' ' + road) : (road || r.name || num || '');
    const region = [a.state, a.postcode].filter(Boolean).join(' ') || a.country || '';
    return tidy([line1, pickNominatimArea(a), region]);
  }

  // `plain` drops the country restriction and the location bias — the plainest possible
  // question, asked as a last resort before telling someone their address does not exist.
  async function viaPhoton(q, plain) {
    let url = CFG.photon + '?q=' + encodeURIComponent(q) +
              '&limit=' + CFG.maxResults + '&lang=en';
    const box = plain ? '' : CFG.countryBox[CFG.country];
    if (box) url += '&bbox=' + box;

    // Bias towards where the phone is, so a street near you beats a namesake far away.
    const me = !plain && API && API.state && API.state.me;
    if (me && me.lat != null && me.lng != null) url += '&lat=' + me.lat + '&lon=' + me.lng;

    const j = await getJson(url, CFG.timeoutMs);
    if (!j || !Array.isArray(j.features)) return null;
    return j.features
      .filter((f) => f && f.geometry && Array.isArray(f.geometry.coordinates))
      .map((f) => {
        const p = f.properties || {};
        const c = f.geometry.coordinates;
        return {
          lat: c[1], lng: c[0],
          label: addressFrom(p),
          // Did it come with enough to place it properly — a postcode or a state?
          placed: !!(p.postcode || p.state),
        };
      })
      .filter((r) => r.label && isFinite(r.lat) && isFinite(r.lng));
  }

  async function viaNominatim(q, plain) {
    // Stay inside their one-request-a-second policy, however fast the typing is.
    const wait = Math.max(0, CFG.nominatimGapMs - (Date.now() - lastNominatimAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();

    let url = CFG.nominatim + '?q=' + encodeURIComponent(q) +
              '&format=jsonv2&limit=' + CFG.maxResults +
              '&addressdetails=1&accept-language=en';
    if (CFG.country && !plain) url += '&countrycodes=' + CFG.country;

    const j = await getJson(url, CFG.timeoutMs);
    if (!Array.isArray(j)) return null;
    return j
      .map((r) => ({
        lat: parseFloat(r.lat), lng: parseFloat(r.lon),
        label: addressFromNominatim(r) || r.display_name || '',
      }))
      .filter((r) => r.label && isFinite(r.lat) && isFinite(r.lng));
  }

  // "92 mimosa road" is an address; "mimosa road" or "carnegie" is a place.
  const looksLikeAddress = (q) => /^\s*\d+[\s,]/.test(q);

  // What is at a point on the map — for a pin dropped by a long press. Same service and
  // the same rate limit as the search, because it is the same policy.
  async function reverse(lat, lng) {
    const la = Number(lat), ln = Number(lng);
    if (!isFinite(la) || !isFinite(ln)) return '';
    const wait = Math.max(0, CFG.nominatimGapMs - (Date.now() - lastNominatimAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();

    const url = CFG.nominatimReverse + '?lat=' + la + '&lon=' + ln +
                '&format=jsonv2&zoom=18&addressdetails=1&accept-language=en';
    const j = await getJson(url, CFG.timeoutMs);
    if (!j || typeof j !== 'object') return '';
    return addressFromNominatim(j) || j.display_name || '';
  }

  // Do not wait on a service forever. Used for the second opinion below.
  function withDeadline(promise, ms) {
    return Promise.race([
      promise.catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  async function search(q) {
    const query = String(q || '').trim();
    pendingEnrich = null;
    if (query.length < CFG.minChars) return [];
    if (cache.has(query)) return cache.get(query);
    diag.note = '';

    // `null` means a service could not be reached; an empty list means it answered and
    // had nothing. The difference matters, because only one of those is the user's fault.
    let answered = false;

    // Photon first, always. It is quick, it has no rate limit, and its answer means a
    // search never comes back empty-handed just because the other service is unhappy.
    //
    // Every check below is on `.length`, never on truthiness: an empty list is TRUTHY in
    // JavaScript, so a plain `a || b` would let a service that answered with nothing hide
    // the one that had the answer. That is exactly how this broke before.
    let out = await viaPhoton(query);
    if (out !== null) answered = true;
    out = out || [];

    if (!out.length) {
      const other = await viaNominatim(query);
      if (other !== null) answered = true;
      if (other && other.length) out = other;
    } else if (looksLikeAddress(query) && !out.some((r) => r.placed)) {
      // Photon often returns a street address without its suburb or postcode. Ask the
      // service built for addresses for a second opinion and swap it in when it lands —
      // the answer we already have is on screen in the meantime.
      pendingEnrich = withDeadline(viaNominatim(query), CFG.enrichMs);
    }

    // The country restriction is a preference, not a rule. If it has hidden everything,
    // ask again without it rather than telling someone their address does not exist.
    if (!out.length && CFG.country) {
      const loose = await viaPhoton(query, true);
      if (loose !== null) answered = true;
      if (loose && loose.length) out = loose;
      if (!out.length) {
        const looseOther = await withDeadline(viaNominatim(query, true), CFG.enrichMs);
        if (looseOther && looseOther.length) out = looseOther;
      }
    }

    if (!out.length) {
      diag.note = answered
        ? 'Nothing found for "' + query + '". Try a different name.'
        : 'Could not reach the address service. Check your connection and try again.';
    }

    if (out.length) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(query, out);
    }
    return out;
  }

  // A fuller answer still on its way, if any. The caller renders what it has, then waits
  // on this and swaps it in.
  function takeEnrichment() {
    const p = pendingEnrich;
    pendingEnrich = null;
    return p;
  }

  // The drive from one point to another: how far, how long, and the line to draw.
  async function drive(from, to) {
    if (!from || !to) return null;
    const url = CFG.osrm + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat +
                '?overview=full&geometries=geojson';
    const j = await getJson(url, CFG.timeoutMs);
    if (!j || !Array.isArray(j.routes) || !j.routes.length) return null;
    const r = j.routes[0];
    const coords = (r.geometry && r.geometry.coordinates) || [];
    return {
      distance: r.distance,
      duration: r.duration,
      geometry: coords.map((c) => [c[1], c[0]]),
    };
  }

  /* ---------------------------------------------------------------- *
   * Recent places
   *
   * The last few places this phone chose. Kept on the phone and nowhere else —
   * it is never sent to the room, so it is yours alone, not the group's.
   * ---------------------------------------------------------------- */
  const RECENT_KEY = 'convoy.recent';
  const RECENT_MAX = 5;

  const isPlace = (p) => !!p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
                         typeof p.label === 'string' && p.label !== '';

  const samePlace = (a, b) => !!a && !!b && a.label === b.label &&
    Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter(isPlace).slice(0, RECENT_MAX);
    } catch (e) { return []; }
  }

  function saveRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
    catch (e) { /* full or blocked; the history is a nicety, not essential */ }
  }

  // Choosing somewhere again moves it back to the top rather than listing it twice.
  function rememberPlace(place) {
    if (!isPlace(place)) return;
    const list = loadRecent().filter((p) => !samePlace(p, place));
    list.unshift({ lat: place.lat, lng: place.lng, label: place.label, ts: Date.now() });
    saveRecent(list);
  }

  /* ---------------------------------------------------------------- *
   * The search sheet
   * ---------------------------------------------------------------- */
  let debounce = null;

  function showHint(text) {
    $('results').innerHTML = '<li class="hint">' + text + '</li>';
  }

  // Shown on opening the sheet: where this phone last went, ready to tap again.
  function showRecent() {
    const list = loadRecent();
    const ul = $('results');
    if (!list.length) {
      showHint('Type at least ' + CFG.minChars + ' letters to search.');
      return;
    }
    ul.innerHTML = '<li class="head">Recent</li>' + list.map((r, i) =>
      '<li data-recent="' + i + '">' + API.esc(r.label) + '</li>').join('');
    ul.querySelectorAll('li[data-recent]').forEach((li) => {
      li.addEventListener('click', () => {
        const r = list[parseInt(li.getAttribute('data-recent'), 10)];
        if (!r) return;
        try {
          API.setDest(r.lat, r.lng, r.label);
          rememberPlace(r);
        } finally {
          closeSearch();
        }
      });
    });
  }

  // Android's back button should close the sheet, not leave the app. Pushing a history
  // entry when the sheet opens gives back something to do; iOS has no back button, but
  // the swipe-back gesture fires the same event, so both behave alike.
  let pushed = false;

  function openSearch() {
    $('search').classList.remove('hidden');
    $('inSearch').value = '';
    $('btnClearDest').style.display = API.state.dest ? '' : 'none';
    showRecent();
    if (!pushed) {
      try { history.pushState({ convoySheet: 'search' }, ''); pushed = true; } catch (e) {}
    }
    setTimeout(() => { try { $('inSearch').focus(); } catch (e) {} }, 60);
  }

  function closeSearch() {
    $('search').classList.add('hidden');
    try { $('inSearch').blur(); } catch (e) {}
    if (pushed) {
      pushed = false;
      try { history.back(); } catch (e) {}
    }
  }

  // The back button (or the swipe) was used while the sheet was open.
  function onPop() {
    if (!pushed) return;
    pushed = false;
    closeSearch();
  }

  // What the list currently shows. The rows read from this at tap time rather than
  // closing over one particular array, so a row can be updated without being replaced.
  let shown = [];

  function renderResults(list) {
    const ul = $('results');
    if (!list.length) { showHint(diag.note || 'Nothing found. Try a different name.'); return; }

    // If the same number of rows is already on screen, update them in place. Replacing
    // the list takes the row out from under a finger that is already on it, and iOS then
    // never delivers the tap at all — which is exactly what happened when the fuller
    // address arrived a second after the quick one.
    const rows = ul.querySelectorAll('li[data-i]');
    if (rows.length === list.length && !ul.querySelector('li.head')) {
      list.forEach((r, i) => {
        if (rows[i].textContent !== r.label) rows[i].textContent = r.label;
      });
      shown = list;
      return;
    }

    ul.innerHTML = list.map((r, i) =>
      '<li data-i="' + i + '">' + API.esc(r.label) + '</li>').join('');
    ul.querySelectorAll('li[data-i]').forEach((li) => {
      li.addEventListener('click', () => {
        const r = shown[parseInt(li.getAttribute('data-i'), 10)];
        if (!r) return;
        // Whatever else happens, the sheet gets out of the way.
        try {
          API.setDest(r.lat, r.lng, r.label);
          rememberPlace(r);
        } finally {
          closeSearch();
        }
      });
    });
    shown = list;
  }

  async function runSearch() {
    const q = $('inSearch').value;
    if (String(q).trim().length < CFG.minChars) {
      showHint('Type at least ' + CFG.minChars + ' letters to search.');
      return;
    }
    const mine = ++seq;
    showHint('Searching…');
    const list = await search(q);
    if (mine !== seq) return;                 // a newer keystroke won
    if ($('search').classList.contains('hidden')) return;
    if (!list.length) { showHint(diag.note || 'Nothing found.'); return; }
    renderResults(list);

    // A fuller address may still be coming. Swap it in when it lands.
    const enrich = takeEnrichment();
    if (!enrich) return;
    const better = await enrich;
    if (mine !== seq) return;
    if ($('search').classList.contains('hidden')) return;
    if (better && better.length) renderResults(better);
  }

  function init(api) {
    API = api;
    window.addEventListener('popstate', onPop);
    $('btnSearchClose').addEventListener('click', closeSearch);
    // A tap on the dimmed area, outside the card, always gets you out.
    $('search').addEventListener('click', (e) => {
      if (e.target === $('search')) closeSearch();
    });
    $('btnClearDest').addEventListener('click', () => {
      API.clearDest();
      closeSearch();
    });
    $('inSearch').addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      // Clearing the box brings the recent places back.
      if (!$('inSearch').value.trim()) { showRecent(); return; }
      debounce = setTimeout(runSearch, CFG.debounceMs);
    });
    $('inSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (debounce) clearTimeout(debounce); runSearch(); }
      if (e.key === 'Escape') closeSearch();
    });
  }

  window.ConvoyRoute = {
    init, openSearch, closeSearch, search, drive, reverse,
    _internals: { CFG, getJson, tidy, addressFrom, addressFromNominatim,
                  pickArea, pickNominatimArea, looksLikeAddress, cache, withDeadline,
                  diag, takeEnrichment, loadRecent, rememberPlace, showRecent, RECENT_MAX,
                  shownList: () => shown, reverse },
  };
})();
