/* Presence: telling the group when someone's app goes away or goes quiet, and pushing
 * each phone's own state back onto the air so nothing has to be stored centrally. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

const routeFetch = (url) => {
  if (url.indexOf('routing.openstreetmap.de') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      routes: [{ distance: 9000, duration: 900,
                 geometry: { coordinates: [[151.2, -33.8], [151.3, -33.9]] } }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

const list = (api) => api.document.getElementById('people').textContent;
const notes = (api) => api.notes.map((n) => n.title).join(' | ');

function setVisibility(api, value) {
  Object.defineProperty(api.document, 'visibilityState', {
    configurable: true, get: () => value,
  });
  api.document.dispatchEvent(new api.window.Event('visibilitychange'));
}

/* ---------- Our own app going to the background ---------- */
async function testWeAnnounceGoingAway() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);

  check('we start out present', api.window.Convoy.state.away === false);
  setVisibility(api, 'hidden');
  await sleep(20);
  check('putting the app away is announced', !!api.sent('away'), JSON.stringify(api.sent('away')));
  check('and we know we are away', api.window.Convoy.state.away === true);
  check('our own row says so', /background/.test(list(api)), list(api));

  const c = api.clients[0];
  c.published.length = 0;
  setVisibility(api, 'visible');
  await sleep(20);
  check('coming back is announced', !!api.sent('back'));
  check('and our state is pushed again', !!api.sent('hello') && !!api.sent('pos'),
        JSON.stringify(c.published.map((x) => JSON.parse(x).t)));
  check('and we are present again', api.window.Convoy.state.away === false);
}

/* ---------- Coming back must put us on the map again ---------- */
async function testTheLocationWatchIsArmedAgainOnReturn() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);
  const before = api.geo.started;

  setVisibility(api, 'hidden');
  await sleep(20);
  setVisibility(api, 'visible');
  await sleep(20);

  check('coming back arms the location watch again, rather than leaving us off the map',
        api.geo.started > before, before + ' -> ' + api.geo.started);
  check('and the old watch is let go first, so there are never two',
        api.geo.cleared >= 1, String(api.geo.cleared));
  check('the old one is the one that was cleared',
        api.geo.clearedIds.indexOf(before) >= 0, JSON.stringify(api.geo.clearedIds));
}

async function testATouchRetriesWhenWeHaveNoPosition() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);                       // no fix has arrived: we have no position
  check('we start with no position', api.window.Convoy._internals.haveMyPosition() === false);
  check('and our own row says why', /waiting for your location/.test(list(api)), list(api));

  const before = api.geo.started;
  api.touch();
  await sleep(10);
  check('a touch tries the watch again, which is what iOS needs before it will share',
        api.geo.started > before, before + ' -> ' + api.geo.started);

  // Once we have a position, a touch must not keep re-arming it.
  api.fix(-33.86, 151.20);
  await sleep(20);
  const after = api.geo.started;
  api.touch();
  await sleep(10);
  check('and once we are on the map it leaves the watch alone',
        api.geo.started === after, after + ' -> ' + api.geo.started);
  check('and our row stops saying it is waiting', !/waiting for your location/.test(list(api)),
        list(api));
}

/* ---------- Someone else going away, and coming back ---------- */
async function testSomeoneElseAway() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  check('Priya is on the list to begin with', /Priya/.test(list(api)), list(api));
  check('with her distance', /km|m /.test(list(api)), list(api));

  const before = api.notes.length;
  api.recv({ t: 'away', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('her app going to the background shows on the list',
        /background/.test(list(api)), list(api));
  check('but does not raise a notification', api.notes.length === before,
        String(api.notes.length - before));

  api.recv({ t: 'back', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('coming back clears it', !/background/.test(list(api)), list(api));

  // a position also means present
  api.recv({ t: 'away', id: 'p1', name: 'Priya' });
  await sleep(10);
  api.recv(pos('p1', 'Priya', -33.875, 151.215));
  await sleep(20);
  check('a fresh position clears it too', !/background/.test(list(api)), list(api));
}

/* ---------- Someone going quiet ---------- */
async function testSomeoneGoesQuiet() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);

  // her last message was long enough ago to count as silence
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 10, hdg: 90, acc: 6, ts: Date.now() - 200000 });
  await sleep(20);
  check('a quiet phone is not announced as present', !/km/.test(list(api)) || /contact/.test(list(api)),
        list(api));

  const before = api.notes.length;
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('going quiet raises a notification', api.notes.length > before, notes(api));
  check('and it says out of contact, not killed',
        /out of contact/.test(notes(api)), notes(api));
  check('the wording does not claim to know why',
        !/killed|force/i.test(notes(api)), notes(api));
  check('the list says out of contact', /out of contact/.test(list(api)), list(api));

  const after = api.notes.length;
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('and it does not nag while they stay away', api.notes.length === after);

  api.recv(pos('p1', 'Priya', -33.875, 151.215));
  await sleep(20);
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('coming back raises a notification', /is back/.test(notes(api)), notes(api));
  check('and the list goes back to normal', !/out of contact/.test(list(api)), list(api));
}

