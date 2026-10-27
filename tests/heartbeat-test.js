/* The background heartbeat, every branch of it. Three things have to hold for it to run:
   you have not arrived, it is under four hours since you were last on the app, and there is
   a destination at all. Setting one again inside the four hours brings it back. */
'use strict';

const { boot, check, sleep, pos, finish, crash } = require('./harness');

const HOUR = 3600000;
const list = (api) => api.document.getElementById('people').textContent;

/* A phone that is in, with a position, put into the background. */
async function away(opts = {}) {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(30);
  const st = api.window.Convoy.state;
  const I = api.window.Convoy._internals;
  if (opts.dest !== false) api.window.Convoy.setDest(-33.89, 151.27, 'Bondi Beach');
  await sleep(30);
  st.away = true;
  if (opts.lastActive != null) st.lastActive = opts.lastActive;
  I.startBgHeartbeat();
  await sleep(20);
  return { api, st, I };
}

/* ---------- 1. arrived ---------- */
async function testItStopsWhenYouArrive() {
  const { api, st, I } = await away();
  check('1a with a destination and time left, it runs', I.bgAllowed() && I.bgRunning());

  st.arrived = true;
  check('1b arriving stops it', I.bgAllowed() === false);

  api.fix(-33.89, 151.27);            // right on it, which the arrival check sees
  I.checkArrivals();
  await sleep(20);
  check('1c and the app agrees you have arrived', st.arrived === true);
  check('1d so nothing more is sent', I.bgAllowed() === false);

  // A new destination is a new reason to report.
  api.window.Convoy.setDest(-33.80, 151.10, 'Manly');
  await sleep(30);
  check('1e setting a new destination starts it again', I.bgAllowed() === true &&
        I.bgRunning() === true);
  check('1f and you are no longer counted as arrived', st.arrived === false);
}

/* ---------- 2. four hours since last active ---------- */
async function testItStopsAfterFourHours() {
  const { st, I } = await away({ lastActive: Date.now() - 3.9 * HOUR });
  check('2a just inside four hours, it still runs', I.bgAllowed() === true);

  st.lastActive = Date.now() - 4.1 * HOUR;
  I.startBgHeartbeat();
  check('2b past four hours, it stops', I.bgAllowed() === false);
  check('2c and no timer is left running', I.bgRunning() === false);

  // The clock is from the last time on the app, not from going into the background.
  st.lastActive = Date.now() - 3.5 * HOUR;
  I.startBgHeartbeat();
  check('2d the four hours are counted from when you were last on the app',
        Math.abs(st.bgUntil - (st.lastActive + 4 * HOUR)) < 1000, String(st.bgUntil));
  check('2e so half an hour is left, not four', I.bgAllowed() === true);
}

/* ---------- 3. no destination ---------- */
async function testItStopsWithNoDestination() {
  const { api, st, I } = await away();
  check('3a with a destination it runs', I.bgAllowed() === true);

  api.window.Convoy.clearDest();
  await sleep(30);
  check('3b clearing the destination stops it', I.bgAllowed() === false);
  check('3c and the timer is gone', I.bgRunning() === false);
  check('3d while still inside the four hours', Date.now() < st.bgUntil);

  // A destination again inside the four hours brings it straight back.
  api.window.Convoy.setDest(-33.80, 151.10, 'Manly');
  await sleep(30);
  check('3e setting one again resumes it', I.bgAllowed() === true && I.bgRunning() === true);
}

/* ---------- 4. no destination, and past four hours ---------- */
async function testNoDestinationAndTooLate() {
  const { api, st, I } = await away({ lastActive: Date.now() - 5 * HOUR });
  check('4a past four hours there is nothing to resume', I.bgAllowed() === false);

  api.window.Convoy.setDest(-33.80, 151.10, 'Manly');
  await sleep(30);
  check('4b and setting a destination does not bring it back', I.bgAllowed() === false);
  check('4c no timer is started', I.bgRunning() === false);
  check('4d though the destination itself is set', !!st.dest);
}

/* ---------- 5. the destination changing underneath ---------- */
async function testChangingTheDestinationKeepsItOn() {
  const { api, I } = await away();
  api.window.Convoy.setDest(-33.80, 151.10, 'Manly');
  await sleep(30);
  check('5a changing the destination keeps it running', I.bgAllowed() && I.bgRunning());
  api.window.Convoy.setDest(-33.70, 151.05, 'Cronulla');
  await sleep(30);
  check('5b and again', I.bgAllowed() && I.bgRunning());
}

