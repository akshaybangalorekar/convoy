/* The features added after the first version: last seen, arrivals, the switches, a long
   press on the map, room names, tapping a person, and who is behind whom. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

const DEST = { lat: -37.90, lng: 145.05 };
const I = (api) => api.window.Convoy._internals;
const text = (api, id) => api.document.getElementById(id).textContent;
const banner = (api) => api.document.getElementById('banner').textContent;

async function joinRoom(api, name, room) {
  api.join(name || 'Akshay', room || 'goa-trip');
  await sleep(20);
  return api;
}

/* ---------- Last seen ---------- */
async function testSomeoneGoneQuietSaysHowLong() {
  const api = boot();
  await joinRoom(api);
  api.recv(pos('p1', 'Priya', -37.91, 145.06));
  await sleep(20);
  check('someone we can still hear from shows where they are',
        !/last seen/.test(text(api, 'people')), text(api, 'people'));

  const p = api.window.Convoy.state.peers.get('p1');
  p.ts = Date.now() - 20 * 60000;
  p.lastSeen = p.ts;
  I(api).sweepPresence();
  await sleep(20);

  const list = text(api, 'people');
  check('someone gone quiet says when we last heard from them',
        /last seen/.test(list), list);
  check('with a real length of time in it',
        /(19|20|21) min ago/.test(list), list);
}

async function testTheRosterRemembersLastSeen() {
  // A phone that was here earlier: no position this session, but the room's roster knows
  // when it was last heard from. "Out of contact" on its own is too vague to act on.
  const api = boot();
  api.window.localStorage.setItem('convoy.room.old-trip', JSON.stringify({
    code: 'old-trip',
    startedAt: Date.now() - 3600000,
    expiresAt: Date.now() + 86400000,
    updatedAt: Date.now(),
    members: { ghost: { name: 'Ravi', lastSeen: Date.now() - 3600000 } },
  }));
  await joinRoom(api, 'Akshay', 'old-trip');

  const list = text(api, 'people');
  check('a phone from earlier is still listed', /Ravi/.test(list), list);
  check('with when we last heard from it', /last seen/.test(list), list);
  check('and how long ago that was', /1h ago/.test(list), list);
}

/* ---------- Arrivals ---------- */
// Roughly 0.0003 degrees of latitude is 33 m, and 0.0005 is 56 m — either side of the
// fifty-metre line, so the threshold is tested rather than assumed.
async function testArrivingIsAnnounced() {
  const api = boot();
  await joinRoom(api);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);

  api.recv(pos('p1', 'Priya', -37.95, 145.05));       // still a few km out
  await sleep(20);
  const before = api.notes.length;                    // after the "joined" ping
  I(api).checkArrivals();
  check('nobody is called arrived while they are still coming',
        api.notes.length === before, String(api.notes.length - before));

  api.recv(pos('p1', 'Priya', DEST.lat + 0.0005, DEST.lng));   // ~56 m out
  await sleep(20);
  I(api).checkArrivals();
  check('fifty-six metres out is not arrived yet', api.notes.length === before,
        String(api.notes.length - before));

  api.recv(pos('p1', 'Priya', DEST.lat + 0.0003, DEST.lng));   // ~33 m out
  await sleep(20);
  I(api).checkArrivals();
  const last = api.notes[api.notes.length - 1];
  check('inside fifty metres it is announced', /Priya has arrived/.test(last.title), last.title);

  const after = api.notes.length;
  I(api).checkArrivals();
  I(api).checkArrivals();
  check('and announced only once', api.notes.length === after,
        String(api.notes.length - after));
}

async function testTheArrivalTimeStaysUntilTheyArrive() {
  const api = boot();
  await joinRoom(api);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);
  const row = () => api.document.querySelector('#people li[data-id="p1"]').textContent;

  api.recv(pos('p1', 'Priya', -37.95, 145.05));
  await sleep(20);
  api.recv({ t: 'eta', id: 'p1', dur: 600, dist: 5000, ts: Date.now() });
  await sleep(20);
  check('someone on their way shows the time they will arrive',
        /\d{1,2}:\d{2}/.test(row()) && !/arrived/.test(row()), row());

  api.recv(pos('p1', 'Priya', DEST.lat + 0.0003, DEST.lng));   // ~33 m out
  await sleep(20);
  I(api).checkArrivals();
  check('once they are there, that is replaced by arrived', /arrived/.test(row()), row());
  check('and no clock time is left over', !/\d{1,2}:\d{2}/.test(row()), row());
}

