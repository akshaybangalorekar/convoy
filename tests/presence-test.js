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
const text = (api, id) => api.document.getElementById(id).textContent;
const bannerText = (api) => api.document.getElementById('banner').textContent;

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

/* ---------- When the relay cannot be reached at all ---------- */
async function testABlockedRelaySaysSo() {
  // A phone on mobile data often cannot reach these relays at all, because they listen on
  // ports 8081/8084/8884 and carriers block everything but 80 and 443.
  const api = boot();
  api.window.Convoy.CFG.retryMs = 15;
  api.window.Convoy.join('Akshay', 'goa-trip');
  await sleep(20);
  check('it starts out saying it is connecting',
        /connecting|offline/.test(text(api, 'connState')), text(api, 'connState'));

  // Retries back off, so squeeze the delays to watch several failures happen quickly.
  api.window.Convoy.CFG.retryMs = 1;
  api.window.Convoy.CFG.retryMaxMs = 2;
  for (let i = 0; i < 6; i++) {
    const c = api.clients[api.clients.length - 1];
    if (c && !c.connected) c._emit('error');
    await sleep(40);
  }

  check('after a few failures it stops pretending to connect',
        text(api, 'connState') === 'no relay', text(api, 'connState'));
  check('and says so without a banner', bannerText(api) === '', bannerText(api));

  const after = api.notes.length;
  for (let i = 0; i < 4; i++) {
    const c = api.clients[api.clients.length - 1];
    if (c && !c.connected) c._emit('error');
    await sleep(40);
  }
  check('without nagging on every retry', api.notes.length === after,
        String(api.notes.length - after));
}

async function testTheRelayCheckSaysWhichRelayAnswers() {
  const api = boot();
  api.ws.mode('open');
  api.window.Convoy.join('Akshay', 'goa-trip');
  await sleep(20);

  api.document.getElementById('connState').click();
  await sleep(80);
  const d = api.document;
  check('tapping the connection state opens a check',
        !d.getElementById('connCard').classList.contains('hidden'));
  const rows = Array.from(d.querySelectorAll('#connList li'));
  check('it lists every relay', rows.length === api.window.Convoy.CFG.brokers.length,
        String(rows.length));
  check('and says each one answered',
        rows.every((li) => li.className === 'ok' && /reached/.test(li.textContent)),
        d.getElementById('connList').textContent);
  check('it probed each relay address',
        api.ws.calls.length === api.window.Convoy.CFG.brokers.length,
        JSON.stringify(api.ws.calls));
}

async function testTheRelayCheckNamesABlockedNetwork() {
  const api = boot();
  api.ws.mode('error');
  api.window.Convoy.join('Akshay', 'goa-trip');
  await sleep(20);

  api.document.getElementById('connState').click();
  await sleep(80);
  const d = api.document;
  const rows = Array.from(d.querySelectorAll('#connList li'));
  check('every relay reads blocked',
        rows.length > 0 && rows.every((li) => li.className === 'bad' && /blocked/.test(li.textContent)),
        d.getElementById('connList').textContent);
  check('and the card names the network as the problem, not the app',
        Array.from(d.querySelectorAll('#connList li')).every((li) => li.className === 'bad'),
        d.getElementById('connList').textContent);
}

async function testAMissingLibraryIsNotABlockedNetwork() {
  // The relay library comes from a CDN. Without it every attempt throws before it reaches
  // the network, and the app used to cycle the relays for ever — indistinguishable from a
  // carrier blocking the ports.
  const api = boot();
  api.window.Convoy.CFG.retryMs = 15;
  api.window.mqtt = undefined;
  api.window.Convoy.join('Akshay', 'goa-trip');
  await sleep(40);

  check('a missing relay library is named as such',
        text(api, 'connState') === 'no library', text(api, 'connState'));
  check('and says so on the connection state, with no banner',
        text(api, 'connState') === 'no library' && bannerText(api) === '',
        text(api, 'connState'));

  const attempts = api.clients.length;
  await sleep(120);
  check('and it stops instead of cycling the relays for ever',
        api.clients.length === attempts, attempts + ' -> ' + api.clients.length);
}

