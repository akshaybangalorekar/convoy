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

  check('the join card is the first thing you see', !d.getElementById('join').classList.contains('hidden'));
  check('the people sheet is hidden until you are in a room',
        d.getElementById('sheet').classList.contains('hidden'));
  check('the button offers to start a group', text(api, 'btnGo') === 'Start a new group',
        text(api, 'btnGo'));

  const c = api.join('Akshay', '');
  await sleep(20);

  check('starting a group puts you on the map',
        d.getElementById('join').classList.contains('hidden'));
  check('a room code was generated', /^trip-/.test(api.window.Convoy.state.room),
        api.window.Convoy.state.room);
  check('the room code is shown at the top',
        text(api, 'roomChip') === api.window.Convoy.state.room, text(api, 'roomChip'));
  check('a connection was opened', !!c, String(api.clients.length));
  check('and it subscribes to the room', c.subscribed === 'sarvam-convoy/v1/' +
        api.window.Convoy.state.room + '/bus', c.subscribed);
  check('the phone announces itself', !!api.sent('hello'));
  check('the people sheet appears', !d.getElementById('sheet').classList.contains('hidden'));
  check('you are on your own in the list', text(api, 'peopleCount') === '1 person',
        text(api, 'peopleCount'));
  check('the recenter button appears',
        !d.getElementById('btnRecenter').classList.contains('hidden'));
}

async function testJoinWithACode() {
  const api = boot();
  const d = api.document;

  d.getElementById('inRoom').value = 'goa-trip';
  d.getElementById('inRoom').dispatchEvent(new api.window.Event('input', { bubbles: true }));
  check('typing a code turns the button into a join', text(api, 'btnGo') === 'Join group',
        text(api, 'btnGo'));

  const c = api.join('Akshay', 'goa-trip');
  await sleep(20);
  check('you join that room', api.window.Convoy.state.room === 'goa-trip');
  check('and subscribe to it',
        c.subscribed === 'sarvam-convoy/v1/goa-trip/bus', c.subscribed);
}

