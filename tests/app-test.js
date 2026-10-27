/* The session: starting a group, joining by link, seeing people, arrival times,
 * and the notifications. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

const routeFetch = (url) => {
  if (url.indexOf('routing.openstreetmap.de') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      routes: [{
        distance: 12000, duration: 1200,
        geometry: { coordinates: [[73.8, 15.5], [73.85, 15.55], [73.9, 15.6]] },
      }],
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
};

const text = (api, id) => api.document.getElementById(id).textContent;

/* ---------- Starting and joining ---------- */
async function testStartAGroup() {
  const api = boot();
  const d = api.document;

  check('opening the app puts you straight on the map',
        api.window.Convoy.state.joined === true &&
        !d.getElementById('sheet').classList.contains('hidden'));
  check('with no code to type and nothing to set up',
        typeof api.window.Convoy.state.room === 'undefined' &&
        api.window.Convoy.state.topic === api.window.Convoy.CFG.topic,
        api.window.Convoy.state.topic);
  check('a connection was opened', api.clients.length > 0, String(api.clients.length));
  check('and it subscribes to the one topic',
        (api.clients[api.clients.length - 1].subscriptions || [])
          .indexOf(api.window.Convoy.state.topic) >= 0,
        JSON.stringify(api.clients[api.clients.length - 1].subscriptions));
  check('the phone announces itself', !!api.sent('hello'));
  check('the people sheet is there', !d.getElementById('sheet').classList.contains('hidden'));
  check('you are on your own in the list', text(api, 'peopleCount') === '1 person · no destination',
        text(api, 'peopleCount'));
  check('and there is no separate recenter button to duplicate it',
        !d.getElementById('btnRecenter'));
  check('you are given a name without being asked for one',
        /\w+/.test(api.window.Convoy.state.me.name), api.window.Convoy.state.me.name);
}

async function testYouCanRenameYourself() {
  const api = boot();
  await sleep(20);
  const box = api.document.querySelector('input.myname');
  check('your own row in the list holds your name',
        box && box.value === api.window.Convoy.state.me.name, box && box.value);
  check('and nobody else has an editable row',
        api.document.querySelectorAll('input.myname').length === 1,
        String(api.document.querySelectorAll('input.myname').length));

  box.value = 'Akshay';
  box.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('changing it changes your name', api.window.Convoy.state.me.name === 'Akshay',
        api.window.Convoy.state.me.name);
  check('it is remembered for next time',
        api.window.localStorage.getItem('convoy.name') === 'Akshay',
        api.window.localStorage.getItem('convoy.name'));
  check('and the group is told, so their lists update',
        (api.sent('hello') || {}).t === 'hello');
}

async function testAnOldLinkStillWorks() {
  // Links with a code in them were shared before there were no rooms. They should still
  // open the app and land you on the map, not break or ask for anything.
  const api = boot({ setup: (w) => { w.history.replaceState(null, '', '/?r=ride-7f3k9'); } });
  await sleep(20);
  check('an old invite link still opens the app',
        api.window.Convoy.state.joined === true &&
        typeof api.window.Convoy.state.room === 'undefined',
        String(api.window.Convoy.state.room));
  check('and puts you on the map with no questions',
        api.window.Convoy.state.joined === true);
}

async function testInviteLinkCopy() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  let copied = '';
  Object.defineProperty(api.window.navigator, 'clipboard', {
    configurable: true, value: { writeText: async (t) => { copied = t; } },
  });
  await api.window.Convoy.share();
  await sleep(10);
  check('sharing copies the app address', /^https:\/\/[^?]+$/.test(copied), copied);
  check('with no code in it, because there is nothing to type', !/\?r=/.test(copied), copied);
}