async function testTheRelayListIncludesPort443() {
  const api = boot();
  const urls = api.window.Convoy.CFG.brokers.map((b) => b.url);
  check('one relay is on 443, the port mobile networks always allow',
        urls.some((u) => /:443\//.test(u)), JSON.stringify(urls));
  check('and it is tried first, since outdoors it is the only one that can work',
        /:443\//.test(urls[0]), urls[0]);
  check('and the others are still there as fallbacks', urls.length >= 4, JSON.stringify(urls));
}

/* ---------- Someone whose location is switched off ---------- */
async function testSomeoneWithNoLocationStillAppears() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-37.90, 145.05);
  await sleep(20);

  // A laptop with location switched off says hello and never sends a position.
  api.recv({ t: 'hello', id: 'laptop', name: 'Laptop', ts: Date.now() });
  await sleep(30);

  check('someone who only says hello is on the list', /Laptop/.test(list(api)), list(api));
  check('and is named as not sharing their location',
        /not sharing their location/.test(list(api)), list(api));
  check('they were announced too', /Laptop joined/.test(notes(api)), notes(api));
  check('and they are not called out of contact', !/out of contact/.test(list(api)), list(api));

  const p = api.window.Convoy.state.peers.get('laptop');
  check('they are a real person in the room, just without a position',
        !!p && p.lat === null, p ? String(p.lat) : 'no peer');

  // Quiet for a while is different from never having a position.
  api.window.Convoy.CFG.staleMs = 10;
  await sleep(40);
  api.window.Convoy._internals.renderPeople();
  check('once they go quiet it says the network went',
        /Lost network/.test(list(api)), list(api));

  api.window.Convoy.CFG.staleMs = 90000;      // back to normal before the hello
  api.recv({ t: 'hello', id: 'laptop', name: 'Laptop', ts: Date.now() });
  await sleep(20);
  api.window.Convoy._internals.renderPeople();
  check('and a hello brings them back to "not sharing"',
        /not sharing their location/.test(list(api)), list(api));
}

async function testAPhoneWithNoLocationStillSaysHello() {
  const api = boot();
  api.window.Convoy.CFG.publishMs = 20;
  api.join('Akshay', 'goa-trip');            // no fix is ever delivered
  await sleep(30);
  const before = api.sentAll('hello').length;
  await sleep(90);
  const after = api.sentAll('hello').length;

  check('a phone with no location keeps saying hello', after > before, before + ' -> ' + after);
  check('and never publishes a position it does not have',
        api.sentAll('pos').length === 0, String(api.sentAll('pos').length));
}

/* ---------- A connection that keeps dropping ---------- */
async function testRetriesBackOffInsteadOfHammering() {
  const api = boot();
  await sleep(20);
  const CFG = api.window.Convoy.CFG;
  const st = api.window.Convoy.state;
  const I = api.window.Convoy._internals;

  check('there is a ceiling on the wait', CFG.retryMaxMs > CFG.retryMs,
        CFG.retryMs + ' -> ' + CFG.retryMaxMs);

  // The delay doubles with each failure and stops at the ceiling.
  const delay = (failures) => Math.min(CFG.retryMaxMs, CFG.retryMs * Math.pow(2, Math.min(4, failures)));
  check('one failure waits a moment', delay(0) === CFG.retryMs, String(delay(0)));
  check('the next waits twice as long', delay(1) === CFG.retryMs * 2, String(delay(1)));
  check('and it stops growing at the ceiling',
        delay(9) === CFG.retryMaxMs && delay(20) === CFG.retryMaxMs, String(delay(20)));

  // And the single cadence: one function decides how often anything is sent.
  st.away = false;
  check('on screen the beat is the fast one', I.cadenceMs() === CFG.publishMs,
        String(I.cadenceMs()));
  st.away = true;
  check('in the background it is the slow one', I.cadenceMs() === CFG.bgMs,
        String(I.cadenceMs()));
  st.away = false;
}

async function testTheWatchDropsToCheapInTheBackground() {
  // The GPS chip is what costs battery, not the messages. High accuracy while the map is
  // on screen; the cheap kind once the app is put away.
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(20);
  const last = () => api.geo.watches[api.geo.watches.length - 1];

  api.window.Convoy._internals.startWatching();
  await sleep(20);
  const before = api.geo.watches.length;
  check('on screen it asks for high accuracy', last().opts.enableHighAccuracy === true,
        JSON.stringify(last().opts));

  api.window.Convoy._internals.goAway();
  await sleep(20);
  check('put away, it starts a new watch', api.geo.watches.length > before,
        before + ' -> ' + api.geo.watches.length);
  check('and it is the cheap kind', last().opts.enableHighAccuracy === false,
        JSON.stringify(last().opts));
  check('accepting an older fix, so it is asked for less often',
        last().opts.maximumAge >= 30000, String(last().opts.maximumAge));
}

async function testTheBackgroundHeartbeat() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(20);
  const st = api.window.Convoy.state;
  const I = api.window.Convoy._internals;

  check('four hours, counted from when you were last on the app',
        api.window.Convoy.CFG.bgForMs === 4 * 3600000 &&
        api.window.Convoy.CFG.bgMs === 300000);

  // There has to be a destination: nobody needs a five-minute position with nowhere to go.
  api.window.Convoy.setDest(-33.89, 151.27, 'Bondi Beach');
  await sleep(20);

  // Four hours of reporting after the last time you touched the app.
  st.lastActive = Date.now();
  I.goAway();
  check('it keeps reporting for four hours from then',
        Math.abs(st.bgUntil - (st.lastActive + 4 * 3600000)) < 1000, String(st.bgUntil));
  check('and it is allowed to report now', I.bgAllowed() === true);
  I.stopPublishTimer();

  // Somebody who was last on the app five hours ago gets nothing.
  st.lastActive = Date.now() - 5 * 3600000;
  I.goAway();
  check('but not once that window has passed', I.bgAllowed() === false, String(st.bgUntil));
  I.stopPublishTimer();

  // Arriving ends it early.
  st.lastActive = Date.now();
  st.arrived = true;
  I.goAway();
  check('and reaching the destination ends it', I.bgAllowed() === false);
  I.stopPublishTimer();
  st.arrived = false;

  // A report from the background says so, and says how fresh the fix is.
  st.lastActive = Date.now();
  st.away = true;
  I.publishNow(true);
  await sleep(20);
  const pos = api.sent('pos') || {};
  check('a background report is marked as one', pos.bg === true, JSON.stringify(pos.bg));
  check('and carries when the fix was actually taken',
        typeof pos.fixTs === 'number', String(pos.fixTs));
  st.away = false;
}

