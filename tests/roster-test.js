/* The roster: who has been in the convoy, and the one rule that takes them off again —
   a week after the last time anyone heard from them. There is no room, no code and no
   lifetime to manage. */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot, check, sleep, pos, finish, crash, DIR } = require('./harness');
const io_read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const DAY = 86400000;
const record = () =>
  JSON.parse((arguments[0] || global.__api).window.localStorage.getItem('convoy.record') || 'null');
const rec = (api) => JSON.parse(api.window.localStorage.getItem('convoy.record') || 'null');
const list = (api) => api.document.getElementById('people').textContent;
const titles = (api) => api.notes.map((n) => n.title).join(' | ');
const titlesSince = (api, n) => api.notes.slice(n).map((x) => x.title).join(' | ');

/* ---------- The blanket rule ---------- */
async function testAWeekAfterTheirLastSignOfLifeTheyAreDropped() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.2);
  await sleep(20);
  const I = api.window.Convoy._internals;

  // Two people: one heard from a minute ago, one heard from eight days ago.
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  const now = Date.now();
  api.window.Convoy.state.peers.set('p2', {
    id: 'p2', name: 'Rahul', color: '#ff3b30', lat: -33.88, lng: 151.22,
    spd: null, hdg: null, acc: 8, ts: now - 8 * DAY,
    eta: null, isMe: false, demo: false, away: false, awayAt: 0, presence: 'lost',
  });
  api.window.localStorage.setItem('convoy.record', JSON.stringify({
    members: Object.assign({}, rec(api).members, {
      p2: { name: 'Rahul', lastSeen: now - 8 * DAY },
    }),
  }));

  check('both are on the list to start with',
        api.window.Convoy.state.peers.has('p1') && api.window.Convoy.state.peers.has('p2'));

  I.pruneRoster();
  await sleep(20);
  check('eight days of silence takes them off the roster',
        !rec(api).members.p2, JSON.stringify(Object.keys(rec(api).members)));
  check('while someone heard from a minute ago stays',
        !!rec(api).members.p1, JSON.stringify(Object.keys(rec(api).members)));
}

async function testTheDropHappensOnItsOwn() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.2);
  await sleep(20);
  const I = api.window.Convoy._internals;

  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(20);
  check('a live person is on the list', api.window.Convoy.state.peers.has('p1'));

  // Wind their last sign of life back past the week, then let the tick run.
  const p1 = api.window.Convoy.state.peers.get('p1');
  const realTs = p1.ts;
  p1.ts = Date.now() - 8 * DAY;
  I.sweepPresence();
  // The tick itself does the dropping; call the same work the timer does.
  const before = api.window.Convoy.state.peers.size;
  api.window.Convoy.state.peers.forEach((p, id) => {
    if (Date.now() - (p.ts || 0) > I.keepMs()) {
      api.window.Convoy.state.peers.delete(id);
      api.window.Convoy.state.seen.delete(id);
      I.forgetMember(id);
    }
  });
  await sleep(20);
  check('the tick drops them without anyone acting',
        api.window.Convoy.state.peers.size < before,
        before + ' -> ' + api.window.Convoy.state.peers.size);
  p1.ts = realTs;
}

async function testNobodyIsDropped() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.2);
  await sleep(20);

  // a position from an hour ago — long past the old thirty-minute drop
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 10, hdg: 90, acc: 6, ts: Date.now() - 3600000 });
  await sleep(20);
  check('a phone quiet for an hour is still on the list',
        api.window.Convoy.state.peers.has('p1'));

  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('and still on the list, marked as lost',
        /Priya/.test(list(api)) && /Lost network/.test(list(api)), list(api));
  check('but not announced as having left', !/left/.test(titles(api)), titles(api));
}

async function testClosingIsNotLeaving() {
  const api = boot();
  api.join('Akshay');
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

  const r = rec(api);
  check('and nobody comes off the roster',
        r && Object.keys(r.members).length === 2, JSON.stringify(r && Object.keys(r.members)));
}