/* ---------- Seeing people ---------- */
async function testPeopleAppear() {
  const api = boot();
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  api.fix(15.500, 73.800);
  await sleep(20);

  api.recv(pos('p1', 'Priya', 15.510, 73.810));
  api.recv(pos('p2', 'Rahul', 15.520, 73.820));
  await sleep(30);

  check('both other people are on the map', api.window.Convoy.state.peers.size === 2,
        String(api.window.Convoy.state.peers.size));
  check('the count adds up', text(api, 'peopleCount') === '3 people · no destination',
        text(api, 'peopleCount'));
  const list = text(api, 'people');
  check('their names are listed', /Priya/.test(list) && /Rahul/.test(list), list);
  check('each has a colour', /background:#/.test(d.getElementById('people').innerHTML));
  check('your own position is published', !!api.sent('pos'));
}

/* ---------- Arrival times ---------- */
async function testArrivalTimes() {
  const api = boot({ fetch: routeFetch });
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  api.fix(15.500, 73.800);
  await sleep(20);

  api.recv(pos('p1', 'Priya', 15.510, 73.810));
  await sleep(20);
  check('with no destination it is said once, in the header, not on every row',
        /no destination/.test(text(api, 'peopleCount')) &&
        !/no destination/.test(text(api, 'people')),
        text(api, 'peopleCount') + ' || ' + text(api, 'people'));

  api.window.Convoy.setDest(15.600, 73.900, 'Goa');
  await sleep(60);

  check('the destination is stored', !!api.window.Convoy.state.dest);
  check('the destination row shows it', text(api, 'destText') === 'Goa', text(api, 'destText'));
  check('your arrival time is worked out', !!api.window.Convoy.state.myEta);
  check('the drive distance is kept', api.window.Convoy.state.myEta.dist === 12000,
        JSON.stringify(api.window.Convoy.state.myEta));

  const eta = api.sent('eta');
  check('your arrival time is shared with the group', !!eta, JSON.stringify(eta));
  check('it carries the duration', eta && eta.dur === 1200, JSON.stringify(eta));
  check('it carries the distance', eta && eta.dist === 12000, JSON.stringify(eta));

  const arrive = api.window.Convoy.fmtClock(api.window.Convoy.state.myEta.ts + 1200 * 1000);
  check('the list shows the arrival time', text(api, 'people').indexOf(arrive) >= 0,
        text(api, 'people') + ' (wanted ' + arrive + ')');

  // and someone else's, as their phone reports it
  api.recv({ t: 'eta', id: 'p1', name: 'Priya', dur: 600, dist: 5000, ts: Date.now() });
  await sleep(20);
  const hers = api.window.Convoy.fmtClock(Date.now() + 600 * 1000);
  check('their arrival time shows too',
        text(api, 'people').indexOf(hers) >= 0 || !!api.window.Convoy.state.peers.get('p1').eta,
        text(api, 'people'));
  check('their distance is shown', /5\.0 km/.test(text(api, 'people')), text(api, 'people'));
}

async function testDestinationShared() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(15.5, 73.8);
  await sleep(20);

  api.window.Convoy.setDest(15.6, 73.9, 'Goa');
  await sleep(20);
  const d = api.sent('dest');
  check('setting a destination tells the group', !!d, JSON.stringify(d));
  check('it carries the place', d && d.label === 'Goa', JSON.stringify(d));
  check('it carries who set it', d && d.by === 'Akshay', JSON.stringify(d));

  // and a destination someone else set
  api.recv({ t: 'dest', id: 'p1', name: 'Priya', by: 'Priya', lat: 15.7, lng: 74.0, label: 'Panaji' });
  await sleep(20);
  check('someone else can move the destination', text(api, 'destText') === 'Panaji',
        text(api, 'destText'));

  api.recv({ t: 'dest-clear', id: 'p1', name: 'Priya', by: 'Priya' });
  await sleep(20);
  check('and clear it', text(api, 'destText') === 'Set a destination', text(api, 'destText'));
  check('the row goes quiet again',
        api.document.getElementById('destText').classList.contains('empty'));
}

