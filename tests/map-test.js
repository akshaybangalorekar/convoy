/* Launching again, unique colours, and the view that keeps everyone in frame. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

/* ---------- Launching ---------- */
async function testRejoinOnLaunch() {
  const api = boot({ setup: (w) => {
    w.localStorage.setItem('convoy.name', 'Akshay');
    w.localStorage.setItem('convoy.room', 'goa-trip');
  } });
  await sleep(40);
  const d = api.document;

  check('a returning phone rejoins by itself',
        api.window.Convoy.state.room === 'convoy', api.window.Convoy.state.room);
  check('there is no join screen at all', !d.getElementById('join'));
  check('you land on the map', !d.getElementById('sheet').classList.contains('hidden'));
  check('and the name it kept is used', api.window.Convoy.state.me.name === 'Akshay',
        api.window.Convoy.state.me.name);
  check('a connection is opened', api.clients.length === 1, String(api.clients.length));
  const c = api.clients[0];
  if (c) c.connect_();
  await sleep(20);
  check('and it subscribes to the one room',
        c && c.subscribed === 'sarvam-convoy/v1/convoy/bus', c && c.subscribed);
}

async function testFirstRunAsks() {
  const api = boot();
  await sleep(30);
  const d = api.document;
  check('a first-time phone goes straight onto the map',
        api.window.Convoy.state.joined === true &&
        !d.getElementById('sheet').classList.contains('hidden'));
  check('already in the one room', api.window.Convoy.state.joined === true);
  check('with a name it did not have to type',
        !!api.window.Convoy.state.me.name, api.window.Convoy.state.me.name);
  check('and a connection already open', api.clients.length === 1, String(api.clients.length));
}

/* ---------- Colours ---------- */
async function testUniqueColors() {
  const api = boot();
  api.join('Akshay', 'colour-room');
  api.fix(15.5, 73.8);
  await sleep(20);
  for (let i = 1; i <= 6; i++) api.recv(pos('p' + i, 'P' + i, 15.5 + i * 0.01, 73.8));
  await sleep(40);

  const me = api.window.Convoy.state.me;
  const people = [me].concat(Array.from(api.window.Convoy.state.peers.values()));
  const colours = people.map((p) => p.color);

  check('seven cars are on the map', people.length === 7, String(people.length));
  check('every car has a colour', colours.every(Boolean), JSON.stringify(colours));
  check('no two share a colour', new Set(colours).size === colours.length, JSON.stringify(colours));
  check('your own car takes the first colour',
        me.color === api.window.Convoy._internals.PALETTE[0], me.color);

  api.recv({ t: 'bye', id: 'p1', name: 'P1' });
  await sleep(20);
  const after = [me].concat(Array.from(api.window.Convoy.state.peers.values())).map((p) => p.color);
  check('colours stay unique after someone leaves',
        new Set(after).size === after.length, JSON.stringify(after));
}

async function testColorsAgreeAcrossPhones() {
  const run = async (reverse) => {
    const api = boot();
    api.join('Akshay', 'same-room');
    api.fix(15.5, 73.8);
    await sleep(20);
    const ids = ['p1', 'p2', 'p3'];
    (reverse ? ids.slice().reverse() : ids)
      .forEach((id, i) => api.recv(pos(id, id, 15.5 + i * 0.01, 73.8)));
    await sleep(30);
    const out = {};
    api.window.Convoy.state.peers.forEach((p) => { out[p.id] = p.color; });
    return out;
  };
  const norm = (o) => Object.keys(o).sort().map((k) => k + '=' + o[k]).join(' | ');
  const a = await run(false);
  const b = await run(true);
  check('every phone gives a car the same colour', norm(a) === norm(b),
        norm(a) + '  vs  ' + norm(b));
}

/* ---------- The view ---------- */
async function testAutoFit() {
  const api = boot();
  api.join('Akshay', 'fit-room');
  api.fix(15.500, 73.800);
  await sleep(20);
  api.recv(pos('p1', 'Priya', 15.520, 73.820));
  api.recv(pos('p2', 'Rahul', 15.540, 73.840));
  await sleep(30);

  check('the view keeps everyone in frame by default', api.window.Convoy.state.autoFit === true);
  check('and it fitted them as they arrived', api.calls.fitBounds.length >= 1,
        String(api.calls.fitBounds.length));

  api.calls.fitBounds.length = 0;
  api.window.Convoy._internals.fitAll();
  await sleep(10);
  check('fitting everyone in one go does it in one call', api.calls.fitBounds.length === 1,
        String(api.calls.fitBounds.length));
  const o = api.calls.fitBounds[0] || {};
  check('capped, so a bunched-up group zooms in rather than staying wide', o.maxZoom === 18,
        JSON.stringify(o));
  check('with a margin round the edges', Array.isArray(o.padding), JSON.stringify(o));
}