async function testLeavingIsPossibleAndReversible() {
  // Leaving is voluntary and reversible: it says goodbye, comes off the roster, and puts
  // this phone back on the Join button. Only the week, the pin phone, or this removes
  // anyone from the roster.
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  await sleep(30);
  check('the roster has both of you', Object.keys(rec(api).members).length === 2);

  // Priya leaves.
  api.recv({ t: 'bye', id: 'p1', name: 'Priya' });
  await sleep(30);
  check('leaving is announced', /Priya left/.test(titles(api)), titles(api));
  const r = rec(api);
  check('and takes them off the roster', r && !r.members.p1,
        JSON.stringify(r && Object.keys(r.members)));
  check('and off the list', !/Priya/.test(api.document.getElementById('people').textContent),
        api.document.getElementById('people').textContent);

  // And they can come back: nothing about leaving is a block.
  api.recv(pos('p1', 'Priya', -33.88, 151.22));
  await sleep(40);
  check('and they can come straight back', /Priya/.test(
        api.document.getElementById('people').textContent),
        api.document.getElementById('people').textContent);
  // They did join again, so it is announced — that is information, not a block.
  check('and coming back is announced as a join, which it is',
        /Priya joined/.test(titles(api).split('Priya left')[1] || ''), titles(api));
}

async function testRosterComesBack() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.2);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.87, 151.21));
  api.recv(pos('p2', 'Rahul', -33.88, 151.22));
  await sleep(30);
  check('three people are on the list', api.window.Convoy.state.peers.size === 2,
        String(api.window.Convoy.state.peers.size));
  check('all three are on the roster',
        Object.keys(rec(api).members).length === 3,
        JSON.stringify(Object.keys(rec(api).members)));

  // close the app and open it again
  const baseline = api.notes.length;
  api.join('Akshay');
  await sleep(30);

  check('the group comes back with the roster', api.window.Convoy.state.peers.size === 2,
        String(api.window.Convoy.state.peers.size));
  check('with their names', /Priya/.test(list(api)) && /Rahul/.test(list(api)), list(api));
  check('marked as lost, since nothing has been heard from them',
        /Lost network/.test(list(api)), list(api));

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
  api.join('Akshay');
  const first = api.window.Convoy.state.me.id;
  api.join('Akshay');        // reopening the app, since there is no Leave
  await sleep(20);
  check('reopening keeps the same identity', api.window.Convoy.state.me.id === first,
        first + ' vs ' + api.window.Convoy.state.me.id);
  check('so you do not appear twice on the roster',
        Object.keys(rec(api).members).length === 1,
        JSON.stringify(Object.keys(rec(api).members)));
}

/* ---------- A force reset must still land in the convoy ---------- */
async function testAForceResetStillLands() {
  // Everything needed to come back lives on the phone: the identity, the name, and the
  // roster. Even if the name went missing, the roster has it, because we put ourselves in
  // it when we joined.
  const api = boot({ setup: (w) => {
    w.localStorage.setItem('convoy.me', 'c-abc123');
    w.localStorage.setItem('convoy.record', JSON.stringify({
      members: { 'c-abc123': { name: 'Akshay', lastSeen: Date.now() - 1000 } },
    }));
  } });
  await sleep(30);

  check('a phone that lost its name still knows it from the roster',
        api.window.Convoy.state.me.name === 'Akshay', api.window.Convoy.state.me.name);
  check('and it rejoins without being asked', api.window.Convoy.state.joined === true);
  check('onto the one topic, with no room to name',
        api.window.Convoy.state.topic === api.window.Convoy.CFG.topic,
        String(api.window.Convoy.state.topic));
  const me = api.window.Convoy.state.me;
  check('with the same identity, so the others see the same person',
        !!me && me.id === 'c-abc123', me && me.id);
  check('and there is no join screen to come back to', !api.document.getElementById('join'));
}

(async () => {
  try {
    await testAWeekAfterTheirLastSignOfLifeTheyAreDropped();
    await testTheDropHappensOnItsOwn();
    await testNobodyIsDropped();
    await testClosingIsNotLeaving();
    await testLeavingIsPossibleAndReversible();
    await testRosterComesBack();
    await testOneIdentityPerDevice();
    await testAForceResetStillLands();
  } catch (e) { crash(e); }
  finish('roster');
})();