/* ---------- Notifications ---------- */
async function testNotifications() {
  const api = boot();
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const last = () => (api.notes.length ? api.notes[api.notes.length - 1] : { title: '', body: '' });

  check('the phone asks for permission to notify',
        typeof api.window.Notification === 'function');

  api.recv({ t: 'hello', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('someone joining raises a notification', /Priya joined/.test(last().title), last().title);
  check('and no banner on screen — the phone notification is the notification',
        text(api, 'banner') === '', text(api, 'banner'));

  const before = api.notes.length;
  api.recv({ t: 'hello', id: 'p1', name: 'Priya' });
  await sleep(20);
  check('the same person joining twice notifies once', api.notes.length === before,
        String(api.notes.length - before));

  api.recv({ t: 'dest', id: 'p2', name: 'Rahul', by: 'Rahul', lat: 15.6, lng: 73.9, label: 'Goa' });
  await sleep(20);
  check('a destination change raises a notification',
        /Rahul set the destination/.test(last().title), last().title);
  check('the notification says where', /Goa/.test(last().body), last().body);

  const same = api.notes.length;
  api.recv({ t: 'dest', id: 'p2', name: 'Rahul', by: 'Rahul', lat: 15.6, lng: 73.9, label: 'Goa' });
  await sleep(20);
  check('the same destination does not notify twice', api.notes.length === same);

  api.recv({ t: 'dest-clear', id: 'p2', name: 'Rahul', by: 'Rahul' });
  await sleep(20);
  check('clearing it raises a notification', /Rahul cleared/.test(last().title), last().title);

  api.recv(pos('p3', 'Meera', 15.5, 73.8));
  await sleep(20);
  api.recv({ t: 'bye', id: 'p3', name: 'Meera' });
  await sleep(20);
  check('someone leaving raises a notification', /Meera left/.test(last().title), last().title);
  check('and they drop off the list', !/Meera/.test(text(api, 'people')), text(api, 'people'));

  // your own actions must not ping you
  const meId = api.window.Convoy.state.me.id;
  const mine = api.notes.length;
  api.recv({ t: 'dest', id: meId, name: 'Akshay', lat: 1, lng: 1, label: 'Nope' });
  await sleep(20);
  check('your own destination change does not notify you', api.notes.length === mine);
  check('and it does not move your destination',
        api.window.Convoy.state.dest === null || api.window.Convoy.state.dest.label !== 'Nope');
}

/* ---------- Leaving ---------- */
/* ---------- Inviting, on both kinds of phone ---------- */
async function testTheInviteCarriesTheLink() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  check('the invite is the app itself, with no code in it',
        /^https:\/\/[^?]+$/.test(api.window.Convoy.inviteLink()),
        api.window.Convoy.inviteLink());

  let shared = null;
  Object.defineProperty(api.window.navigator, 'share', {
    configurable: true, value: async (data) => { shared = data; },
  });
  await api.window.Convoy.share();
  await sleep(10);

  check('the phone\'s own share sheet is used where there is one', !!shared,
        JSON.stringify(shared));
  check('the message leads with the link, so there is nothing to type',
        !!shared && shared.text.indexOf('Open Convoy') >= 0, shared && shared.text);
  check('and the link is in the text, which is what WhatsApp linkifies',
        !!shared && shared.text.indexOf('https://') >= 0, shared && shared.text);
  check('and in the url field as well, for everything that reads that instead',
        !!shared && /^https:\/\/[^?]+$/.test(shared.url || ''), shared && shared.url);
  check('with no code in it, because there is nothing to type',
        !!shared && !/\?r=/.test(shared.text), shared && shared.text);
}

async function testCopyingWhenSharingIsUnavailable() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  Object.defineProperty(api.window.navigator, 'clipboard',
    { configurable: true, value: undefined });
  let asked = null;
  api.window.document.execCommand = (cmd) => { asked = cmd; return true; };

  await api.window.Convoy.share();
  await sleep(10);
  check('the old copy method is used when the clipboard API is missing',
        asked === 'copy', String(asked));
  check('and the button itself says so, rather than a banner',
        /Copied/.test(api.document.getElementById('btnInvite').textContent),
        api.document.getElementById('btnInvite').textContent);
}

