/* Finding a place, and the drive to it: route.js plus the search sheet. */
'use strict';

const { boot, check, sleep, finish, crash } = require('./harness');

const SYD = { lat: -33.8688, lng: 151.2093 };

const photonOk = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [SYD.lng, SYD.lat] },
        properties: { name: 'Sydney', city: 'Sydney', state: 'New South Wales', country: 'Australia' },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

const photonDown = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  }
  if (url.indexOf('nominatim.openstreetmap.org') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ([
      { lat: String(SYD.lat), lon: String(SYD.lng), display_name: 'Sydney, New South Wales, Australia' },
    ]) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

const driveOk = (url) => {
  if (url.indexOf('routing.openstreetmap.de') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      routes: [{
        distance: 5000, duration: 600,
        geometry: { coordinates: [[151.2, -33.8], [151.3, -33.9]] },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

/* ---------- The helpers ---------- */
async function testSearch() {
  const api = boot({ fetch: photonOk });
  const R = api.window.ConvoyRoute;

  const short = await R.search('sy');
  check('a very short query searches nothing', Array.isArray(short) && short.length === 0,
        JSON.stringify(short));

  const hits = await R.search('sydney');
  check('a search returns places', hits.length === 1, JSON.stringify(hits));
  check('with coordinates', hits[0] && Math.abs(hits[0].lat - SYD.lat) < 1e-6,
        JSON.stringify(hits[0]));
  check('and a readable label', hits[0] && /Sydney/.test(hits[0].label), hits[0] && hits[0].label);
  check('the label is not doubled up',
        hits[0] && hits[0].label.split(',').length === 3, hits[0] && hits[0].label);

  const urls = api.netCalls.map((c) => c.url);
  check('the search is scoped to one country',
        urls.some((u) => /bbox=112,-44,154,-10/.test(u)), urls.join(' '));
}

async function testSearchFallback() {
  const api = boot({ fetch: photonDown });
  const R = api.window.ConvoyRoute;
  const hits = await R.search('sydney');
  check('when the first service is down the second answers', hits.length === 1,
        JSON.stringify(hits));
  check('and the label comes from it', /Australia/.test(hits[0].label), hits[0].label);
  check('the fallback is asked only after the first fails',
        api.netCalls.map((c) => c.url).join(' ').indexOf('photon') <
        api.netCalls.map((c) => c.url).join(' ').indexOf('nominatim'));
}

async function testDrive() {
  const api = boot({ fetch: driveOk });
  const R = api.window.ConvoyRoute;

  const r = await R.drive({ lat: -33.86, lng: 151.2 }, { lat: -33.9, lng: 151.3 });
  check('a drive comes back with a distance', r && r.distance === 5000, JSON.stringify(r));
  check('a duration', r && r.duration === 600);
  check('and a line to draw', r && r.geometry.length === 2, JSON.stringify(r && r.geometry));
  check('the line is in map order (lat, lng)',
        r && Math.abs(r.geometry[0][0] - (-33.8)) < 1e-6, JSON.stringify(r && r.geometry[0]));

  check('no points means no drive', (await R.drive(null, { lat: 1, lng: 1 })) === null);

  const none = boot({ fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ routes: [] }) }) });
  check('an empty answer is handled',
        (await none.window.ConvoyRoute.drive({ lat: 1, lng: 1 }, { lat: 2, lng: 2 })) === null);
}

/* ---------- The search sheet ---------- */
async function testSearchSheet() {
  const api = boot({ fetch: (url) => (
    url.indexOf('photon.komoot.io') >= 0 ? photonOk(url) : driveOk(url)) });
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);

  check('the search sheet starts hidden', d.getElementById('search').classList.contains('hidden'));
  d.getElementById('destRow').click();
  await sleep(20);
  check('tapping the destination row opens the search',
        !d.getElementById('search').classList.contains('hidden'));
  check('it says what to do', /letters/.test(d.getElementById('results').textContent),
        d.getElementById('results').textContent);

  d.getElementById('inSearch').value = 'sydney';
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(500);          // past the debounce, and the fetch

  const rows = d.querySelectorAll('#results li[data-i]');
  check('results are listed', rows.length === 1, String(rows.length));
  check('with the place name', /Sydney/.test(rows[0] ? rows[0].textContent : ''),
        rows[0] ? rows[0].textContent : '');

  rows[0].click();
  await sleep(40);
  check('picking one sets the destination',
        !!api.window.Convoy.state.dest, JSON.stringify(api.window.Convoy.state.dest));
  check('with the right place', api.window.Convoy.state.dest.label === 'Sydney, New South Wales, Australia',
        api.window.Convoy.state.dest.label);
  check('the sheet closes', d.getElementById('search').classList.contains('hidden'));
  check('the destination row updates', d.getElementById('destText').textContent === 'Sydney, New South Wales, Australia',
        d.getElementById('destText').textContent);
  check('and the room is told', !!api.sent('dest'));

  // clearing
  d.getElementById('destRow').click();
  await sleep(20);
  d.getElementById('btnClearDest').click();
  await sleep(20);
  check('the clear button empties the destination', api.window.Convoy.state.dest === null);
  check('and says so in the row', d.getElementById('destText').textContent === 'Set a destination',
        d.getElementById('destText').textContent);
  check('and tells the room', !!api.sent('dest-clear'));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testSearch();
    await testSearchFallback();
    await testDrive();
    await testSearchSheet();
  } catch (e) { crash(e); }
  finish('route');
})();
