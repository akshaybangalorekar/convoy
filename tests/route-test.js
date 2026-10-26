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

// A hotel: a name worth reading, on top of an address that does not contain it.
const photonHotel = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [MEL.lng, MEL.lat] },
        properties: {
          name: 'Novotel on Collins', osm_key: 'tourism', osm_value: 'hotel',
          housenumber: '270', street: 'Collins Street', city: 'Melbourne',
          state: 'Victoria', postcode: '3000', country: 'Australia',
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

async function testAPlaceNameIsShownWithItsAddress() {
  const api = boot({ fetch: photonHotel });
  await sleep(20);
  const found = await api.window.ConvoyRoute.search('novotel collins');
  check('a hotel comes back with its name', found[0] && found[0].name === 'Novotel on Collins',
        JSON.stringify(found[0] && found[0].name));
  check('and its address', /270 Collins Street/.test(found[0].label), found[0].label);

  api.window.ConvoyRoute.openSearch();
  api.window.ConvoyRoute._internals.renderResults(found);
  await sleep(20);
  const rows = api.document.querySelectorAll('#results li[data-i]');
  check('the row shows the name', rows.length && /Novotel on Collins/.test(rows[0].innerHTML),
        rows.length && rows[0].innerHTML);
  check('with the address under it', rows.length && /270 Collins Street/.test(rows[0].innerHTML),
        rows.length && rows[0].innerHTML);

  rows[0].click();
  await sleep(20);
  check('and choosing it puts the name on the destination bar',
        api.window.Convoy.state.dest && api.window.Convoy.state.dest.label === 'Novotel on Collins',
        api.window.Convoy.state.dest && api.window.Convoy.state.dest.label);
}

async function testAStreetAddressIsNotRepeated() {
  // Photon calls a street by its own name; showing that above the address would just say
  // the same thing twice.
  const api = boot({ fetch: photonAddress });
  await sleep(20);
  const found = await api.window.ConvoyRoute.search('25 chippendale');
  check('a street address gets no separate name', found[0] && found[0].name === '',
        JSON.stringify(found[0] && found[0].name));

  api.window.ConvoyRoute.openSearch();
  api.window.ConvoyRoute._internals.renderResults(found);
  await sleep(20);
  const row = api.document.querySelector('#results li[data-i]');
  check('so the row is one line, the address', row && !/<b>/.test(row.innerHTML),
        row && row.innerHTML);
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

/* ---------- Tapping a result must actually set it ---------- */
// The quick answer arrives at once; the fuller one a beat later. That gap is the whole
// problem: if the list is replaced while a finger is on it, iOS never delivers the tap.
const photonThinNominatimSlow = (url) => {
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
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true, status: 200, json: async () => ([{
      lat: '-37.89', lon: '145.05', name: '92',
      address: { house_number: '92', road: 'Mimosa Road', suburb: 'Carnegie',
                 city: 'Melbourne', state: 'Victoria', postcode: '3163', country: 'Australia' },
    }]),
  }), 700));
};

async function openAndType(api, text, waitMs) {
  const d = api.document;
  d.getElementById('destRow').click();
  await sleep(20);
  d.getElementById('inSearch').value = text;
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(waitMs);
  return d;
}

async function testTappingAnAddressResultSelectsIt() {
  const api = boot({ fetch: photonThinNominatimRich });
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const d = await openAndType(api, '92 mimosa road', 480);

  const row = d.querySelector('#results li[data-i]');
  check('the address is listed', !!row, d.getElementById('results').textContent);
  row.click();
  await sleep(30);

  const dest = api.window.Convoy.state.dest;
  check('tapping it sets the destination', !!dest, JSON.stringify(dest));
  check('with the place in it', !!dest && /Mimosa/.test(dest.label), dest && dest.label);
  check('and real numbers for coordinates, not text',
        !!dest && typeof dest.lat === 'number' && typeof dest.lng === 'number',
        dest && (typeof dest.lat + '/' + typeof dest.lng));
  check('and the sheet gets out of the way',
        d.getElementById('search').classList.contains('hidden'));
}

async function testTheRowSurvivesTheFullerAnswerArriving() {
  const api = boot({ fetch: photonThinNominatimSlow });
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const d = await openAndType(api, '92 mimosa road', 500);

  const row = d.querySelector('#results li[data-i]');
  check('the quick answer is on screen', !!row && /Mimosa/.test(row.textContent),
        row && row.textContent);

  await sleep(900);                      // the fuller answer lands in the meantime
  const after = d.querySelector('#results li[data-i]');
  check('the row is the same element, not a replacement', after === row,
        after === row ? 'same' : 'replaced');
  check('and it now shows the fuller address', /3163/.test(after.textContent),
        after.textContent);

  after.click();
  await sleep(30);
  const dest = api.window.Convoy.state.dest;
  check('so the tap still lands and sets the destination', !!dest, JSON.stringify(dest));
  check('with the fuller address', !!dest && /3163/.test(dest.label), dest && dest.label);
}

