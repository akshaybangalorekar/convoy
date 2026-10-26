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

  // The Location button is the way back: it puts the map on you and keeps everyone in
  // frame, without turning the chasing back on.
  api.document.getElementById('btnCentre').click();
  await sleep(10);
  check('the Location button puts the map back on you',
        api.calls.setView.length > 0, String(api.calls.setView.length));
  check('without switching the chasing back on',
        api.window.Convoy.state.autoFit === false);
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
/* ---------- Centring on yourself ---------- */
async function testCentreOnMeKeepsEveryoneInFrame() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -37.95, 145.10));      // about 6 km away
  await sleep(20);

  const before = api.calls.setView.length;
  api.document.getElementById('btnCentre').click();
  await sleep(20);

  const last = api.calls.setView[api.calls.setView.length - 1];
  check('the map is put on your own car', api.calls.setView.length > before &&
        last && last[0][0] === -37.90 && last[0][1] === 145.05,
        JSON.stringify(last && last[0]));
  check('at a zoom that still holds the others', typeof last[1] === 'number' &&
        last[1] > 8 && last[1] <= 18, String(last && last[1]));
  check('and it stops chasing everyone afterwards',
        api.window.Convoy.state.autoFit === false);
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
    await testCentreOnMeKeepsEveryoneInFrame();
    await testCentreOnMeWithNoPositionJustAsksForOne();
    await testOnlySomeCarsCarryAName();
    await testTappingACarNamesIt();
  } catch (e) { crash(e); }
  finish('map');
})();
