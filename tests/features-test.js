/* The features added after the first version: last seen, arrivals, the switches, a long
   press on the map, room names, tapping a person, and who is behind whom. */
'use strict';

const { boot, check, sleep, pos, finish, crash, makeBroker } = require('./harness');

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
  check('someone gone quiet is named and the reason given',
        /Priya/.test(list) && /Lost network/.test(list), list);
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
  check('with when we last heard from it, beside the reason',
        /Lost network ·/.test(list), list);
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

  check('the one switch says you are sharing',
        text(api, 'pauseLabel') === 'Sharing', text(api, 'pauseLabel'));
  check('and its icon is the open eye',
        !api.document.getElementById('btnPause').classList.contains('on'));

  api.document.getElementById('btnPause').click();
  await sleep(20);
  check('once off it says you are hidden',
        text(api, 'pauseLabel') === 'Hidden', text(api, 'pauseLabel'));
  check('and the button inverts, bright orange with a dark eye',
        api.document.getElementById('btnPause').classList.contains('hiding'));
  check('and a screen reader is told what tapping will do',
        /tap to share again/i.test(api.document.getElementById('btnPause').getAttribute('aria-label')),
        api.document.getElementById('btnPause').getAttribute('aria-label'));
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

/* ---------- The gear, and the pin that unlocks it ---------- */
function unlock(api) {
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1981';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  return sleep(20);
}

async function testTheGearIsJustAVersionAndAField() {
  const api = boot();
  const d = api.document;
  check('there is a settings button in the corner', !!d.getElementById('btnSettings'));

  d.getElementById('btnSettings').click();
  await sleep(10);
  check('it opens', !d.getElementById('settingsCard').classList.contains('hidden'));
  check('and shows the version',
        /Version v\d+/.test(d.getElementById('settingsVersion').textContent),
        d.getElementById('settingsVersion').textContent);

  const pin = d.getElementById('inPin');
  check('with an empty field that says nothing about what it is for',
        pin.value === '' && !pin.getAttribute('placeholder'),
        pin.getAttribute('placeholder') || '(no placeholder)');
  check('and no visible word for it on the card',
        !/pin/i.test(d.getElementById('settingsCard').textContent),
        d.getElementById('settingsCard').textContent.slice(0, 120));
}

async function testAWrongPinDoesNothing() {
  const api = boot();
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1982';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);

  check('a wrong pin unlocks nothing', api.window.Convoy.state.master === false);
  check('and the field is cleared again', pin.value === '');
  check('and no crosses appear anywhere',
        !/data-remove/.test(d.getElementById('people').innerHTML));
}

async function testTheRightPinUnlocksOnlyThisPhone() {
  const api = boot();
  const d = api.document;
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  check('an ordinary phone has no control on anyone',
        !/data-remove/.test(d.getElementById('people').innerHTML));

  await unlock(api);
  check('the pin unlocks this phone', api.window.Convoy.state.master === true);
  check('and is remembered, so it is asked once',
        api.window.localStorage.getItem('convoy.master') === '1');
  check('the crosses appear on other people',
        /data-remove="p1"/.test(d.getElementById('people').innerHTML),
        d.getElementById('people').innerHTML.slice(0, 160));
  check('but never on yourself',
        (d.getElementById('people').innerHTML.match(/data-remove/g) || []).length === 1);
}