async function testAnotherPhoneAnnouncingItsArrival() {
  const api = boot();
  await joinRoom(api);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);

  api.recv(pos('p1', 'Priya', DEST.lat + 0.05, DEST.lng));    // 5.5 km out
  await sleep(20);
  I(api).checkArrivals();
  check('nobody is arrived from five kilometres out',
        api.window.Convoy.state.peers.get('p1').arrived !== true);

  // Her phone works it out for itself and says so, which is the only way it can happen now.
  api.recv({ t: 'arrived', id: 'p1', on: true });
  await sleep(20);
  check('and her own phone telling us counts',
        api.window.Convoy.state.peers.get('p1').arrived === true);
  const last = api.notes[api.notes.length - 1];
  check('and it is announced', /Priya has arrived/.test(last.title), last.title);
}

async function testANewDestinationResetsArrivals() {
  const api = boot();
  await joinRoom(api);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);
  api.recv(pos('p1', 'Priya', DEST.lat + 0.0003, DEST.lng));
  await sleep(20);
  I(api).checkArrivals();
  check('she has arrived', api.window.Convoy.state.peers.get('p1').arrived === true);

  api.window.Convoy.setDest(-37.80, 145.00, 'Somewhere else');
  await sleep(20);
  check('a new destination means nobody has arrived yet',
        api.window.Convoy.state.peers.get('p1').arrived === false);
  check('including us', api.window.Convoy.state.arrived === false);
}

async function testThereIsNoArrivedButton() {
  const api = boot();
  await joinRoom(api);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);

  check('there is no button to press, because arriving is automatic',
        !api.document.getElementById('btnHere'));
  check('and we are not marked arrived just because a destination exists',
        api.window.Convoy.state.arrived === false);

  // Driving up to the destination does it on its own.
  api.fix(DEST.lat + 0.0003, DEST.lng);
  await sleep(20);
  I(api).checkArrivals();
  check('coming within fifty metres marks it without anyone touching anything',
        api.window.Convoy.state.arrived === true);
  check('and the room is told', !!api.sent('arrived'));
  check('and it shows beside your name', /arrived/.test(text(api, 'people')),
        text(api, 'people'));
}

/* ---------- Not sharing ---------- */
async function testPauseSharing() {
  const api = boot();
  await joinRoom(api);
  api.fix(-37.90, 145.05);
  await sleep(20);
  const shared = () => api.sentAll('pos').length;

  check('the one switch is called Hide my location',
        text(api, 'btnPause') === 'Hide my location', text(api, 'btnPause'));

  api.document.getElementById('btnPause').click();
  await sleep(20);
  check('and says the location is hidden once it is on',
        text(api, 'btnPause') === 'Location hidden', text(api, 'btnPause'));
  check('and the room is told, so it is not mistaken for losing us',
        !!api.sent('paused'));

  const before = shared();
  I(api).publishNow(true);
  await sleep(20);
  check('nothing more is shared while paused', shared() === before,
        String(shared() - before));

  api.document.getElementById('btnPause').click();
  await sleep(20);
  check('turning it back on is announced', !!api.sent('sharing'));
  check('and a fresh position goes out straight away', shared() > before,
        String(shared() - before));
}

async function testAPausedPhoneIsNotJustQuiet() {
  const api = boot();
  await joinRoom(api);
  api.recv(pos('p1', 'Priya', -37.91, 145.06));
  await sleep(20);
  api.recv({ t: 'paused', id: 'p1' });
  await sleep(20);

  const kind = I(api).presenceOf(api.window.Convoy.state.peers.get('p1'));
  check('a paused phone is marked paused, not lost', kind === 'paused', kind);
  check('and the list says why', /location hidden/.test(text(api, 'people')),
        text(api, 'people'));

  api.recv({ t: 'sharing', id: 'p1' });
  await sleep(20);
  check('and it clears when they share again',
        I(api).presenceOf(api.window.Convoy.state.peers.get('p1')) === 'live');
}

/* ---------- How often we share ---------- */
async function testTheSharingRateIsChosenForBattery() {
  const api = boot();
  await joinRoom(api);
  const CFG = api.window.Convoy.CFG;

  check('we share every thirty seconds, not every five', CFG.publishMs === 30000,
        String(CFG.publishMs));
  check('and the arrival time is worked out every five minutes', CFG.etaMs === 300000,
        String(CFG.etaMs));
  check('which is well inside the silence that counts as out of contact',
        CFG.publishMs * 3 <= CFG.staleMs,
        CFG.publishMs + ' every, stale at ' + CFG.staleMs);
  check('and there is no switch for it, because it is simply the setting',
        !api.document.getElementById('btnSaver'));
}

