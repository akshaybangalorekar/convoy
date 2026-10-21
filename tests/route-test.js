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

const MEL = { lat: -37.75, lng: 145.09 };

// A Photon reply for a street address, with the parts kept separate.
const photonAddress = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [MEL.lng, MEL.lat] },
        properties: {
          name: '25', housenumber: '25', street: 'Chippendale Road',
          suburb: 'Templestowe', city: 'Melbourne',
          state: 'Victoria', postcode: '3106', country: 'Australia',
        },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

// The same address from Nominatim, which breaks it down under `address`.
const nominatimAddress = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  }
  if (url.indexOf('nominatim.openstreetmap.org') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ([{
      lat: String(MEL.lat), lon: String(MEL.lng), name: '25',
      display_name: '25, Chippendale Road, Templestowe, Melbourne, Victoria, 3106, Australia',
      address: { house_number: '25', road: 'Chippendale Road', suburb: 'Templestowe',
                 city: 'Melbourne', state: 'Victoria', postcode: '3106', country: 'Australia' },
    }]) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

// Photon knows the suburb but files it under a finer field than the city.
const photonCarnegie = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [145.05, -37.89] },
        properties: {
          name: 'Mimosa Road', street: 'Mimosa Road', housenumber: '92',
          city: 'Melbourne', locality: 'Carnegie', state: 'Victoria',
          postcode: '3163', country: 'Australia',
        },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

// Nominatim, which is built for addresses and keeps the suburb properly.
const nominatimCarnegie = (url) => {
  if (url.indexOf('nominatim.openstreetmap.org') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ([{
      lat: '-37.89', lon: '145.05', name: '92',
      display_name: '92, Mimosa Road, Carnegie, Melbourne, Victoria, 3163, Australia',
      address: { house_number: '92', road: 'Mimosa Road', suburb: 'Carnegie',
                 city: 'Melbourne', state: 'Victoria', postcode: '3163', country: 'Australia' },
    }]) });
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
  check('the label does not repeat a part',
        hits[0] && hits[0].label.split(', ').length ===
        new Set(hits[0].label.split(', ')).size, hits[0] && hits[0].label);

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

/* ---------- Addresses read like addresses ---------- */
async function testStreetAddressLabel() {
  const api = boot({ fetch: photonAddress });
  const hits = await api.window.ConvoyRoute.search('25 chippendale');
  const label = (hits[0] && hits[0].label) || '';

  check('a street address is found', hits.length === 1, JSON.stringify(hits));
  check('the label leads with the number and street',
        /^25 Chippendale Road/.test(label), label);
  check('it names the suburb', /Templestowe/.test(label), label);
  check('it carries the postcode', /3106/.test(label), label);
  check('it carries the state', /Victoria/.test(label), label);
  check('it does not repeat a part',
        label.split(', ').length === new Set(label.split(', ')).size, label);
  check('it does not trail off into the country', !/Australia/.test(label), label);
  check('it reads as number, street, suburb, state and postcode',
        label === '25 Chippendale Road, Templestowe, Victoria 3106', label);
}

async function testFallbackAddressLabel() {
  const api = boot({ fetch: nominatimAddress });
  const hits = await api.window.ConvoyRoute.search('25 chippendale');
  const label = (hits[0] && hits[0].label) || '';

  check('the fallback builds the same kind of address',
        /^25 Chippendale Road/.test(label), label);
  check('with the suburb', /Templestowe/.test(label), label);
  check('and the postcode', /3106/.test(label), label);
  check('and no country', !/Australia/.test(label), label);

  const url = api.netCalls.map((c) => c.url)
    .find((u) => u.indexOf('nominatim') >= 0) || '';
  check('the fallback is asked for the address breakdown', /addressdetails=1/.test(url), url);
}

async function testSuburbBeatsTheCity() {
  const api = boot({ fetch: photonCarnegie });
  const hits = await api.window.ConvoyRoute.search('mimosa road');
  const label = (hits[0] && hits[0].label) || '';

  check('the suburb wins over the city', /Carnegie/.test(label), label);
  check('the city does not crowd it out', !/Melbourne/.test(label), label);
  check('and the postcode comes with it', /3163/.test(label), label);
  check('the whole address reads right',
        label === '92 Mimosa Road, Carnegie, Victoria 3163', label);
}

async function testAnAddressGetsTheFullAddress() {
  const api = boot({ fetch: nominatimCarnegie });
  const hits = await api.window.ConvoyRoute.search('92 mimosa road');
  const label = (hits[0] && hits[0].label) || '';

  check('an address search returns the address', hits.length === 1, JSON.stringify(hits));
  check('with the suburb', /Carnegie/.test(label), label);
  check('and the postcode', /3163/.test(label), label);
  check('and not just the country', !/Australia/.test(label), label);

  const urls = api.netCalls.map((c) => c.url);
  check('the address service is consulted',
        urls.some((u) => u.indexOf('nominatim') >= 0), urls.join(' '));
  check('and asked for the address breakdown',
        urls.some((u) => /addressdetails=1/.test(u)), urls.join(' '));
}