async function testTheMasterCanRemoveSomeoneForGood() {
  const api = boot();
  const d = api.document;
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  api.recv(pos('p2', 'Rahul', -33.88, 151.22));
  await sleep(20);
  await unlock(api);

  check('the master sees a cross on everyone but themselves',
        (d.getElementById('people').innerHTML.match(/data-remove/g) || []).length === 2,
        d.getElementById('people').innerHTML.slice(0, 160));
  check('and there is no second control on a row',
        !/data-add/.test(d.getElementById('people').innerHTML));

  d.querySelector('[data-remove="p1"]').click();
  await sleep(20);
  check('the name goes off the list entirely',
        !/Priya/.test(text(api, 'people')), text(api, 'people'));
  check('and off the map', !api.window.Convoy.state.peers.has('p1'));
  const roster = JSON.parse(api.window.localStorage.getItem('convoy.room.convoy') || '{}');
  check('and off the roster, so reopening does not bring them back',
        !roster.members || !roster.members.p1, JSON.stringify(roster.members));
  check('and they are no longer allowed in',
        !api.window.Convoy.state.allowed.has('p1'));
  check('and the group is told both things',
        ((api.sent('removed') || {}).ids || []).indexOf('p1') >= 0 &&
        ((api.sent('allowed') || {}).ids || []).indexOf('p1') < 0,
        JSON.stringify(api.sent('removed')));

  api.recv(pos('p1', 'Priya', -33.87, 151.21));      // they keep sending
  await sleep(20);
  check('and they cannot put themselves back',
        !/Priya/.test(text(api, 'people')), text(api, 'people'));
  check('while everyone else is untouched', /Rahul/.test(text(api, 'people')),
        text(api, 'people'));
}

async function testEveryoneElseStopsSeeingThem() {
  const api = boot();
  const d = api.document;
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  api.recv({ t: 'removed', id: 'master', ids: ['p1'] });
  await sleep(20);

  check('a removed person disappears for everyone else',
        !/Priya/.test(d.getElementById('people').textContent),
        d.getElementById('people').textContent);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  check('and cannot put themselves back',
        !/Priya/.test(d.getElementById('people').textContent),
        d.getElementById('people').textContent);
}

/* ---------- The four group events, and the join request ---------- */
const titles = (api) => api.notes.map((n) => n.title).join(' | ');