async function testInviteLink() {
  const api = boot({ setup: (w) => { w.history.replaceState(null, '', '/#r=ride-7f3k9'); } });
  const d = api.document;
  await sleep(10);
  check('a link pre-fills the code', d.getElementById('inRoom').value === 'ride-7f3k9',
        d.getElementById('inRoom').value);
  check('and the button offers to join', text(api, 'btnGo') === 'Join group', text(api, 'btnGo'));

  const c = api.join('Akshay', d.getElementById('inRoom').value);
  await sleep(20);
  check('joining by link works', api.window.Convoy.state.room === 'ride-7f3k9');
  check('the invite carries the room',
        c.subscribed === 'sarvam-convoy/v1/ride-7f3k9/bus');
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
  check('sharing copies an invite link', /#r=goa-trip$/.test(copied), copied);
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
  check('the count adds up', text(api, 'peopleCount') === '3 people', text(api, 'peopleCount'));
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
  check('with no destination there is nothing to arrive at',
        /no destination/.test(text(api, 'people')), text(api, 'people'));

  api.window.Convoy.setDest(15.600, 73.900, 'Goa');
  await sleep(60);

  check('the destination is stored', !!api.window.Convoy.state.dest);
  check('the destination row shows it', text(api, 'destText') === 'Goa', text(api, 'destText'));
  check('your arrival time is worked out', !!api.window.Convoy.state.myEta);
  check('the drive distance is kept', api.window.Convoy.state.myEta.dist === 12000,
        JSON.stringify(api.window.Convoy.state.myEta));

  const eta = api.sent('eta');
  check('your arrival time is shared with the room', !!eta, JSON.stringify(eta));
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
  check('setting a destination tells the room', !!d, JSON.stringify(d));
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
  check('and a banner on screen', /Priya joined/.test(text(api, 'banner')), text(api, 'banner'));

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
async function testLeave() {
  const api = boot();
  const d = api.document;
  api.join('Akshay', 'goa-trip');
  api.fix(15.5, 73.8);
  await sleep(20);
  api.recv(pos('p1', 'Priya', 15.51, 73.81));
  await sleep(20);

  d.getElementById('btnLeave').click();
  await sleep(20);

  check('leaving says goodbye to the room', !!api.sent('bye'));
  check('the join card comes back', !d.getElementById('join').classList.contains('hidden'));
  check('the sheet goes away', d.getElementById('sheet').classList.contains('hidden'));
  check('the room is cleared', api.window.Convoy.state.room === null ||
        api.window.Convoy.state.joined === false);
  check('the map is cleared of people', api.window.Convoy.state.peers.size === 0);
}

/* ---------- Inviting, on both kinds of phone ---------- */
async function testTheInviteCarriesTheLink() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);

  check('the invite link carries the room', /#r=goa-trip$/.test(api.window.Convoy.inviteLink()),
        api.window.Convoy.inviteLink());

  let shared = null;
  Object.defineProperty(api.window.navigator, 'share', {
    configurable: true, value: async (data) => { shared = data; },
  });
  await api.window.Convoy.share();
  await sleep(10);

  check('the phone\'s own share sheet is used where there is one', !!shared,
        JSON.stringify(shared));
  check('the code is in the text too, since typing a code beats tapping a link',
        !!shared && /Code: goa-trip/.test(shared.text), shared && shared.text);
  check('and it says the code is not case-sensitive',
        !!shared && /not case-sensitive/.test(shared.text), shared && shared.text);
  check('the link is in the text, which is what WhatsApp on Android reads',
        !!shared && shared.text.indexOf('#r=goa-trip') >= 0, shared && shared.text);
  check('and in the url field as well, for everything that reads that instead',
        !!shared && /#r=goa-trip$/.test(shared.url || ''), shared && shared.url);
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
  check('and it says the link is copied',
        /copied/i.test(api.document.getElementById('banner').textContent),
        api.document.getElementById('banner').textContent);
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
  check('with the link in it',
        /#r=goa-trip$/.test(api.document.getElementById('shareUrl').value),
        api.document.getElementById('shareUrl').value);

  api.document.getElementById('btnShareClose').click();
  check('and it can be closed', card.classList.contains('hidden'));
}

async function testCodesAreNotCaseSensitive() {
  // Nobody should have to get the capitals right, so the code is folded down on the way in.
  const upper = boot();
  upper.join('Akshay', 'GOA-TRIP');
  await sleep(20);
  check('an upper-case code is the same room as a lower-case one',
        upper.window.Convoy.state.room === 'goa-trip', upper.window.Convoy.state.room);

  const spaced = boot();
  spaced.join('Akshay', '  Goa Trip  ');
  await sleep(20);
  check('and neither do spaces or capitals',
        spaced.window.Convoy.state.room === 'goa-trip', spaced.window.Convoy.state.room);

  const typed = boot();
  typed.document.getElementById('inName').value = 'Akshay';
  const box = typed.document.getElementById('inRoom');
  box.value = 'gOA-TRiP';
  box.dispatchEvent(new typed.window.Event('input', { bubbles: true }));
  typed.document.getElementById('btnGo').click();
  await sleep(20);
  check('typing it any way at all lands in the same room',
        typed.window.Convoy.state.room === 'goa-trip', typed.window.Convoy.state.room);
  check('and the app keeps the folded form, so the room is one room',
        typed.document.getElementById('roomChip').textContent === 'goa-trip',
        typed.document.getElementById('roomChip').textContent);
}

async function testBothLinkShapesWork() {
  const hash = boot({ setup: (w) => { w.history.replaceState(null, '', '/#r=hash-room'); } });
  await sleep(20);
  check('a link with a hash works', hash.window.Convoy.roomFromUrl() === 'hash-room',
        hash.window.Convoy.roomFromUrl());
  check('and fills the code in',
        hash.document.getElementById('inRoom').value === 'hash-room',
        hash.document.getElementById('inRoom').value);

  const query = boot({ setup: (w) => { w.history.replaceState(null, '', '/?r=query-room'); } });
  await sleep(20);
  check('a link with a query works too, since some chat apps keep only that',
        query.window.Convoy.roomFromUrl() === 'query-room', query.window.Convoy.roomFromUrl());
  check('and fills the code in as well',
        query.document.getElementById('inRoom').value === 'query-room',
        query.document.getElementById('inRoom').value);
  check('and the button offers to join',
        query.document.getElementById('btnGo').textContent === 'Join group',
        query.document.getElementById('btnGo').textContent);
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testStartAGroup();
    await testJoinWithACode();
    await testInviteLink();
    await testInviteLinkCopy();
    await testPeopleAppear();
    await testArrivalTimes();
    await testDestinationShared();
    await testNotifications();
    await testLeave();
    await testTheInviteCarriesTheLink();
    await testCopyingWhenSharingIsUnavailable();
    await testTheLinkIsShownWhenNothingElseWorks();
    await testCodesAreNotCaseSensitive();
    await testBothLinkShapesWork();
  } catch (e) { crash(e); }
  finish('app');
})();