/* ---------- A service answering with nothing must not hide one with an answer ---------- */
// Photon answers properly, but with an empty list. This is what broke the search:
// an empty array is truthy, so `a || b` stopped there and never asked Nominatim.
const photonAnswersEmpty = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ features: [] }) });
  }
  return nominatimCarnegie(url);
};

const nominatimAnswersEmpty = (url) => {
  if (url.indexOf('nominatim.openstreetmap.org') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

// Photon has the street; the address service is refusing us outright.
const photonCarnegieNominatimDown = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [145.05, -37.89] },
        properties: {
          name: 'Mimosa Road', street: 'Mimosa Road', housenumber: '92',
          city: 'Melbourne', locality: 'Carnegie', state: 'Victoria',
          postcode: '3163', country: 'Australia',
        },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
};

// Photon knows the street but not the postcode; Nominatim knows both.
const photonThinNominatimRich = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [145.05, -37.89] },
        properties: {
          name: 'Mimosa Road', street: 'Mimosa Road', housenumber: '92',
          city: 'Melbourne', locality: 'Carnegie', country: 'Australia',
        },
      }],
    }) });
  }
  return nominatimCarnegie(url);
};

async function testAnEmptyAnswerDoesNotHideTheOther() {
  const api = boot({ fetch: photonAnswersEmpty });
  const hits = await api.window.ConvoyRoute.search('92 mimosa road');
  check('a service that answers with nothing does not hide the one with an answer',
        hits.length === 1 && /Carnegie/.test(hits[0].label), JSON.stringify(hits));

  const other = boot({ fetch: nominatimAnswersEmpty });
  const none = await other.window.ConvoyRoute.search('92 mimosa road');
  check('and the same the other way round', none.length === 0, JSON.stringify(none));
}

async function testResultsSurviveTheOtherServiceBeingDown() {
  const api = boot({ fetch: photonCarnegieNominatimDown });
  const hits = await api.window.ConvoyRoute.search('92 mimosa road');
  check('a broken second service does not empty the search', hits.length === 1,
        JSON.stringify(hits));
  check('the first service\'s answer stands', /Mimosa Road/.test(hits[0].label),
        hits[0].label);
}

async function testAFullerAnswerArrivesAfterTheFirst() {
  const api = boot({ fetch: photonThinNominatimRich });
  const R = api.window.ConvoyRoute;

  const first = await R.search('92 mimosa road');
  check('the quick answer comes back first, so nothing waits on the slow one',
        first.length === 1 && /Mimosa Road/.test(first[0].label), JSON.stringify(first));

  const enrich = R._internals.takeEnrichment();
  check('a fuller answer is on its way', !!enrich);
  const better = await enrich;
  check('and it carries the postcode the first one lacked',
        better && better.length && /3163/.test(better[0].label), JSON.stringify(better));
  check('and reads as a full address',
        better && better[0].label === '92 Mimosa Road, Carnegie, Victoria 3163',
        better && better[0].label);
}

/* ---------- The country restriction must never be the reason for nothing ---------- */
// Photon hides it behind the country box, but has it when asked plainly.
const photonOnlyWithoutTheBox = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    const filtered = url.indexOf('bbox=') >= 0;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: filtered ? [] : [{
        geometry: { coordinates: [145.05, -37.89] },
        properties: {
          name: 'Mimosa Road', street: 'Mimosa Road', housenumber: '92',
          locality: 'Carnegie', state: 'Victoria', postcode: '3163', country: 'Australia',
        },
      }],
    }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
};

async function testTheCountryFilterCannotHideAnAnswer() {
  const api = boot({ fetch: photonOnlyWithoutTheBox });
  const hits = await api.window.ConvoyRoute.search('92 mimosa road');

  check('a result the country filter hid is still found', hits.length === 1,
        JSON.stringify(hits));
  check('and it is the right one', /Carnegie/.test(hits[0].label), hits[0].label);

  const photonCalls = api.netCalls.map((c) => c.url)
    .filter((u) => u.indexOf('photon') >= 0);
  check('the question is asked again without the restriction',
        photonCalls.length >= 2 && photonCalls.some((u) => u.indexOf('bbox=') < 0),
        photonCalls.join(' '));
}