async function testTakingControl() {
  const api = boot();
  api.join('Akshay', 'fit-room');
  api.fix(15.5, 73.8);
  await sleep(20);
  api.recv(pos('p1', 'Priya', 15.52, 73.82));
  await sleep(760);                       // past the guard against our own moves

  check('auto-fit is still on', api.window.Convoy.state.autoFit === true);
  api.mapFire('dragstart');
  check('dragging hands the view back to you', api.window.Convoy.state.autoFit === false);

  api.calls.fitBounds.length = 0;
  api.window.Convoy._internals.maybeAutoView();
  check('and then the map is left alone', api.calls.fitBounds.length === 0,
        String(api.calls.fitBounds.length));

  // The All button is the way back: it frames everyone and starts following again.
  api.document.getElementById('btnCentre').click();
  await sleep(10);
  check('the All button frames everyone again', api.calls.fitBounds.length === 1,
        String(api.calls.fitBounds.length));
  check('and the view follows again', api.window.Convoy.state.autoFit === true);
}

/* ---------- One tap out, two taps in ---------- */
async function testTapZoom() {
  const api = boot();
  const d = api.document;
  const c = api.container;
  const fire = (type, x, y, target) => {
    (target || c).dispatchEvent(new api.window.MouseEvent(type,
      { clientX: x, clientY: y, bubbles: true }));
  };
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  api.calls.zoomOut = 0;
  api.calls.zoomIn = 0;
  fire('pointerdown', 100, 100);
  fire('pointerup', 100, 100);
  await sleep(40);
  check('one tap does not zoom straight away — it waits to see if a second is coming',
        api.calls.zoomOut === 0 && api.calls.zoomIn === 0,
        api.calls.zoomOut + '/' + api.calls.zoomIn);
  await sleep(320);
  check('one tap then zooms out', api.calls.zoomOut === 1, String(api.calls.zoomOut));
  check('and does not zoom in', api.calls.zoomIn === 0, String(api.calls.zoomIn));

  api.calls.zoomOut = 0;
  api.calls.zoomIn = 0;
  fire('pointerdown', 100, 100);
  fire('pointerup', 100, 100);
  await sleep(60);
  fire('pointerdown', 100, 100);
  fire('pointerup', 100, 100);
  await sleep(40);
  check('two taps zoom in', api.calls.zoomIn === 1, String(api.calls.zoomIn));
  await sleep(320);
  check('and the first tap is cancelled, so it does not also zoom out',
        api.calls.zoomOut === 0, String(api.calls.zoomOut));

  // A finger that moves was panning, not tapping.
  api.calls.zoomOut = 0;
  fire('pointerdown', 100, 100);
  fire('pointermove', 220, 100);
  fire('pointerup', 220, 100);
  await sleep(320);
  check('panning the map does not zoom it', api.calls.zoomOut === 0, String(api.calls.zoomOut));

  // A tap that lands on a car belongs to the car.
  const car = d.createElement('div');
  car.className = 'mk';
  c.appendChild(car);
  api.calls.zoomOut = 0;
  fire('pointerdown', 100, 100, car);
  fire('pointerup', 100, 100, car);
  await sleep(320);
  check('tapping a car does not zoom the map', api.calls.zoomOut === 0,
        String(api.calls.zoomOut));
}

/* ---------- The sheet ---------- */
async function testSheetCollapses() {
  const api = boot();
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  api.fix(15.5, 73.8);
  await sleep(20);
  check('the sheet starts open', !d.body.classList.contains('sheet-collapsed'));
  d.getElementById('sheetHead').click();
  check('tapping the header folds it away', d.body.classList.contains('sheet-collapsed'));
  d.getElementById('sheetHead').click();
  check('and tapping again brings it back', !d.body.classList.contains('sheet-collapsed'));
}

/* ---------- Run ---------- */
/* ---------- The tiles ---------- */
async function testTheTilesAreKeyless() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const layer = api.tileLayers[0];
  check('the map uses the standard tiles, which need no key',
        /tile\.openstreetmap\.org/.test(layer.url), layer.url);
  check('and asks for no key of any kind', !/apikey|api_key|access_token/i.test(layer.url));
  check('one layer, not a second service that could demand a key',
        api.tileLayers.length === 1, String(api.tileLayers.length));
}

