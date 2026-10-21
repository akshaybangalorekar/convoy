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
        api.window.Convoy.state.room === 'goa-trip', api.window.Convoy.state.room);
  check('the join card stays out of the way', d.getElementById('join').classList.contains('hidden'));
  check('you land on the map', !d.getElementById('sheet').classList.contains('hidden'));
  check('the room code is shown', d.getElementById('roomChip').textContent === 'goa-trip',
        d.getElementById('roomChip').textContent);
  check('a connection is opened', api.clients.length === 1, String(api.clients.length));
  const c = api.clients[0];
  if (c) c.connect_();
  await sleep(20);
  check('and it subscribes to the room',
        c && c.subscribed === 'sarvam-convoy/v1/goa-trip/bus', c && c.subscribed);
}

async function testFirstRunAsks() {
  const api = boot();
  await sleep(30);
  const d = api.document;
  check('a first-time phone sees the join card', !d.getElementById('join').classList.contains('hidden'));
  check('and is not in a room', api.window.Convoy.state.joined === false);
  check('and opens no connection', api.clients.length === 0, String(api.clients.length));
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
  api.document.getElementById('btnRecenter').click();
  await sleep(10);
  check('recentring fits everyone in', api.calls.fitBounds.length === 1,
        String(api.calls.fitBounds.length));
  const o = api.calls.fitBounds[0] || {};
  check('capped, so a bunched-up group zooms in rather than staying wide', o.maxZoom === 16,
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

  api.document.getElementById('btnRecenter').click();
  await sleep(10);
  check('the recenter button takes it back', api.window.Convoy.state.autoFit === true);
  check('and refits at once', api.calls.fitBounds.length === 1, String(api.calls.fitBounds.length));
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
(async () => {
  try {
    await testRejoinOnLaunch();
    await testFirstRunAsks();
    await testUniqueColors();
    await testColorsAgreeAcrossPhones();
    await testAutoFit();
    await testTakingControl();
    await testSheetCollapses();
  } catch (e) { crash(e); }
  finish('map');
})();
