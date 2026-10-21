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
    osrm: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    // Restrict the search to one country: 'au' Australia, 'in' India, '' anywhere.
    country: 'au',
    countryBox: { au: '112,-44,154,-10', in: '68,6,98,36' },
    minChars: 3,
    debounceMs: 350,
    maxResults: 6,
    timeoutMs: 9000,
  };

  let API = null;
  let seq = 0;

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

  // Photon hands back the parts of an address separately. Put them back together the way
  // an address is written: number and street, then the suburb, then the state and
  // postcode. The country only appears when nothing else places it.
  function addressFrom(p) {
    const num = p.housenumber || '';
    const road = p.street || '';
    const line1 = (num && road) ? (num + ' ' + road) : (road || p.name || num || '');
    const area = p.suburb || p.neighbourhood || p.locality || p.city || p.district || '';
    const region = [p.state, p.postcode].filter(Boolean).join(' ') || p.country || '';
    return tidy([line1, area, region]);
  }

  // The same, from Nominatim's address breakdown.
  function addressFromNominatim(r) {
    const a = r.address || {};
    const num = a.house_number || '';
    const road = a.road || '';
    const line1 = (num && road) ? (num + ' ' + road) : (road || r.name || num || '');
    const area = a.suburb || a.neighbourhood || a.city_district || a.town ||
                 a.village || a.city || a.municipality || '';
    const region = [a.state, a.postcode].filter(Boolean).join(' ') || a.country || '';
    return tidy([line1, area, region]);
  }

  async function viaPhoton(q) {
    let url = CFG.photon + '?q=' + encodeURIComponent(q) +
              '&limit=' + CFG.maxResults + '&lang=en';
    const box = CFG.countryBox[CFG.country];
    if (box) url += '&bbox=' + box;

    // Bias towards where the phone is, so a street near you beats a namesake far away.
    const me = API && API.state && API.state.me;
    if (me && me.lat != null) url += '&lat=' + me.lat + '&lon=' + me.lng;

    const j = await getJson(url, CFG.timeoutMs);
    if (!j || !Array.isArray(j.features)) return null;
    return j.features
      .filter((f) => f && f.geometry && Array.isArray(f.geometry.coordinates))
      .map((f) => {
        const c = f.geometry.coordinates;
        return { lat: c[1], lng: c[0], label: addressFrom(f.properties || {}) };
      })
      .filter((r) => r.label && isFinite(r.lat) && isFinite(r.lng));
  }

  async function viaNominatim(q) {
    let url = CFG.nominatim + '?q=' + encodeURIComponent(q) +
              '&format=jsonv2&limit=' + CFG.maxResults + '&addressdetails=1';
    if (CFG.country) url += '&countrycodes=' + CFG.country;

    const j = await getJson(url, CFG.timeoutMs);
    if (!Array.isArray(j)) return null;
    return j
      .map((r) => ({
        lat: parseFloat(r.lat), lng: parseFloat(r.lon),
        label: addressFromNominatim(r) || r.display_name || '',
      }))
      .filter((r) => r.label && isFinite(r.lat) && isFinite(r.lng));
  }

  async function search(q) {
    const query = String(q || '').trim();
    if (query.length < CFG.minChars) return [];
    const a = await viaPhoton(query);
    if (a && a.length) return a;
    const b = await viaNominatim(query);
    return b || a || [];
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
   * The search sheet
   * ---------------------------------------------------------------- */
  let debounce = null;

  function showHint(text) {
    $('results').innerHTML = '<li class="hint">' + text + '</li>';
  }

  function openSearch() {
    $('search').classList.remove('hidden');
    $('inSearch').value = '';
    $('btnClearDest').style.display = API.state.dest ? '' : 'none';
    showHint('Type at least ' + CFG.minChars + ' letters to search.');
    setTimeout(() => { try { $('inSearch').focus(); } catch (e) {} }, 60);
  }

  function closeSearch() {
    $('search').classList.add('hidden');
    try { $('inSearch').blur(); } catch (e) {}
  }

  function renderResults(list) {
    const ul = $('results');
    if (!list.length) { showHint('Nothing found. Try a different name.'); return; }
    ul.innerHTML = list.map((r, i) =>
      '<li data-i="' + i + '">' + API.esc(r.label) + '</li>').join('');
    ul.querySelectorAll('li[data-i]').forEach((li) => {
      li.addEventListener('click', () => {
        const r = list[parseInt(li.getAttribute('data-i'), 10)];
        if (!r) return;
        API.setDest(r.lat, r.lng, r.label);
        closeSearch();
      });
    });
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
    renderResults(list);
  }

  function init(api) {
    API = api;
    $('btnSearchClose').addEventListener('click', closeSearch);
    $('btnClearDest').addEventListener('click', () => {
      API.clearDest();
      closeSearch();
    });
    $('inSearch').addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(runSearch, CFG.debounceMs);
    });
    $('inSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (debounce) clearTimeout(debounce); runSearch(); }
      if (e.key === 'Escape') closeSearch();
    });
  }

  window.ConvoyRoute = {
    init, openSearch, closeSearch, search, drive,
    _internals: { CFG, getJson, tidy, addressFrom, addressFromNominatim },
  };
})();