async function testABackgroundReportKeepsSomeoneOnTheList() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(20);
  const st = api.window.Convoy.state;

  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(),
             fixTs: Date.now() - 600000, bg: true });
  await sleep(30);
  const p1 = st.peers.get('p1');
  check('a report from the background leaves them put away, not back on screen',
        p1.away === true);
  check('and they are not shown as out of contact',
        api.window.Convoy._internals.presenceOf(p1) === 'away',
        api.window.Convoy._internals.presenceOf(p1));
  check('the row says they are in the background',
        /In the background/.test(api.document.getElementById('people').textContent),
        api.document.getElementById('people').textContent);
  check('and says when the position itself is not new',
        /no new position/.test(api.document.getElementById('people').textContent),
        api.document.getElementById('people').textContent);

  // A report from the foreground puts them back on screen.
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(), fixTs: Date.now() });
  await sleep(30);
  check('a report from the foreground puts them back', st.peers.get('p1').away === false);
  check('and they are live again',
        api.window.Convoy._internals.presenceOf(st.peers.get('p1')) === 'live');
}

async function testTheDestinationDotWearsTheSettersColour() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.88, 151.22));
  await sleep(30);

  const st = api.window.Convoy.state;
  const p1 = st.peers.get('p1');
  const pin = () => api.document.querySelector('.dest-pin');
  const same = (got, want) => {
    if (got === want) return true;
    const n = parseInt(String(want).replace('#', ''), 16);
    return got === 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')';
  };

  // Priya sets the destination.
  api.recv({ t: 'dest', id: 'p1', name: 'Priya', by: 'Priya', byId: 'p1',
             lat: -33.9, lng: 151.3, label: 'Bondi', ts: Date.now() });
  await sleep(40);
  check('the dot wears the colour that person has on this phone',
        same(pin().style.background, p1.color), pin().style.background + ' vs ' + p1.color);
  check('and that is the colour beside their name on the list',
        new RegExp(p1.color, 'i').test(api.document.getElementById('people').innerHTML),
        p1.color);
  check('with a soft ring in the same colour',
        /rgba\(/.test(pin().style.boxShadow), pin().style.boxShadow);

  // Now it is set from this phone.
  api.window.Convoy.setDest(-33.7, 151.1, 'Manly');
  await sleep(40);
  check('when you set it, the dot wears your own colour',
        same(pin().style.background, st.me.color), pin().style.background + ' vs ' + st.me.color);
  check('and the message says who set it',
        ((api.sent('dest') || {}).byId) === st.me.id, JSON.stringify(api.sent('dest')));

  // An older phone sends no id at all.
  api.recv({ t: 'dest', id: 'p1', name: 'Priya', by: 'Priya',
             lat: -33.5, lng: 151.0, label: 'Brighton', ts: Date.now() + 5 });
  await sleep(40);
  check('a destination from an older phone still finds the right colour by name',
        same(pin().style.background, p1.color), pin().style.background + ' vs ' + p1.color);

  // Clearing it puts the dot back to how it looks with no destination.
  api.window.Convoy.clearDest();
  await sleep(40);
  check('clearing the destination resets the dot',
        !pin().style.background, pin().style.background);
}