/* ---------- Day and night ---------- */
async function testTheSunIsWhereItShouldBe() {
  const api = boot();
  const I = api.window.Convoy._internals;
  const at = (y, mo, d, h, la, ln) => I.sunElevation(Date.UTC(y, mo, d, h), la, ln);

  const noon = at(2026, 0, 15, 2, -33.87, 151.21);        // 1pm in Sydney, midsummer
  check('the sun is high over Sydney at one in the afternoon', noon > 70 && noon < 85,
        noon.toFixed(1));
  const night = at(2026, 0, 15, 14, -33.87, 151.21);      // 1am
  check('and well below the horizon at one in the morning', night < -30, night.toFixed(1));
  const winter = at(2026, 0, 15, 12, 51.5, -0.12);        // noon in London in January
  check('a winter noon in London is low but up', winter > 10 && winter < 25, winter.toFixed(1));
}

async function testTheMapGoesDarkAfterSunset() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const map = api.document.getElementById('map');
  const realNow = api.window.Date.now;

  api.window.Date.now = () => Date.UTC(2026, 0, 15, 2, 0, 0);      // 1pm Sydney
  api.fix(-33.87, 151.21);
  await sleep(20);
  check('by day the map is not darkened', !map.classList.contains('night-tiles'));

  api.window.Date.now = () => Date.UTC(2026, 0, 15, 14, 0, 0);     // 1am Sydney
  api.fix(-33.8701, 151.2101);
  await sleep(20);
  check('after sunset it is', map.classList.contains('night-tiles'));

  api.window.Date.now = realNow;
  api.fix(-33.8702, 151.2102);
  await sleep(20);
  check('and it follows the sun, not a switch',
        map.classList.contains('night-tiles') ===
        (api.window.Convoy._internals.sunElevation(Date.now(), -33.8702, 151.2102) < -0.833));
}

/* ---------- Heading up, and the direction badge ---------- */
async function testTheBadgeSaysWhichWayYouAreGoing() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  const d = api.document;
  await sleep(20);
  check('with no heading there is no badge',
        d.getElementById('btnHeading').classList.contains('hidden'));

  api.fix(-33.86, 151.2, { heading: 45 });
  await sleep(20);
  check('a heading shows the badge', !d.getElementById('btnHeading').classList.contains('hidden'));
  check('and it reads NE', d.getElementById('headingText').textContent === 'NE',
        d.getElementById('headingText').textContent);

  api.fix(-33.861, 151.2, { heading: 90 });
  await sleep(20);
  check('turning east changes it to E', d.getElementById('headingText').textContent === 'E',
        d.getElementById('headingText').textContent);

  api.fix(-33.862, 151.2, { heading: 225 });
  await sleep(20);
  check('and south-west reads SW', d.getElementById('headingText').textContent === 'SW',
        d.getElementById('headingText').textContent);

  api.fix(-33.863, 151.2, { heading: 200 });
  await sleep(20);
  check('while 200 degrees is nearer south', d.getElementById('headingText').textContent === 'S',
        d.getElementById('headingText').textContent);
}

async function testTheMapTurnsSoYourHeadingIsUp() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  api.fix(-33.86, 151.2, { heading: 90 });
  await sleep(20);

  const map = api.window.Convoy.map();
  check('the map is turned against the heading, so your direction is up',
        map.getBearing() === -90, String(map.getBearing()));

  api.document.getElementById('btnHeading').click();
  await sleep(20);
  check('tapping the badge turns it off', api.window.Convoy.state.headingUp === false);
  check('and puts the map back north-up', map.getBearing() === 0, String(map.getBearing()));
  check('the badge shows it is off',
        !api.document.getElementById('btnHeading').classList.contains('up'));

  api.document.getElementById('btnHeading').click();
  await sleep(20);
  check('and tapping again turns it back on', map.getBearing() === -90, String(map.getBearing()));
}

async function testTheMapIsLeftAloneOnceYouTakeIt() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  api.fix(-33.86, 151.2, { heading: 90 });
  await sleep(20);
  api.mapFire('dragstart');
  api.fix(-33.861, 151.2, { heading: 90 });
  await sleep(20);
  check('once you have moved the map yourself it is not turned under you',
        api.window.Convoy.map().getBearing() === 0,
        String(api.window.Convoy.map().getBearing()));
}

async function testAMissingPluginIsJustANorthUpMap() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const map = api.window.Convoy.map();
  map.setBearing = undefined;          // as if the plugin never loaded
  api.fix(-33.86, 151.2, { heading: 90 });
  await sleep(20);
  check('a map without the plugin still shows the badge',
        api.document.getElementById('headingText').textContent === 'NE' ||
        api.document.getElementById('headingText').textContent === 'E',
        api.document.getElementById('headingText').textContent);
  check('and nothing is broken', api.window.Convoy.state.joined === true);
}