async function testEveryGroupEventNotifies() {
  const api = boot();
  await sleep(20);

  api.recv({ t: 'hello', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('a person joining notifies', /Priya joined/.test(titles(api)), titles(api));

  api.recv({ t: 'dest', id: 'p1', name: 'Priya', lat: -37.9, lng: 145.05,
             label: 'Bondi', by: 'Priya', ts: Date.now() });
  await sleep(20);
  check('a destination change notifies', /set the destination/.test(titles(api)), titles(api));

  api.fix(-37.9001, 145.0501);                    // right on it
  I(api).checkArrivals();                          // what the render tick does
  await sleep(30);
  check('arriving notifies', /arrived/i.test(titles(api)), titles(api));

  api.recv({ t: 'bye', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('a person leaving notifies', /Priya left/.test(titles(api)), titles(api));
}

async function testAJoinRequestNotifiesEveryPhoneWithThePin() {
  const one = boot();
  const two = boot();
  const plain = boot();
  await sleep(20);
  await unlock(one);
  await unlock(two);

  const ask = { t: 'hello', id: 'newbie', name: 'Priya', ask: true };
  [one, two, plain].forEach((api) => api.recv(ask, { asStranger: true }));
  await sleep(20);

  check('a request to join notifies the first phone with the pin',
        /wants to join/.test(titles(one)), titles(one));
  check('and the second one too, so it does not matter which is to hand',
        /wants to join/.test(titles(two)), titles(two));
  check('a phone without the pin is not bothered with it',
        !/wants to join/.test(titles(plain)), titles(plain));
}

async function testNotificationsGoThroughTheServiceWorker() {
  // Safari on iOS will not show a notification the page made itself; it has to come from
  // the service worker, so that is what is tried first.
  const shown = [];
  const api = boot({ setup: (w) => {
    Object.defineProperty(w.navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({
        showNotification: (t, o) => { shown.push(t + ' — ' + ((o && o.body) || '')); return Promise.resolve(); },
      }) },
    });
  } });
  await sleep(30);
  api.recv({ t: 'hello', id: 'p1', name: 'Priya' });
  await sleep(30);
  check('the notification is shown by the service worker', shown.length === 1, JSON.stringify(shown));
  check('and not by the page, which iOS would drop', api.notes.length === 0,
        JSON.stringify(api.notes.map((n) => n.title)));
}

/* ---------- Letting people in ---------- */
async function testAPhoneOutsideTheRoomWaits() {
  const api = boot({ outside: true });
  await sleep(20);
  const d = api.document;
  check('a phone that has not been let in is told why the map is empty',
        /Nobody outside can see the map/.test(d.getElementById('people').textContent),
        d.getElementById('people').textContent);
  check('and the waiting line says what is happening right now',
        /Connecting|Connected|No connection|Retrying/.test(text(api, 'waitLine')),
        text(api, 'waitLine'));
  const bar = () => !api.document.getElementById('waitBar').classList.contains('hidden');
  const line = () => text(api, 'waitLine');
  const I2 = api.window.Convoy._internals;

  api.window.Convoy.state.conn = 'waiting';
  I2.renderWaiting();
  check('a bar sweeps while it is still connecting', bar() && /Connecting/.test(line()),
        line());

  api.window.Convoy.state.conn = 'down';
  I2.renderWaiting();
  check('and it says so plainly when there is no link',
        bar() && /No connection/.test(line()), line());

  api.window.Convoy.state.conn = 'live';
  I2.renderWaiting();
  check('once connected and not yet asked, nothing is in progress',
        !bar() && /Press Join/.test(line()), line());

  api.window.Convoy.state.joinAsked = true;
  I2.renderWaiting();
  check('and after asking, the bar comes back with what it is waiting for',
        bar() && /Request sent/.test(line()), line());
  api.window.Convoy.state.joinAsked = false;
  check('and the count says so too',
        /waiting/.test(text(api, 'peopleCount')), text(api, 'peopleCount'));
  check('and nobody else is on its list',
        !/Priya/.test(d.getElementById('people').textContent));
}

async function testOneButtonUntilYouAreIn() {
  const out = boot({ outside: true });
  await sleep(20);
  const d = out.document;
  const vis = (id) => !d.getElementById(id).classList.contains('hidden');

  check('outside the room there is one button, and it says Join the convoy',
        vis('btnJoin') && text(out, 'joinLabel') === 'Join the convoy', text(out, 'joinLabel'));
  check('and none of the four', ['btnInvite', 'btnPause', 'btnCentre', 'btnSettings']
    .every((id) => !vis(id)));

  const before = out.sentAll('hello').length;
  d.getElementById('btnJoin').click();
  await sleep(20);
  check('pressing Join asks to be let in', out.sentAll('hello').length > before,
        before + ' -> ' + out.sentAll('hello').length);
  check('and it turns into a cancel, so Join is not offered twice',
        text(out, 'joinLabel') === 'Cancel request', text(out, 'joinLabel'));

  d.getElementById('btnJoin').click();
  await sleep(20);
  check('cancelling puts Join the convoy back',
        text(out, 'joinLabel') === 'Join the convoy', text(out, 'joinLabel'));
  const lastHello = out.sentAll('hello')[out.sentAll('hello').length - 1];
  check('and stops the asking', lastHello && lastHello.ask === false,
        JSON.stringify(lastHello && lastHello.ask));

  const inside = boot();
  await sleep(20);
  const di = inside.document;
  check('once you are in, the four buttons are back',
        ['btnInvite', 'btnPause', 'btnCentre', 'btnSettings']
          .every((id) => !di.getElementById(id).classList.contains('hidden')) &&
        di.getElementById('btnJoin').classList.contains('hidden'));
}

async function testHelpStaysReachableWhileOutside() {
  // The pin field lives in Help, so a phone outside the room must still be able to reach it.
  const api = boot({ outside: true });
  await sleep(20);
  const d = api.document;
  check('Help is not in the row when you are outside', d.getElementById('btnSettings')
    .classList.contains('hidden'));

  d.getElementById('connState').dispatchEvent(new api.window.Event('pointerdown'));
  await sleep(650);
  check('but holding the connection word opens it',
        !d.getElementById('settingsCard').classList.contains('hidden'));
  check('with the pin field in it', !!d.getElementById('inPin'));
}

async function testBeingRemovedReachesThatPhone() {
  // The removal is broadcast, so the phone it happened to has to act on it. Otherwise it
  // keeps the allowed list it had and goes on showing four buttons as if nothing happened.
  const api = boot();
  await sleep(20);
  const d = api.document;
  const me = api.window.Convoy.state.me.id;
  check('to start with, this phone is in and has four buttons',
        api.window.Convoy.state.allowed.has(me) &&
        !d.getElementById('btnInvite').classList.contains('hidden'));

  api.recv({ t: 'removed', id: 'master', ids: [me] });
  await sleep(20);
  check('being removed takes this phone out of the room',
        !api.window.Convoy.state.allowed.has(me));
  check('so the four buttons go and Join comes back',
        d.getElementById('btnInvite').classList.contains('hidden') &&
        !d.getElementById('btnJoin').classList.contains('hidden'));
  check('and it is remembered, so a reload does not put it back',
        !JSON.parse(api.window.localStorage.getItem('convoy.room.convoy') || '{}')
          .allowed.includes(me));
  check('the button offers the same door as anyone else',
        text(api, 'joinLabel') === 'Join the convoy', text(api, 'joinLabel'));
  check('and nothing says they were kicked out',
        !/kick|removed|thrown|banned/i.test(text(api, 'people') + text(api, 'peopleCount')),
        text(api, 'people') + ' / ' + text(api, 'peopleCount'));
}

async function testTheRemovalIsAnnouncedAgainAfterAReconnect() {
  // One broadcast is not enough: a master that was briefly offline when they removed
  // someone had nothing to send it with, and the state push on reconnecting never
  // carried the removal either — so the removed phone never heard.
  const api = boot();
  await sleep(20);
  await unlock(api);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  api.document.querySelector('[data-remove="p1"]').click();
  await sleep(20);

  const before = api.sentAll('removed').length;
  api.window.Convoy._internals.sendState();          // what happens on every reconnect
  await sleep(20);
  check('the state push carries the removal, so it survives a reconnect',
        api.sentAll('removed').length > before,
        before + ' -> ' + api.sentAll('removed').length);
  check('and the list carries the right id',
        ((api.sent('removed') || {}).ids || []).indexOf('p1') >= 0,
        JSON.stringify(api.sent('removed')));
}

async function testAStrangerIsInvisibleWithoutThePin() {
  const api = boot();
  await sleep(20);
  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(20);

  check('someone who has not been let in never reaches the list',
        !/Priya/.test(text(api, 'people')), text(api, 'people'));
  check('and there is nothing to approve on a phone without the pin',
        !/data-yes/.test(api.document.getElementById('people').innerHTML));
  check('and the request is not even kept',
        api.window.Convoy.state.pending.size === 0,
        String(api.window.Convoy.state.pending.size));
}

async function testTheAskGoesOutEvenWithAStaleAllowedList() {
  // The phone was removed but its own list still had it. It used to send no ask at all, so
  // the pin phone never knew there was a request to show.
  const api = boot();
  await sleep(20);
  const me = api.window.Convoy.state.me.id;
  api.window.Convoy.state.allowed.add(me);        // stale: it still thinks it is in
  api.window.Convoy.state.joinAsked = true;       // and it is asking
  api.window.Convoy._internals.sendState();
  await sleep(20);
  const hello = api.sent('hello') || {};
  check('the ask is still on the message', hello.ask === true, JSON.stringify(hello.ask));
}

async function testARequestOutlivesTheSender() {
  // A request sent while no pin phone was connected used to be lost. It is now published
  // retained on a topic of its own, so the broker holds it for whoever connects next.
  const api = boot({ outside: true });
  await sleep(20);
  const d = api.document;
  const client = () => api.clients[api.clients.length - 1];

  check('the phone listens for requests left for it',
        (client().subscriptions || []).some((t) => /\/ask\/\+$/.test(t)),
        JSON.stringify(client().subscriptions));

  d.getElementById('btnJoin').click();
  await sleep(20);
  const ask = client().publishes.filter((p) => /\/ask\//.test(p.topic) && p.opts.retain);
  check('asking publishes a retained message on its own topic', ask.length >= 1,
        JSON.stringify(client().publishes.map((p) => p.topic)));
  check('naming who is asking', ask.length > 0 && /Priya|Phone/.test(ask[0].msg),
        ask[0] && ask[0].msg);
  check('and it is held by the broker, not just shouted once',
        ask.every((p) => p.opts.retain === true));

  d.getElementById('btnJoin').click();
  await sleep(20);
  const cleared = client().publishes.filter(
    (p) => /\/ask\//.test(p.topic) && p.opts.retain && p.msg === '');
  check('cancelling clears it from the broker, so it cannot come back later',
        cleared.length === 1, String(cleared.length));
}

async function testAnAskMadeWhileTheLinkIsDownIsNotLost() {
  // Tapping Join before the relay is up must not drop the request: the ask is a piece of
  // state on the phone, re-published on every tick and every connect until it is answered.
  const api = boot({ outside: true });
  await sleep(20);
  const d = api.document;
  const I = api.window.Convoy._internals;
  const client = () => api.clients[api.clients.length - 1];

  client().connected = false;                     // the link is not up yet
  d.getElementById('btnJoin').click();
  await sleep(20);
  check('the phone remembers that it asked', api.window.Convoy.state.joinAsked === true);
  check('and that is written down, so a reload does not lose it',
        api.window.localStorage.getItem('convoy.joinAsked') === '1');
  check('nothing was published while the link was down',
        client().publishes.filter((p) => /\/ask\//.test(p.topic)).length === 0);

  const before = client().publishes.filter((p) => /\/ask\//.test(p.topic)).length;
  client().connected = true;
  I.publishNow();                                 // what the next tick does
  await sleep(20);
  const after = client().publishes.filter((p) => /\/ask\//.test(p.topic));
  check('and it goes out as soon as the link is live', after.length > before,
        before + ' -> ' + after.length);
  check('still retained, so it is held for the pin phone',
        after.every((p) => p.opts.retain === true));
}

async function testAPinPhoneIsToldOfARequestLeftWhileItWasAway() {
  const api = boot();
  await sleep(20);
  await unlock(api);

  api.recv({ t: 'ask', id: 'away', name: 'Priya', ts: Date.now() }, { asStranger: true });
  await sleep(20);
  check('a request left on the broker shows up on connecting',
        api.window.Convoy.state.pending.has('away'), text(api, 'people'));
  check('and it notifies', /wants to join/.test(titles(api)), titles(api));

  api.recv({ t: 'ask', id: 'stale', name: 'Rahul', ts: Date.now() - 3600000 }, { asStranger: true });
  await sleep(20);
  check('but an hour-old one does not', !api.window.Convoy.state.pending.has('stale'));
}

async function testAMessageWithoutTheFlagStillCountsAsAsking() {
  // Older builds send no ask field. Treating silence as "not asking" would mean their
  // requests never appeared.
  const api = boot();
  const d = api.document;
  await sleep(20);
  await unlock(api);
  api.recv({ t: 'hello', id: 'old', name: 'Priya' }, { asStranger: true });
  await sleep(20);
  check('a request with no ask field is still a request',
        api.window.Convoy.state.pending.has('old'), text(api, 'people'));
  check('with a button to let them in',
        /data-yes="old"/.test(d.getElementById('people').innerHTML));
}

async function testTheRequestCrossesToTheOtherPhone() {
  // Two apps on one broker, as two phones on one relay. Everything before this tested one
  // phone talking to itself, which is exactly the gap that let a broken request path pass.
  const broker = makeBroker();
  const pin = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlock(pin);
  pin.goLive();
  guest.goLive();
  await sleep(60);

  guest.document.getElementById('btnJoin').click();
  await sleep(80);

  check('the pin phone is asked', pin.window.Convoy.state.pending.size === 1,
        String(pin.window.Convoy.state.pending.size));
  check('with a button to let them in',
        /data-yes=/.test(pin.document.getElementById('people').innerHTML),
        pin.document.getElementById('people').innerHTML.slice(0, 160));
  check('and it notifies', /wants to join/.test(titles(pin)), titles(pin));

  pin.document.querySelector('[data-yes]').click();
  await sleep(80);
  const guestMe = guest.window.Convoy.state.me.id;
  check('letting them in reaches their phone',
        guest.window.Convoy.state.allowed.has(guestMe),
        Array.from(guest.window.Convoy.state.allowed).join(','));
  check('so the four buttons appear and Join goes away',
        guest.document.getElementById('btnJoin').classList.contains('hidden') &&
        !guest.document.getElementById('btnInvite').classList.contains('hidden'));
}

async function testAStaleAllowedListStillLetsTheRequestThrough() {
  // The pin phone still had them down as in — as if a removal made on another pin phone
  // never arrived. The phone asking knows it is outside, so its word wins.
  const broker = makeBroker();
  const pin = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlock(pin);
  pin.window.Convoy.state.allowed.add(guest.window.Convoy.state.me.id);
  pin.goLive();
  guest.goLive();
  await sleep(60);

  guest.document.getElementById('btnJoin').click();
  await sleep(120);
  // Either the pin phone shows the request, or the stale list admits them straight away.
  // What must not happen is the person being stranded with a button that does nothing.
  const guestMe2 = guest.window.Convoy.state.me.id;
  check('a stale list cannot strand them',
        pin.window.Convoy.state.pending.size === 1 ||
        guest.window.Convoy.state.allowed.has(guestMe2),
        'pending ' + pin.window.Convoy.state.pending.size);
}

async function testTheMasterIsAskedByName() {
  const api = boot();
  const d = api.document;
  await sleep(20);
  await unlock(api);

  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(20);

  check('the master is shown the request, by name',
        /Priya/.test(text(api, 'people')) && /wants to join/.test(text(api, 'people')),
        text(api, 'people'));
  check('with a button to let them in',
        /data-yes="newbie"/.test(d.getElementById('people').innerHTML));
  check('and they are not in the room yet',
        !api.window.Convoy.state.allowed.has('newbie'));

  d.querySelector('[data-yes="newbie"]').click();
  await sleep(20);
  check('letting them in adds them', api.window.Convoy.state.allowed.has('newbie'));
  check('and tells every phone',
        ((api.sent('allowed') || {}).ids || []).indexOf('newbie') >= 0,
        JSON.stringify(api.sent('allowed')));
  check('and the request goes away', api.window.Convoy.state.pending.size === 0);
}

async function testTurningSomeoneAway() {
  const api = boot();
  const d = api.document;
  await sleep(20);
  await unlock(api);
  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(20);

  d.querySelector('[data-no="newbie"]').click();
  await sleep(20);
  check('turning them away marks them out', api.window.Convoy.state.removed.has('newbie'));
  check('and stops the request', api.window.Convoy.state.pending.size === 0);

  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(20);
  check('but they may ask again, so nobody is shut out for good',
        api.window.Convoy.state.pending.size === 1,
        String(api.window.Convoy.state.pending.size));
}

async function testTheListIsAnnouncedAgainWhenSomeoneArrives() {
  // The one broadcast that carried the approval may have happened before the approved
  // phone was listening, which left it waiting for ever. Every arrival asks again.
  const api = boot();
  await sleep(20);
  await unlock(api);
  const before = api.sentAll('allowed').length;

  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(30);
  check('a phone that arrives is told who is in',
        api.sentAll('allowed').length > before,
        before + ' -> ' + api.sentAll('allowed').length);
  check('and the list carries the phone with the pin',
        ((api.sent('allowed') || {}).ids || []).indexOf(api.window.Convoy.state.me.id) >= 0,
        JSON.stringify(api.sent('allowed')));
}

async function testAnyPhoneWithTheListPassesItOn() {
  // So an approved phone learns even when the master is not around.
  const api = boot();
  await sleep(20);
  const before = api.sentAll('allowed').length;
  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(30);
  check('a phone in the room passes the list on to whoever arrives',
        api.sentAll('allowed').length > before,
        before + ' -> ' + api.sentAll('allowed').length);
}

async function testWithdrawingClearsTheRequest() {
  const api = boot();
  const d = api.document;
  await sleep(20);
  await unlock(api);

  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: true }, { asStranger: true });
  await sleep(20);
  check('an ask shows up', api.window.Convoy.state.pending.has('newbie'));

  api.recv({ t: 'hello', id: 'newbie', name: 'Priya', ask: false }, { asStranger: true });
  await sleep(20);
  check('withdrawing takes it off again', !api.window.Convoy.state.pending.has('newbie'));
  check('and the row goes', !/wants to join/.test(text(api, 'people')), text(api, 'people'));
}

async function testOnceLetInTheyAppearForEveryone() {
  const api = boot();
  await sleep(20);
  api.recv({ t: 'allowed', id: 'master', ids: ['newbie'] });
  await sleep(20);
  api.recv(pos('newbie', 'Priya', -33.87, 151.21));
  await sleep(20);
  check('someone who has been let in appears for everyone',
        /Priya/.test(text(api, 'people')), text(api, 'people'));
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
    await testEveryGroupEventNotifies();
    await testAJoinRequestNotifiesEveryPhoneWithThePin();
    await testNotificationsGoThroughTheServiceWorker();
    await testAPhoneOutsideTheRoomWaits();
    await testOneButtonUntilYouAreIn();
    await testHelpStaysReachableWhileOutside();
    await testBeingRemovedReachesThatPhone();
    await testTheRemovalIsAnnouncedAgainAfterAReconnect();
    await testAStrangerIsInvisibleWithoutThePin();
    await testTheAskGoesOutEvenWithAStaleAllowedList();
    await testARequestOutlivesTheSender();
    await testAnAskMadeWhileTheLinkIsDownIsNotLost();
    await testAPinPhoneIsToldOfARequestLeftWhileItWasAway();
    await testAMessageWithoutTheFlagStillCountsAsAsking();
    await testTheRequestCrossesToTheOtherPhone();
    await testAStaleAllowedListStillLetsTheRequestThrough();
    await testTheMasterIsAskedByName();
    await testTurningSomeoneAway();
    await testTheListIsAnnouncedAgainWhenSomeoneArrives();
    await testAnyPhoneWithTheListPassesItOn();
    await testWithdrawingClearsTheRequest();
    await testOnceLetInTheyAppearForEveryone();
    await testTheGearIsJustAVersionAndAField();
    await testAWrongPinDoesNothing();
    await testTheRightPinUnlocksOnlyThisPhone();
    await testTheMasterCanRemoveSomeoneForGood();
    await testEveryoneElseStopsSeeingThem();
    await testTheNotificationSound();
    await testALongPressSetsTheDestination();
    await testALongPressWorksWithNoLookup();
    await testTappingAPerson();
    await testBehindAndAhead();
  } catch (e) { crash(e); }
  finish('features');
})();