async function testSelectingWorksWithAQuietPhoneInTheRoom() {
  // A phone brought back from the room's roster has no coordinates yet. It used to be
  // handed to Leaflet as (null, null), which throws — after the destination was set and
  // drawn but before the sheet was told to close. So the sheet stuck open over a
  // destination that had visibly changed, and the screen looked frozen.
  const api = boot({ fetch: photonCarnegie });
  api.window.localStorage.setItem('convoy.room.goa-trip', JSON.stringify({
    code: 'goa-trip', startedAt: Date.now(), expiresAt: Date.now() + 86400000,
    updatedAt: Date.now(),
    members: { ghost: { name: 'Ravi', lastSeen: Date.now() - 600000 } },
  }));
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  const d = api.document;
  check('the quiet phone is on the list',
        !!d.querySelector('#people li[data-id="ghost"]'));

  d.getElementById('destRow').click();
  await sleep(20);
  d.getElementById('inSearch').value = 'mimosa road';
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(480);

  const row = d.querySelector('#results li[data-i]');
  check('a result is listed', !!row, d.getElementById('results').textContent);
  row.click();
  await sleep(30);

  check('the destination is set', !!api.window.Convoy.state.dest,
        JSON.stringify(api.window.Convoy.state.dest));
  check('and the sheet still closes, rather than stranding the screen',
        d.getElementById('search').classList.contains('hidden'));
}

async function testAQuietPhoneIsNeverHandedToTheMap() {
  // The root of it: a phone with no coordinates yet must never reach Leaflet, because a
  // null in a bounds calculation throws.
  const api = boot({ fetch: photonCarnegie });
  api.window.localStorage.setItem('convoy.room.goa-trip', JSON.stringify({
    code: 'goa-trip', startedAt: Date.now(), expiresAt: Date.now() + 86400000,
    updatedAt: Date.now(), members: { ghost: { name: 'Ravi', lastSeen: Date.now() } },
  }));
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  const I = api.window.Convoy._internals;
  const people = I.allPeople();
  check('a phone with no position is kept out of the map\'s list',
        people.every((p) => p.lat != null && p.lng != null),
        JSON.stringify(people.map((p) => [p.name, p.lat, p.lng])));
  check('and it is still on the list you can see',
        /Ravi/.test(api.document.getElementById('people').textContent),
        api.document.getElementById('people').textContent);

  let threw = null;
  try { I.fitAll(); } catch (e) { threw = e.message; }
  check('so fitting the view cannot throw on a null position', threw === null, String(threw));
}