/* ---------- Centring on yourself ---------- */
async function testTheAllButtonShowsEveryCar() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -37.95, 145.10));      // about 6 km away
  await sleep(760);
  api.mapFire('dragstart');                          // you took the map yourself
  check('the view stops chasing once you take it', api.window.Convoy.state.autoFit === false);

  api.calls.fitBounds.length = 0;
  api.document.getElementById('btnCentre').click();
  await sleep(20);
  check('the All button frames everyone in one go', api.calls.fitBounds.length === 1,
        String(api.calls.fitBounds.length));
  check('and starts following again', api.window.Convoy.state.autoFit === true);
}

async function testCentreOnMeWithNoPositionJustAsksForOne() {
  const api = boot();
  await sleep(20);
  const before = api.calls.setView.length;
  api.document.getElementById('btnCentre').click();
  await sleep(20);
  check('with no fix yet it asks for one instead of jumping to nowhere',
        api.calls.setView.length === before, String(api.calls.setView.length));
  check('and the location watch is running', api.geo.started > 0, String(api.geo.started));
}

/* ---------- Names on the map ---------- */
// Every name at once collides into one unreadable stack when cars are close, so the map
// names your own car, the nearest one, and whichever car you have tapped.
function iconHtml(api, id) {
  const p = id === 'me' ? api.window.Convoy.state.me : api.window.Convoy.state.peers.get(id);
  if (!p || !p._marker || !p._marker._icons) return '';
  const icons = p._marker._icons;
  return icons.length ? String(icons[icons.length - 1].html) : '';
}
const named = (api, id) => /class="lbl"/.test(iconHtml(api, id));

async function testOnlySomeCarsCarryAName() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -37.9005, 145.05));    // ~55 m: the nearest
  api.recv(pos('p2', 'Rahul', -37.95, 145.10));
  api.recv(pos('p3', 'Meera', -37.96, 145.11));
  await sleep(40);

  check('your own car is always named', named(api, 'me'), iconHtml(api, 'me'));
  check('so is the nearest car', named(api, 'p1'), iconHtml(api, 'p1'));
  check('but not the ones further off, where the names would collide',
        !named(api, 'p2') && !named(api, 'p3'),
        iconHtml(api, 'p2') + ' || ' + iconHtml(api, 'p3'));
  check('every car is still drawn, as a car',
        ['me', 'p1', 'p2', 'p3'].every((id) => /class="car"/.test(iconHtml(api, id))),
        iconHtml(api, 'p2'));
  check('in its own colour, never grey',
        ['me', 'p1', 'p2', 'p3'].every((id) => !/grey|gray|#808080/i.test(iconHtml(api, id))));
  check('and turned to face the way it is going',
        /rotate\(90 12 12\)/.test(iconHtml(api, 'p1')), iconHtml(api, 'p1'));
}

async function testTappingACarNamesIt() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -37.9005, 145.05));
  api.recv(pos('p2', 'Rahul', -37.95, 145.10));
  await sleep(40);
  check('the far car starts unnamed', !named(api, 'p2'), iconHtml(api, 'p2'));

  const far = api.window.Convoy.state.peers.get('p2');
  far._marker.fire('click');
  await sleep(30);
  check('tapping it names it', named(api, 'p2'), iconHtml(api, 'p2'));
  check('and the map goes to it', api.window.Convoy.state.autoFit === false);
}

(async () => {
  try {
    await testRejoinOnLaunch();
    await testFirstRunAsks();
    await testUniqueColors();
    await testColorsAgreeAcrossPhones();
    await testAutoFit();
    await testTakingControl();
    await testTapZoom();
    await testSheetCollapses();
    await testTheTilesAreKeyless();
    await testTheSunIsWhereItShouldBe();
    await testTheMapGoesDarkAfterSunset();
    await testTheBadgeSaysWhichWayYouAreGoing();
    await testTheMapTurnsSoYourHeadingIsUp();
    await testTheMapIsLeftAloneOnceYouTakeIt();
    await testAMissingPluginIsJustANorthUpMap();
    await testTheAllButtonShowsEveryCar();
    await testCentreOnMeWithNoPositionJustAsksForOne();
    await testOnlySomeCarsCarryAName();
    await testTappingACarNamesIt();
  } catch (e) { crash(e); }
  finish('map');
})();