/* ---------- When nothing comes back, say why ---------- */
const everythingAnswersEmpty = (url) => Promise.resolve({
  ok: true, status: 200,
  json: async () => (url.indexOf('photon') >= 0 ? { features: [] } : []),
});
const everythingIsDown = () => Promise.resolve({
  ok: false, status: 503, json: async () => ({}),
});

async function testTheMessageSaysWhatWentWrong() {
  const empty = boot({ fetch: everythingAnswersEmpty });
  const none = await empty.window.ConvoyRoute.search('92 mimosa road');
  check('no results when the services answered with nothing', none.length === 0);
  check('and the message says nothing was found',
        /Nothing found/.test(empty.window.ConvoyRoute._internals.diag.note),
        empty.window.ConvoyRoute._internals.diag.note);
  check('naming what was searched for',
        /92 mimosa road/.test(empty.window.ConvoyRoute._internals.diag.note),
        empty.window.ConvoyRoute._internals.diag.note);

  const down = boot({ fetch: everythingIsDown });
  const none2 = await down.window.ConvoyRoute.search('92 mimosa road');
  check('no results when the services cannot be reached', none2.length === 0);
  check('and the message says that instead of blaming the name',
        /Could not reach/.test(down.window.ConvoyRoute._internals.diag.note),
        down.window.ConvoyRoute._internals.diag.note);
  check('and does not claim the address does not exist',
        !/Nothing found/.test(down.window.ConvoyRoute._internals.diag.note),
        down.window.ConvoyRoute._internals.diag.note);
}

async function testAPlaceIsNotLookedUpTwice() {
  const api = boot({ fetch: photonCarnegie });
  await api.window.ConvoyRoute.search('carnegie');
  const urls = api.netCalls.map((c) => c.url);
  check('a place name is not sent to the address service as well',
        !urls.some((u) => u.indexOf('nominatim') >= 0), urls.join(' '));
}

async function testPlaceStillGoesToPhotonFirst() {
  const api = boot({ fetch: photonCarnegie });
  await api.window.ConvoyRoute.search('carnegie');
  const urls = api.netCalls.map((c) => c.url);
  check('a place name still goes to the type-ahead service first',
        !!urls[0] && urls[0].indexOf('photon') >= 0, urls[0]);
}

async function testAddressServiceIsNotHammered() {
  const api = boot({ fetch: nominatimCarnegie });
  const R = api.window.ConvoyRoute;
  R._internals.CFG.nominatimGapMs = 90;      // stand-in for the real 1100ms

  await R.search('92 mimosa road');
  const started = Date.now();
  await R.search('94 mimosa road');
  const gap = Date.now() - started;
  check('address lookups are spaced out to respect the service', gap >= 70, String(gap));
}

async function testRepeatsAreCached() {
  const api = boot({ fetch: nominatimCarnegie });
  const R = api.window.ConvoyRoute;
  await R.search('92 mimosa road');
  const after = api.netCalls.length;
  await R.search('92 mimosa road');
  check('asking the same thing twice costs nothing the second time',
        api.netCalls.length === after, String(api.netCalls.length - after));
}

async function testSearchBiasedToYou() {
  const api = boot({ fetch: photonAddress });
  api.join('Akshay', 'goa-trip');
  api.fix(MEL.lat, MEL.lng);
  await sleep(20);

  api.netCalls.length = 0;
  await api.window.ConvoyRoute.search('25 chippendale');
  const url = api.netCalls.map((c) => c.url)
    .find((u) => u.indexOf('photon') >= 0) || '';
  check('a search leans towards where the phone is, so the nearby street wins',
        url.indexOf('lat=-37.75') >= 0 && url.indexOf('lon=145.09') >= 0, url);
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
  check('with the right place', api.window.Convoy.state.dest.label === 'Sydney, New South Wales',
        api.window.Convoy.state.dest.label);
  check('the sheet closes', d.getElementById('search').classList.contains('hidden'));
  check('the destination row updates',
        d.getElementById('destText').textContent === 'Sydney, New South Wales',
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
    await testStreetAddressLabel();
    await testFallbackAddressLabel();
    await testSuburbBeatsTheCity();
    await testAnAddressGetsTheFullAddress();
    await testAnEmptyAnswerDoesNotHideTheOther();
    await testResultsSurviveTheOtherServiceBeingDown();
    await testAFullerAnswerArrivesAfterTheFirst();
    await testTheCountryFilterCannotHideAnAnswer();
    await testTheMessageSaysWhatWentWrong();
    await testAPlaceIsNotLookedUpTwice();
    await testPlaceStillGoesToPhotonFirst();
    await testAddressServiceIsNotHammered();
    await testRepeatsAreCached();
    await testSearchBiasedToYou();
    await testDrive();
    await testSearchSheet();
  } catch (e) { crash(e); }
  finish('route');
})();
