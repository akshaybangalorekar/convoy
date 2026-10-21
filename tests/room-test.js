/* The room's own life: it stays open, nobody is dropped from it, and it lasts a week. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

const DAY = 86400000;
const record = (api, code) =>
  JSON.parse(api.window.localStorage.getItem('convoy.room.' + code) || 'null');
const list = (api) => api.document.getElementById('people').textContent;
const titles = (api) => api.notes.map((n) => n.title).join(' | ');
const titlesSince = (api, n) => api.notes.slice(n).map((x) => x.title).join(' | ');
const write = (api, code, patch) => {
  const r = record(api, code);
  Object.assign(r, patch);
  api.window.localStorage.setItem('convoy.room.' + code, JSON.stringify(r));
  return r;
};

/* ---------- A room is written down, and lasts a week ---------- */
async function testRoomLastsAWeek() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  const r = record(api, 'goa-trip');
  check('the room is written down on the phone', !!r, String(r));
  check('with a life of a week',
        r && Math.abs((r.expiresAt - Date.now()) - 7 * DAY) < 60000,
        String(r && (r.expiresAt - Date.now()) / DAY));
  check('and the day it opened', r && typeof r.startedAt === 'number');
  check('you are on its roster',
        r && r.members && Object.keys(r.members).length === 1,
        JSON.stringify(r && Object.keys(r.members)));
  check('the sheet says how long it is open',
        /another week/.test(api.document.getElementById('roomNote').textContent),
        api.document.getElementById('roomNote').textContent);
}

async function testUsingItKeepsItOpen() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);

  write(api, 'goa-trip', { expiresAt: Date.now() + DAY });   // six days went by
  api.window.Convoy.setDest(-33.9, 151.3, 'Bondi');
  await sleep(20);

  const after = record(api, 'goa-trip');
  check('using the room pushes its life back out',
        after && Math.abs((after.expiresAt - Date.now()) - 7 * DAY) < 60000,
        String(after && (after.expiresAt - Date.now()) / DAY));
}

async function testNoteWording() {
  const api = boot();
  const t = api.window.Convoy._internals.roomNoteText;
  check('a fresh room is open for another week',
        t(7 * DAY) === 'Room open for another week', t(7 * DAY));
  check('two days left', t(2 * DAY) === 'Room closes in 2 days', t(2 * DAY));
  check('one day left', t(DAY) === 'Room closes in 1 day', t(DAY));
  check('hours left', t(5 * 3600000) === 'Room closes in 5 hours', t(5 * 3600000));
  check('a lapsed room says nothing', t(0) === '' && t(-1000) === '', t(0));
}

async function testLapsedRoomStartsFresh() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(30);
  check('someone is in the room', api.window.Convoy.state.peers.size === 1);

  write(api, 'goa-trip', { expiresAt: Date.now() - 1000 });   // a week with nobody using it
  api.window.Convoy.leave();
  await sleep(20);
  api.join('Akshay', 'goa-trip');
  await sleep(30);

  check('a lapsed room starts fresh', api.window.Convoy.state.peers.size === 0,
        String(api.window.Convoy.state.peers.size));
  const after = record(api, 'goa-trip');
  check('and the record is started over', after && after.expiresAt > Date.now(),
        JSON.stringify(after && after.expiresAt));
}

/* ---------- Nobody is dropped ---------- */
async function testNobodyIsDropped() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);

  // a position from an hour ago — long past the old thirty-minute drop
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 10, hdg: 90, acc: 6, ts: Date.now() - 3600000 });
  await sleep(20);
  check('a phone quiet for an hour is still in the room',
        api.window.Convoy.state.peers.has('p1'));

  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('and still on the list, marked out of contact',
        /Priya/.test(list(api)) && /out of contact/.test(list(api)), list(api));
  check('but not announced as having left', !/left/.test(titles(api)), titles(api));
}

async function testClosingIsNotLeaving() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(30);

  const before = api.notes.length;
  api.window.dispatchEvent(new api.window.Event('pagehide'));
  await sleep(20);
  check('closing the app says we are away, not gone', !!api.sent('away'));
  check('and it is not a goodbye', !api.sent('bye'), JSON.stringify(api.sent('bye')));
  check('nobody is announced as leaving', api.notes.length === before, titles(api));

  const r = record(api, 'goa-trip');
  check('and nobody comes off the roster',
        r && Object.keys(r.members).length === 2, JSON.stringify(r && Object.keys(r.members)));
}

async function testLeavingDoesRemoveYou() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(30);
  check('the roster has both of you',
        Object.keys(record(api, 'goa-trip').members).length === 2);

  api.recv({ t: 'bye', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('pressing Leave is announced', /Priya left/.test(titles(api)), titles(api));
  const r = record(api, 'goa-trip');
  check('and takes them off the roster',
        r && !r.members.p1, JSON.stringify(r && Object.keys(r.members)));
}

/* ---------- The group comes back with the room ---------- */
async function testRosterComesBack() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  api.recv(pos('p2', 'Rahul', -33.88, 151.22));
  await sleep(30);
  check('three people are in the room', api.window.Convoy.state.peers.size === 2,
        String(api.window.Convoy.state.peers.size));
  check('all three are on the roster',
        Object.keys(record(api, 'goa-trip').members).length === 3,
        JSON.stringify(Object.keys(record(api, 'goa-trip').members)));

  // close the app and open it again
  const baseline = api.notes.length;
  api.window.Convoy.leave();
  await sleep(20);
  api.join('Akshay', 'goa-trip');
  await sleep(30);

  check('the group comes back with the room', api.window.Convoy.state.peers.size === 2,
        String(api.window.Convoy.state.peers.size));
  check('with their names', /Priya/.test(list(api)) && /Rahul/.test(list(api)), list(api));
  check('marked out of contact, since nothing has been heard from them',
        /out of contact/.test(list(api)), list(api));

  const p1 = api.window.Convoy.state.peers.get('p1');
  check('a restored person has no position until they send one', p1 && p1.lat === null,
        JSON.stringify(p1 && p1.lat));

  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('reopening the app does not fire an alert for everyone',
        api.notes.length === baseline, titlesSince(api, baseline));

  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('when someone reappears you are told they are back',
        /is back/.test(titles(api)), titles(api));
  check('and they are not announced as joining again',
        !/Priya joined/.test(titlesSince(api, baseline)), titlesSince(api, baseline));
}

async function testOneIdentityPerDevice() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  const first = api.window.Convoy.state.me.id;
  api.window.Convoy.leave();
  await sleep(20);
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  check('reopening keeps the same identity', api.window.Convoy.state.me.id === first,
        first + ' vs ' + api.window.Convoy.state.me.id);
  check('so you do not appear twice on the roster',
        Object.keys(record(api, 'goa-trip').members).length === 1,
        JSON.stringify(Object.keys(record(api, 'goa-trip').members)));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testRoomLastsAWeek();
    await testUsingItKeepsItOpen();
    await testNoteWording();
    await testLapsedRoomStartsFresh();
    await testNobodyIsDropped();
    await testClosingIsNotLeaving();
    await testLeavingDoesRemoveYou();
    await testRosterComesBack();
    await testOneIdentityPerDevice();
  } catch (e) { crash(e); }
  finish('room');
})();