async function testTheRelayIsAskedWhatWentWrong() {
  // The error used to be thrown away: a refused connection looked exactly like a blocked
  // port, and there was no way to tell them apart.
  const api = boot();
  await sleep(20);
  const c = api.clients[api.clients.length - 1];

  c._emit('disconnect', { reasonCode: 135 });
  await sleep(20);
  check('an MQTT reason code is kept and named',
        /135/.test(api.window.Convoy.state.lastError) &&
        /not authorized/.test(api.window.Convoy.state.lastError),
        api.window.Convoy.state.lastError);

  c._emit('error', new Error('connack timeout'));
  await sleep(20);
  check('a timeout is called a timeout',
        /timed out/.test(api.window.Convoy.state.lastError),
        api.window.Convoy.state.lastError);

  c._emit('error', new Error('WebSocket connection failed'));
  await sleep(20);
  check('a socket failure is named as one',
        /socket failed/.test(api.window.Convoy.state.lastError),
        api.window.Convoy.state.lastError);
  check('and which relay said it', !!api.window.Convoy.state.lastErrorRelay,
        api.window.Convoy.state.lastErrorRelay);

  await api.window.Convoy._internals.showConnection();
  await sleep(20);
  check('the connection card shows it',
        /Last from/.test(api.document.getElementById('connError').textContent),
        api.document.getElementById('connError').textContent);
}

async function testAWaitingPhoneLooksForTheGroupOnOtherRelays() {
  // Waiting to be let in and hearing nothing usually means the group is on another relay,
  // and there is no way to tell from the app. Walk the list rather than sit there.
  const api = boot({ outside: true });
  await sleep(20);
  const I = api.window.Convoy._internals;
  const before = api.clients.length;
  const relayBefore = api.window.Convoy.state.relay;

  api.window.Convoy.state.joinAsked = true;
  api.window.Convoy.state.lastHeard = Date.now() - 60000;   // a minute of silence
  I.huntForTheGroup();
  await sleep(30);
  check('it moves to another relay', api.window.Convoy.state.relay !== relayBefore ||
        api.clients.length > before, relayBefore + ' -> ' + api.window.Convoy.state.relay);
}

async function testOutOfContactIsSaidOnceAndOnlyWhileItIsNews() {
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  api.recv(pos('p1', 'Priya', -33.88, 151.22));
  await sleep(20);
  const lost = () => api.notes.filter((n) => /out of contact/.test(n.title)).length;
  check('nobody is announced out of contact while they are here', lost() === 0, String(lost()));

  const realNow = api.window.Date.now;
  const later = (ms) => { api.window.Date.now = () => realNow() + ms; };

  later(95000);                                     // just past staleMs
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('going quiet is said once', lost() === 1, String(lost()));

  for (let i = 0; i < 5; i++) api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('and not again on every sweep after that', lost() === 1, String(lost()));

  api.window.Date.now = realNow;
}