async function testBackgroundedTooLongCountsAsLost() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  api.recv({ t: 'away', id: 'p1', name: 'Priya' });
  await sleep(20);

  // pretend the "away" note arrived long ago
  api.window.Convoy.state.peers.get('p1').awayAt = Date.now() - 600000;
  const before = api.notes.length;
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('an app left in the background counts as out of contact',
        api.notes.length > before && /out of contact/.test(notes(api)), notes(api));
}

/* ---------- Each phone pushes its own state ---------- */
async function testStatePush() {
  const api = boot({ fetch: routeFetch });
  const c = api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);
  api.window.Convoy.setDest(-33.90, 151.30, 'Bondi');
  await sleep(60);

  check('we have a destination and an arrival time',
        !!api.window.Convoy.state.dest && !!api.window.Convoy.state.myEta);

  c.published.length = 0;
  c.connect_();                     // as if the relay dropped and came back
  await sleep(30);

  const types = c.published.map((x) => JSON.parse(x).t);
  check('a reconnect announces us', types.indexOf('hello') >= 0, types.join(','));
  check('and our position', types.indexOf('pos') >= 0, types.join(','));
  check('and the destination', types.indexOf('dest') >= 0, types.join(','));
  check('and our arrival time', types.indexOf('eta') >= 0, types.join(','));

  const d = api.sent('dest');
  check('the destination keeps the moment it was decided, not now',
        d && typeof d.ts === 'number' && d.ts <= api.window.Convoy.state.destTs,
        JSON.stringify(d && d.ts));
}

/* ---------- The destination outlives the app ---------- */
async function testDestinationSurvivesRestart() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);
  api.window.Convoy.setDest(-33.90, 151.30, 'Bondi');
  await sleep(20);

  const raw = api.window.localStorage.getItem('convoy.room.goa-trip');
  check('the destination is kept on the phone', !!raw, String(raw));
  check('with the place in it', /Bondi/.test(raw || ''), String(raw));
  check('inside the room record, so it lapses with the room',
        /expiresAt/.test(raw || ''), String(raw));

  api.window.Convoy.leave();
  await sleep(20);
  api.join('Akshay', 'goa-trip');
  await sleep(30);
  check('and comes back when you rejoin',
        api.window.Convoy.state.dest && api.window.Convoy.state.dest.label === 'Bondi',
        JSON.stringify(api.window.Convoy.state.dest));
  check('with the same moment attached',
        api.window.Convoy.state.destTs > 0, String(api.window.Convoy.state.destTs));
}

/* ---------- The newest decision wins ---------- */
async function testNewestDestinationWins() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.86, 151.20);
  await sleep(20);

  api.recv({ t: 'dest', id: 'p1', by: 'Priya', lat: -33.90, lng: 151.30, label: 'Bondi' });
  await sleep(20);
  check('a destination arrives', api.window.Convoy.state.dest.label === 'Bondi',
        api.window.Convoy.state.dest.label);
  const settled = api.window.Convoy.state.destTs;

  api.recv({ t: 'dest', id: 'p2', by: 'Rahul', lat: -33.70, lng: 151.10,
             label: 'Old place', ts: settled - 60000 });
  await sleep(20);
  check('an older one cannot overwrite it',
        api.window.Convoy.state.dest.label === 'Bondi', api.window.Convoy.state.dest.label);
  check('and it does not raise a notification', !/Old place/.test(notes(api)), notes(api));

  api.recv({ t: 'dest-clear', id: 'p1', by: 'Priya' });
  await sleep(20);
  check('a clear wins', api.window.Convoy.state.dest === null);

  api.recv({ t: 'dest', id: 'p2', by: 'Rahul', lat: -33.70, lng: 151.10,
             label: 'Zombie', ts: settled });
  await sleep(20);
  check('and an older destination cannot bring it back',
        api.window.Convoy.state.dest === null,
        JSON.stringify(api.window.Convoy.state.dest));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testWeAnnounceGoingAway();
    await testTheLocationWatchIsArmedAgainOnReturn();
    await testATouchRetriesWhenWeHaveNoPosition();
    await testSomeoneElseAway();
    await testSomeoneGoesQuiet();
    await testBackgroundedTooLongCountsAsLost();
    await testStatePush();
    await testDestinationSurvivesRestart();
    await testNewestDestinationWins();
  } catch (e) { crash(e); }
  finish('presence');
})();