/* ---------- 6. someone else sets or clears it ---------- */
async function testSomeoneElseSettingItResumesTheHeartbeat() {
  const { api, st, I } = await away();
  api.window.Convoy.clearDest();
  await sleep(30);
  check('6a cleared, it stops', I.bgAllowed() === false);

  // Somebody else sets one.
  api.recv({ t: 'dest', id: 'p1', name: 'Priya', by: 'Priya', byId: 'p1',
             lat: -33.88, lng: 151.25, label: 'Coogee', ts: Date.now() });
  await sleep(40);
  check('6b a destination from someone else brings it back', I.bgAllowed() === true);
  check('6c and the timer with it', I.bgRunning() === true);

  api.recv({ t: 'dest-clear', id: 'p1', name: 'Priya', ts: Date.now() + 5 });
  await sleep(40);
  check('6d and clearing it from their side stops it again', I.bgAllowed() === false);
  check('6e with no timer left', I.bgRunning() === false);
}

/* ---------- 7. the foreground ---------- */
async function testTheForegroundDoesNotUseTheSlowBeat() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(30);
  const st = api.window.Convoy.state;
  const I = api.window.Convoy._internals;
  api.window.Convoy.setDest(-33.89, 151.27, 'Bondi Beach');
  await sleep(30);

  st.lastActive = Date.now();
  check('7a on screen, no background timer is started', I.bgRunning() === false);
  check('7b and a destination alone does not start one', I.bgRunning() === false);

  // Going away starts it; coming back stops it.
  I.goAway();
  await sleep(20);
  check('7c going away starts the slow beat', st.away === true && I.bgRunning() === true);

  I.stopBgHeartbeat();
  st.away = false;
  check('7d and coming back stops it', I.bgRunning() === false);
}

/* ---------- 8. what the others see ---------- */
async function testWhatTheOthersSee() {
  const api = boot();
  api.join('Akshay');
  api.fix(-33.86, 151.20);
  await sleep(30);

  // A report from the background, with an old fix.
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(), fixTs: Date.now() - 600000, bg: true });
  await sleep(30);
  check('8a a background report shows as in the background', /In the background/.test(list(api)),
        list(api));
  check('8b and says the position is not new', /no new position/.test(list(api)), list(api));

  // A fresh fix from the background.
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(), fixTs: Date.now(), bg: true });
  await sleep(30);
  check('8c with a fresh fix, the note goes', !/no new position/.test(list(api)), list(api));

  // Silence past the background window: now it is news that they are gone.
  const st = api.window.Convoy.state;
  const p1 = st.peers.get('p1');
  p1.ts = Date.now() - 400000;
  api.window.Convoy._internals.sweepPresence();
  await sleep(30);
  check('8d after six and a half quiet minutes they count as out of contact',
        /Lost network/.test(list(api)), list(api));
  check('8e and it is said once', api.notes.filter((n) => /out of contact/.test(n.title)).length === 1,
        String(api.notes.filter((n) => /out of contact/.test(n.title)).length));
}

/* ---------- 9. a background report does not resurrect a removed person ---------- */
async function testABackgroundReportFromSomeoneRemoved() {
  const api = boot();
  await sleep(20);
  await (async () => {
    const d = api.document;
    d.getElementById('btnSettings').click();
    const pin = d.getElementById('inPin');
    pin.value = '1981';
    pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
    await sleep(20);
  })();

  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(), fixTs: Date.now(), bg: true });
  await sleep(30);
  check('9a they are on the list', api.window.Convoy.state.peers.has('p1'));

  api.window.Convoy._internals.removePerson('p1');
  await sleep(30);
  check('9b removed, they are off it', !api.window.Convoy.state.peers.has('p1'));

  // Sent as someone genuinely outside, which is what a removed phone is.
  api.recv({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
             spd: 0, hdg: 90, acc: 8, ts: Date.now(), fixTs: Date.now(), bg: true },
           { asStranger: true });
  await sleep(30);
  check('9c and a background report does not put them back',
        !api.window.Convoy.state.peers.has('p1'), list(api));
}

(async () => {
  try {
    await testItStopsWhenYouArrive();
    await testItStopsAfterFourHours();
    await testItStopsWithNoDestination();
    await testNoDestinationAndTooLate();
    await testChangingTheDestinationKeepsItOn();
    await testSomeoneElseSettingItResumesTheHeartbeat();
    await testTheForegroundDoesNotUseTheSlowBeat();
    await testWhatTheOthersSee();
    await testABackgroundReportFromSomeoneRemoved();
  } catch (e) { crash(e); }
  finish('heartbeat');
})();