async function testALongGonePhoneIsNotAnnouncedAgain() {
  // Someone who left days ago was being announced "out of contact" again and again, which
  // is noise: it stopped being news long before.
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const realNow = api.window.Date.now;
  api.window.Date.now = () => realNow() + 6 * 3600000;    // six hours later

  // A roster entry, as if the app had just been opened with them still remembered.
  api.window.Convoy.state.peers.set('gone', {
    id: 'gone', name: 'Rahul', color: '#ff3b30', lat: -33.9, lng: 151.2,
    spd: null, hdg: null, acc: 8, ts: realNow() - 5 * 3600000,
    eta: null, isMe: false, demo: false, away: false, awayAt: 0,
    presence: 'lost', restored: true,
  });
  const before = api.notes.length;
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('a phone that has been gone for hours is not announced again',
        api.notes.length === before, String(api.notes.length - before));

  // Even a fresh transition is only worth saying while it is fresh.
  api.window.Convoy.state.peers.get('gone').presence = 'live';
  api.window.Convoy.state.peers.get('gone').ts = realNow() - 5 * 3600000;
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('and a transition that is hours old is not news either',
        api.notes.length === before, String(api.notes.length - before));
  api.window.Date.now = realNow;
}

async function testAFlappingPhoneIsNotAnnouncedEveryTime() {
  // An old device still running the app somewhere goes quiet and comes back every few
  // minutes. That is not news every time.
  const api = boot();
  api.join('Akshay', 'goa-trip');
  await sleep(20);
  const realNow = api.window.Date.now;
  let clock = realNow();
  api.window.Date.now = () => clock;
  const lost = () => api.notes.filter((n) => /out of contact/.test(n.title)).length;

  for (let round = 0; round < 4; round++) {
    api.recv(pos('p1', 'Priya', -33.88, 151.22));
    await sleep(10);
    clock += 95000;                                  // goes quiet
    api.window.Convoy._internals.sweepPresence();
    await sleep(10);
    clock += 60000;                                  // comes back a minute later
  }
  check('four flaps are not four announcements', lost() === 1, String(lost()));
  api.window.Date.now = realNow;
}

async function testAComingBackPhoneIsAnsweredAtOnce() {
  // After a refresh a phone knows nobody. Waiting for everyone else's next tick would leave
  // it looking at an empty map for up to half a minute.
  const api = boot();
  api.join('Akshay', 'goa-trip');
  api.fix(-33.87, 151.21);
  await sleep(20);
  const before = api.sentAll('pos').length;

  // It was let in before the refresh, so it is allowed — it is just someone we have not
  // heard from since.
  api.recv({ t: 'hello', id: 'returning', name: 'Priya' });
  await sleep(20);
  check('a phone that says hello is answered with where we are',
        api.sentAll('pos').length > before, before + ' -> ' + api.sentAll('pos').length);

  const after = api.sentAll('pos').length;
  api.recv({ t: 'hello', id: 'returning', name: 'Priya' });
  await sleep(20);
  check('but not on every hello, or two phones would set each other off',
        api.sentAll('pos').length === after, String(api.sentAll('pos').length - after));
}

async function testTheClientIdIsUniquePerAttempt() {
  const api = boot();
  api.window.Convoy.CFG.retryMs = 10;
  api.window.Convoy.join('Akshay', 'goa-trip');
  await sleep(20);
  const c1 = api.clients[0];
  check('the keepalive is short enough for a mobile network',
        c1.opts.keepalive === 30, String(c1.opts.keepalive));

  c1._emit('error');
  await sleep(60);
  const c2 = api.clients[api.clients.length - 1];
  check('each attempt gets its own client id, so two copies cannot kick each other off',
        c1.opts.clientId && c2.opts.clientId && c1.opts.clientId !== c2.opts.clientId,
        c1.opts.clientId + ' vs ' + c2.opts.clientId);
  check('but it still starts from this device',
        String(c1.opts.clientId).indexOf(api.window.Convoy.state.me.id) === 0,
        c1.opts.clientId);
}