/* ---------- The screen stays awake ---------- */
function setVisible(api, value) {
  Object.defineProperty(api.document, 'visibilityState', {
    configurable: true, get: () => value,
  });
  api.document.dispatchEvent(new api.window.Event('visibilitychange'));
}

async function testTheScreenStaysAwake() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  check('joining takes a screen wake lock, so the phone does not sleep mid-drive',
        api.wake.requested >= 1, String(api.wake.requested));
}

async function testTheScreenLockIsTakenAgainOnReturn() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const before = api.wake.requested;

  // The browser drops the lock the moment the page is hidden, and never hands it back.
  setVisible(api, 'hidden');
  api.wake.drop();
  await sleep(20);
  setVisible(api, 'visible');
  await sleep(20);

  check('coming back takes the screen lock again', api.wake.requested > before,
        before + ' -> ' + api.wake.requested);
}

async function testATouchRetriesARefusedScreenLock() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  api.wake.drop();                       // the browser took it away
  await sleep(10);
  const before = api.wake.requested;

  api.touch();
  await sleep(10);
  check('a touch asks again, which is what iOS Low Power Mode needs',
        api.wake.requested > before, before + ' -> ' + api.wake.requested);
}

async function testItIsFineWithNoWakeLockApi() {
  const api = boot({ setup: (w) => { delete w.navigator.wakeLock; } });
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  check('a browser without a wake lock API still joins and works',
        api.window.Convoy.state.joined === true);
  check('and nothing was asked for', api.wake.requested === 0, String(api.wake.requested));
}

/* ---------- Sound ---------- */
async function testTheNotificationSound() {
  const api = boot();
  await joinRoom(api);

  check('nothing is played before the page has been touched', api.pings.length === 0,
        String(api.pings.length));

  api.touch();
  await sleep(10);
  I(api).notify('Hello', 'there');
  check('after a touch a notification makes a sound', api.pings.length > 0,
        String(api.pings.length));

  const after = api.pings.length;
  I(api).notify('Again', 'please');
  check('and every notification after that does too', api.pings.length > after,
        String(api.pings.length - after));
}