async function testTheBackdropGetsYouOut() {
  const api = boot({ fetch: photonCarnegie });
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const d = api.document;

  d.getElementById('destRow').click();
  await sleep(20);
  check('the sheet is open', !d.getElementById('search').classList.contains('hidden'));

  // A tap on the dimmed area, not on the card.
  d.getElementById('search').click();
  await sleep(20);
  check('tapping outside the sheet closes it, whatever else is going on',
        d.getElementById('search').classList.contains('hidden'));
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

/* ---------- The back button, which only Android has ---------- */
async function testTheBackButtonClosesTheSheet() {
  const api = boot({ fetch: driveOk });
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  d.getElementById('destRow').click();
  await sleep(20);
  check('the sheet is open', !d.getElementById('search').classList.contains('hidden'));

  api.window.dispatchEvent(new api.window.Event('popstate'));     // the back button
  await sleep(20);
  check('the back button closes the sheet rather than leaving the app',
        d.getElementById('search').classList.contains('hidden'));

  d.getElementById('destRow').click();
  await sleep(20);
  check('and it can be opened again', !d.getElementById('search').classList.contains('hidden'));
  d.getElementById('btnSearchClose').click();
  await sleep(20);
  check('closing it by hand works too', d.getElementById('search').classList.contains('hidden'));
  check('and a stray back event after that does nothing',
        (api.window.dispatchEvent(new api.window.Event('popstate')), true));
}

/* ---------- Recently searched places ---------- */
// Every query returns a place named after the query, so each one is distinguishable.
const placeNamedAfterTheQuery = (url) => {
  if (url.indexOf('photon.komoot.io') >= 0) {
    const q = decodeURIComponent((url.split('q=')[1] || '').split('&')[0] || '');
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      features: [{
        geometry: { coordinates: [145.0, -37.8] },
        properties: {
          name: q, street: q, housenumber: '1', locality: 'Carnegie',
          state: 'Victoria', postcode: '3163', country: 'Australia',
        },
      }],
    }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
};

// Open the sheet, type, and take the first result.
async function pick(api, text) {
  const d = api.document;
  d.getElementById('destRow').click();
  await sleep(20);
  d.getElementById('inSearch').value = text;
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(480);
  const row = d.querySelector('#results li[data-i]');
  if (row) row.click();
  await sleep(30);
}

async function testRecentPlaces() {
  const api = boot({ fetch: placeNamedAfterTheQuery });
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  const recent = () => api.window.ConvoyRoute._internals.loadRecent();

  d.getElementById('destRow').click();
  await sleep(20);
  check('with no history the sheet just says what to do',
        /letters/.test(d.getElementById('results').textContent),
        d.getElementById('results').textContent);

  await pick(api, 'alpha street');
  check('choosing a place remembers it', recent().length === 1, JSON.stringify(recent()));
  check('with its name', /alpha/i.test(recent()[0].label), JSON.stringify(recent()));

  await pick(api, 'bravo street');
  await pick(api, 'charlie street');
  check('and keeps the newest first',
        /charlie/i.test(recent()[0].label) && /bravo/i.test(recent()[1].label),
        JSON.stringify(recent().map((r) => r.label)));

  d.getElementById('destRow').click();
  await sleep(20);
  const opened = d.getElementById('results').textContent;
  check('the sheet opens on the recent places', /Recent/.test(opened), opened);
  check('listing them', /charlie/i.test(opened) && /alpha/i.test(opened), opened);

  const rows = d.querySelectorAll('#results li[data-recent]');
  check('each one can be tapped', rows.length === 3, String(rows.length));
  rows[2].click();                                   // the oldest: alpha
  await sleep(30);
  check('tapping one sets the destination',
        !!api.window.Convoy.state.dest && /alpha/i.test(api.window.Convoy.state.dest.label),
        JSON.stringify(api.window.Convoy.state.dest));
  check('and closes the sheet', d.getElementById('search').classList.contains('hidden'));
  check('and moves it to the top of the history',
        /alpha/i.test(recent()[0].label), JSON.stringify(recent().map((r) => r.label)));
  check('without listing it twice', recent().length === 3, String(recent().length));

  for (const t of ['delta', 'echo', 'foxtrot', 'golf']) await pick(api, t + ' street');
  check('only the last five are kept', recent().length === 5, String(recent().length));
  // alpha was re-picked above, so it moved up the list; bravo and charlie are the ones
  // that have aged out.
  check('and the oldest have fallen off',
        !/bravo/i.test(JSON.stringify(recent())) && !/charlie/i.test(JSON.stringify(recent())),
        JSON.stringify(recent().map((r) => r.label)));

  // Typing looks somewhere new; clearing the box brings the history back.
  d.getElementById('destRow').click();
  await sleep(20);
  d.getElementById('inSearch').value = 'xylophone street';
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(480);
  check('typing replaces the history with results',
        !/Recent/.test(d.getElementById('results').textContent),
        d.getElementById('results').textContent);
  d.getElementById('inSearch').value = '';
  d.getElementById('inSearch').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  await sleep(20);
  check('clearing the box brings the history back',
        /Recent/.test(d.getElementById('results').textContent),
        d.getElementById('results').textContent);

  check('the history lives on the phone, not on a server',
        !!api.window.localStorage.getItem('convoy.recent'), 'missing');
  check('and is never sent to the room',
        !/recent/i.test((api.clients[0].published || []).join(' ')),
        (api.clients[0].published || []).join(' ').slice(0, 160));
}

async function testHistoryIsPerPhone() {
  const mine = boot({ fetch: placeNamedAfterTheQuery });
  mine.join('Akshay', 'goa-trip');
  await sleep(20);
  await pick(mine, 'alpha street');
  check('this phone has a history',
        mine.window.ConvoyRoute._internals.loadRecent().length === 1);

  const theirs = boot({ fetch: placeNamedAfterTheQuery });
  check('another phone starts with none of it',
        theirs.window.ConvoyRoute._internals.loadRecent().length === 0,
        JSON.stringify(theirs.window.ConvoyRoute._internals.loadRecent()));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testSearch();
    await testAPlaceNameIsShownWithItsAddress();
    await testAStreetAddressIsNotRepeated();
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
    await testTappingAnAddressResultSelectsIt();
    await testTheRowSurvivesTheFullerAnswerArriving();
    await testAQuietPhoneIsNeverHandedToTheMap();
    await testSelectingWorksWithAQuietPhoneInTheRoom();
    await testTheBackdropGetsYouOut();
    await testAPlaceIsNotLookedUpTwice();
    await testPlaceStillGoesToPhotonFirst();
    await testAddressServiceIsNotHammered();
    await testRepeatsAreCached();
    await testSearchBiasedToYou();
    await testDrive();
    await testSearchSheet();
    await testTheBackButtonClosesTheSheet();
    await testRecentPlaces();
    await testHistoryIsPerPhone();
  } catch (e) { crash(e); }
  finish('route');
})();