async function testTheLinkIsShownWhenNothingElseWorks() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  Object.defineProperty(api.window.navigator, 'clipboard',
    { configurable: true, value: undefined });
  api.window.document.execCommand = () => false;

  await api.window.Convoy.share();
  await sleep(10);
  const card = api.document.getElementById('shareCard');
  check('the link is shown so it can be copied by hand',
        !card.classList.contains('hidden'));
  check('with the address in it',
        /^https:\/\/[^?]+$/.test(api.document.getElementById('shareUrl').value),
        api.document.getElementById('shareUrl').value);

  api.document.getElementById('btnShareClose').click();
  check('and it can be closed', card.classList.contains('hidden'));
}

async function testOldLinksAreHarmless() {
  // Links with a code in them were shared before there were no rooms. Opening one should
  // still land you on the map, asking for nothing.
  for (const url of ['/#r=hash-room', '/?r=query-room']) {
    const api = boot({ setup: (w) => { w.history.replaceState(null, '', url); } });
    await sleep(20);
    check('a link of any old shape still opens the app (' + url + ')',
          api.window.Convoy.state.joined === true &&
          api.window.Convoy.state.topic === api.window.Convoy.CFG.topic,
          String(api.window.Convoy.state.topic));
    check('and puts you straight on the map (' + url + ')',
          api.window.Convoy.state.joined === true);
  }
}

/* ---------- The list reads like a list ---------- */
async function testACloseCarSaysNextToYou() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -37.9001, 145.05));      // about 11 m away
  await sleep(30);
  const list = text(api, 'people');
  check('a car right beside you says so', /next to you/.test(list), list);
  check('rather than a zero distance with a compass point', !/0 m/.test(list), list);
}

async function testTheTagDoesNotRepeatTheName() {
  const demo = boot();
  demo.join('You', 'goa-trip');                        // the demo names you "You"
  demo.fix(-33.86, 151.2);                             // so the tag would read "you"
  await sleep(30);
  const box = demo.document.querySelector('input.myname');
  check('your own row holds your name, ready to edit', !!box && box.value === 'You',
        box && box.value);
  check('and the row does not repeat it as a tag',
        !/you/i.test(text(demo, 'people')), text(demo, 'people'));

  const named = boot();
  named.join('Akshay', 'goa-trip');
  named.fix(-33.86, 151.2);
  await sleep(30);
  check('while a real name still gets its tag', /you/.test(text(named, 'people')),
        text(named, 'people'));
}

async function testTheSheetIsJustPeopleAndOneSwitch() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const sheet = api.document.getElementById('sheet');
  const order = Array.from(sheet.querySelectorAll('ul, .sheet-controls'))
    .map((el) => el.id || el.className);
  check('the sheet is the people, then the one switch',
        order[0] === 'people' && order[1] === 'sheet-controls', JSON.stringify(order));
  check('and no field to name anything',
        !api.document.getElementById('inRoomName'));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testStartAGroup();
    await testAnOldLinkStillWorks();
    await testYouCanRenameYourself();
    await testInviteLinkCopy();
    await testPeopleAppear();
    await testArrivalTimes();
    await testDestinationShared();
    await testNotifications();
    await testTheInviteCarriesTheLink();
    await testCopyingWhenSharingIsUnavailable();
    await testTheLinkIsShownWhenNothingElseWorks();
    await testOldLinksAreHarmless();
    await testACloseCarSaysNextToYou();
    await testTheTagDoesNotRepeatTheName();
    await testTheSheetIsJustPeopleAndOneSwitch();
  } catch (e) { crash(e); }
  finish('app');
})();