/* ---------- A long press on the map ---------- */
const reverseOk = (url) => {
  if (url.indexOf('nominatim.openstreetmap.org/reverse') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      lat: '-37.90', lon: '145.05', name: '92',
      address: { house_number: '92', road: 'Mimosa Road', suburb: 'Carnegie',
                 city: 'Melbourne', state: 'Victoria', postcode: '3163',
                 country: 'Australia' },
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

async function testALongPressSetsTheDestination() {
  const api = boot({ fetch: reverseOk });
  await joinRoom(api);

  api.mapFire('contextmenu', { latlng: { lat: -37.90, lng: 145.05 } });
  await sleep(80);

  const dest = api.window.Convoy.state.dest;
  check('holding a finger on the map sets the destination', !!dest, JSON.stringify(dest));
  check('at that point', !!dest && Math.abs(dest.lat + 37.90) < 1e-6, JSON.stringify(dest));
  check('and it is looked up, so it reads as an address',
        !!dest && /Carnegie/.test(dest.label), dest && dest.label);
  check('and the room is told', !!api.sent('dest'));
}

async function testALongPressWorksWithNoLookup() {
  const api = boot();                       // every lookup fails
  await joinRoom(api);
  api.mapFire('contextmenu', { latlng: { lat: -37.90, lng: 145.05 } });
  await sleep(80);

  const dest = api.window.Convoy.state.dest;
  check('a pin still lands when the lookup fails', !!dest, JSON.stringify(dest));
  check('and it is honestly just a pin', !!dest && /Pinned/.test(dest.label),
        dest && dest.label);
}

/* ---------- Pasting the invite link ---------- */
async function testPastingTheInviteLink() {
  const api = boot();
  const box = api.document.getElementById('inRoom');
  const type = (v) => {
    box.value = v;
    box.dispatchEvent(new api.window.Event('input', { bubbles: true }));
  };

  type('https://akshaybangalorekar.github.io/convoy/#r=ride-7f3k9');
  check('pasting the whole link fills in the code', box.value === 'ride-7f3k9', box.value);

  type('https://akshaybangalorekar.github.io/convoy/?r=other-room');
  check('and the query-string shape too', box.value === 'other-room', box.value);

  type('sunny-drive');
  check('a plain code is left alone', box.value === 'sunny-drive', box.value);
}

/* ---------- Naming the room ---------- */
async function testNamingTheRoom() {
  const api = boot();
  await joinRoom(api);
  const d = api.document;

  check('the chip shows the code until the room is named',
        text(api, 'roomChip') === 'goa-trip', text(api, 'roomChip'));

  const input = d.getElementById('inRoomName');
  input.value = 'Sunday drive';
  input.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);

  check('the name goes on the chip', text(api, 'roomChip') === 'Sunday drive',
        text(api, 'roomChip'));
  check('and the room is told', (api.sent('room-name') || {}).name === 'Sunday drive',
        JSON.stringify(api.sent('room-name')));
  check('and it is kept on this phone',
        /Sunday drive/.test(api.window.localStorage.getItem('convoy.room.goa-trip') || ''),
        api.window.localStorage.getItem('convoy.room.goa-trip'));

  api.recv({ t: 'room-name', id: 'p1', name: 'Beach run', ts: Date.now() + 1000 });
  await sleep(20);
  check('a newer name from someone else wins', text(api, 'roomChip') === 'Beach run',
        text(api, 'roomChip'));

  api.recv({ t: 'room-name', id: 'p2', name: 'Ancient', ts: 1 });
  await sleep(20);
  check('an older one is ignored', text(api, 'roomChip') === 'Beach run',
        text(api, 'roomChip'));
}

/* ---------- Tapping a person ---------- */
async function testTappingAPerson() {
  const api = boot();
  await joinRoom(api);
  api.recv(pos('p1', 'Priya', -37.95, 145.10));
  await sleep(20);

  const before = api.calls.setView.length;
  const row = api.document.querySelector('#people li[data-id="p1"]');
  check('the person is in the list', !!row);
  row.click();
  await sleep(20);

  check('tapping them brings the map to them', api.calls.setView.length > before,
        String(api.calls.setView.length - before));
  const last = api.calls.setView[api.calls.setView.length - 1];
  check('at their position',
        !!last && Math.abs(last[0][0] + 37.95) < 1e-6 && Math.abs(last[0][1] - 145.10) < 1e-6,
        JSON.stringify(last && last[0]));
  check('and stops the view chasing everyone', api.window.Convoy.state.autoFit === false);
}

/* ---------- Who is behind whom ---------- */
async function testBehindAndAhead() {
  const api = boot();
  await joinRoom(api);
  api.fix(-37.94, 145.05);                  // we are about 4.4 km short
  await sleep(20);
  api.window.Convoy.setDest(DEST.lat, DEST.lng, 'Carnegie');
  await sleep(20);

  api.recv(pos('p1', 'Priya', -37.96, 145.05));       // further from it than us
  await sleep(20);
  check('someone further back is described as behind you',
        /behind you/.test(text(api, 'people')), text(api, 'people'));

  api.recv(pos('p2', 'Ravi', -37.91, 145.05));        // closer to it than us
  await sleep(20);
  check('someone closer is described as ahead of you',
        /ahead of you/.test(text(api, 'people')), text(api, 'people'));

  api.recv(pos('p3', 'Sam', -37.9401, 145.05));       // right beside us
  await sleep(20);
  check('and someone beside you is just alongside',
        /alongside you/.test(text(api, 'people')), text(api, 'people'));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testSomeoneGoneQuietSaysHowLong();
    await testTheRosterRemembersLastSeen();
    await testArrivingIsAnnounced();
    await testTheArrivalTimeStaysUntilTheyArrive();
    await testAnotherPhoneAnnouncingItsArrival();
    await testANewDestinationResetsArrivals();
    await testThereIsNoArrivedButton();
    await testPauseSharing();
    await testAPausedPhoneIsNotJustQuiet();
    await testTheSharingRateIsChosenForBattery();
    await testTheScreenStaysAwake();
    await testTheScreenLockIsTakenAgainOnReturn();
    await testATouchRetriesARefusedScreenLock();
    await testItIsFineWithNoWakeLockApi();
    await testTheNotificationSound();
    await testALongPressSetsTheDestination();
    await testALongPressWorksWithNoLookup();
    await testPastingTheInviteLink();
    await testNamingTheRoom();
    await testTappingAPerson();
    await testBehindAndAhead();
  } catch (e) { crash(e); }
  finish('features');
})();