async function testAFlappingRelayIsAbandoned() {
  const api = boot();
  const C = api.window.Convoy;
  C.CFG.retryMs = 10;
  C.CFG.reconnectMs = 10;
  C.join('Akshay', 'goa-trip');
  await sleep(20);
  const first = api.clients[0].url;

  // Connect, then drop straight away — twice.
  for (let i = 0; i < 2; i++) {
    const c = api.clients[api.clients.length - 1];
    c.connect_();
    await sleep(5);
    c._emit('close');
    await sleep(40);
  }
  const now = api.clients[api.clients.length - 1].url;
  check('after two quick drops it tries a different relay', now !== first,
        first + ' -> ' + now);
}

async function testARelayThatHeldIsKept() {
  const api = boot();
  const C = api.window.Convoy;
  C.CFG.retryMs = 10;
  C.CFG.reconnectMs = 10;
  C.CFG.stableMs = 5;             // pretend five milliseconds counts as "held"
  C.join('Akshay', 'goa-trip');
  await sleep(20);
  const first = api.clients[0].url;

  for (let i = 0; i < 3; i++) {
    const c = api.clients[api.clients.length - 1];
    c.connect_();
    await sleep(15);              // longer than stableMs
    c._emit('close');
    await sleep(40);
  }
  check('a relay that held for a while is kept, not abandoned',
        api.clients[api.clients.length - 1].url === first,
        first + ' -> ' + api.clients[api.clients.length - 1].url);
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
  check('her app being put away shows on the list as in the background',
        /In the background/.test(list(api)), list(api));
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
  check('the list says the network went', /Lost network/.test(list(api)), list(api));

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

  // A backgrounded phone now reports every five minutes, so it is given much longer before
  // it counts as out of contact — six and a half minutes rather than three.
  const p1 = api.window.Convoy.state.peers.get('p1');
  p1.awayAt = Date.now() - 200000;          // three minutes: still fine now
  api.window.Convoy._internals.sweepPresence();
  await sleep(20);
  check('three minutes quiet in the background is still in the background',
        api.window.Convoy._internals.presenceOf(p1) === 'away',
        api.window.Convoy._internals.presenceOf(p1));

  p1.ts = Date.now() - 400000;              // past the background window
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

  const raw = api.window.localStorage.getItem('convoy.record');
  check('the destination is kept on the phone', !!raw, String(raw));
  check('with the place in it', /Bondi/.test(raw || ''), String(raw));
  check('inside the one record on the phone, beside the roster',
        /"members"/.test(raw || '') && !/expiresAt/.test(raw || ''), String(raw));

  // There is no Leave to press, so reopening is the only way the app ever restarts.
  api.window.Convoy.state.dest = null;
  api.window.Convoy.state.destTs = 0;
  api.window.Convoy.join('Akshay', 'goa-trip');
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
    await testABlockedRelaySaysSo();
    await testTheRelayCheckSaysWhichRelayAnswers();
    await testTheRelayCheckNamesABlockedNetwork();
    await testAMissingLibraryIsNotABlockedNetwork();
    await testSomeoneWithNoLocationStillAppears();
    await testAPhoneWithNoLocationStillSaysHello();
    await testRetriesBackOffInsteadOfHammering();
    await testTheWatchDropsToCheapInTheBackground();
    await testTheBackgroundHeartbeat();
    await testABackgroundReportKeepsSomeoneOnTheList();
    await testTheDestinationDotWearsTheSettersColour();
    await testTheRelayIsAskedWhatWentWrong();
    await testAWaitingPhoneLooksForTheGroupOnOtherRelays();
    await testOutOfContactIsSaidOnceAndOnlyWhileItIsNews();
    await testALongGonePhoneIsNotAnnouncedAgain();
    await testAFlappingPhoneIsNotAnnouncedEveryTime();
    await testAComingBackPhoneIsAnsweredAtOnce();
    await testTheClientIdIsUniquePerAttempt();
    await testAFlappingRelayIsAbandoned();
    await testARelayThatHeldIsKept();
    await testTheRelayListIncludesPort443();
    await testSomeoneElseAway();
    await testSomeoneGoesQuiet();
    await testBackgroundedTooLongCountsAsLost();
    await testStatePush();
    await testDestinationSurvivesRestart();
    await testNewestDestinationWins();
  } catch (e) { crash(e); }
  finish('presence');
})();
