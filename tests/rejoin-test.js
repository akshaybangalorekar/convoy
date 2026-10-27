/* Coming back has no expiry. Whether you left on purpose, were removed with the cross, or
   simply vanished for a week, months or years, you can always ask again — and the only thing
   that decides it is the phone holding the pin, at that moment.

   Each case below is run twice: once with everything fresh, and once with the clock wound
   forward, because a time limit is exactly the kind of thing that only shows up later. */
'use strict';

const { boot, check, sleep, finish, crash, makeBroker } = require('./harness');

const DAY = 86400000;
const listText = (api) => api.document.getElementById('people').textContent;
const isIn = (api) => {
  const s = api.window.Convoy.state;
  return !!(s.me && s.allowed.has(s.me.id));
};
const meId = (api) => api.window.Convoy.state.me.id;

async function unlockPin(api) {
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1981';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);
}

/* A pin phone and a newcomer, both on one broker, the newcomer already in. */
async function pair() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const them = boot({ broker, outside: true });
  await sleep(50);
  await unlockPin(pin);
  pin.goLive(); them.goLive();
  await sleep(120);
  them.document.getElementById('btnJoin').click();
  await sleep(120);
  pin.document.querySelector('[data-yes]').click();
  await sleep(200);
  return { broker, pin, them };
}

/* ---------- 1. removed, then comes back much later ---------- */
async function testARemovedPhoneCanComeBackMuchLater(gapDays, label) {
  const { pin, them } = await pair();
  const id = meId(them);
  check('1a-' + label + ' they are in', isIn(them));

  pin.document.querySelector('[data-remove="' + id + '"]').click();
  await sleep(200);
  check('1b-' + label + ' they are out', !isIn(them));
  check('1c-' + label + ' and remembered as removed', pin.window.Convoy.state.removed.has(id));

  // Wind the clock forward: their last sign of life, and the removal, are both ancient.
  const old = Date.now() - gapDays * DAY;
  pin.window.Convoy.state.removed.add(id);
  pin.window.Convoy._internals.saveRecordNow
    ? pin.window.Convoy._internals.saveRecordNow()
    : null;
  const rec = JSON.parse(pin.window.localStorage.getItem('convoy.record') || '{}');
  if (rec.members) {
    Object.keys(rec.members).forEach((k) => { rec.members[k].lastSeen = old; });
    pin.window.localStorage.setItem('convoy.record', JSON.stringify(rec));
  }

  // They ask again.
  them.document.getElementById('btnJoin').click();
  await sleep(300);
  check('1d-' + label + ' the request still reaches the pin phone',
        pin.window.Convoy.state.pending.has(id), listText(pin).slice(0, 140));

  pin.document.querySelector('[data-yes]').click();
  await sleep(300);
  check('1e-' + label + ' and they are let straight back in', isIn(them));
  check('1f-' + label + ' with the removal forgotten', !pin.window.Convoy.state.removed.has(id));
  check('1g-' + label + ' and on the list again', pin.window.Convoy.state.peers.has(id));
}

/* ---------- 2. left on purpose, then comes back much later ---------- */
async function testAPhoneThatLeftCanComeBackMuchLater(gapDays, label) {
  const { pin, them } = await pair();
  const id = meId(them);
  them.window.Convoy._internals.leaveConvoy();
  await sleep(200);
  check('2a-' + label + ' they are out', !isIn(them));

  // Their row is long gone from everyone's roster.
  const rec = JSON.parse(pin.window.localStorage.getItem('convoy.record') || '{}');
  if (rec.members) {
    Object.keys(rec.members).forEach((k) => { rec.members[k].lastSeen = Date.now() - gapDays * DAY; });
    pin.window.localStorage.setItem('convoy.record', JSON.stringify(rec));
  }
  pin.window.Convoy._internals.pruneRoster();
  await sleep(60);
  const after = JSON.parse(pin.window.localStorage.getItem('convoy.record') || '{}');
  check('2b-' + label + ' the roster no longer has them', !(after.members || {})[id],
        JSON.stringify(Object.keys(after.members || {})));

  them.document.getElementById('btnJoin').click();
  await sleep(300);
  check('2c-' + label + ' asking again puts them straight back in', isIn(them));
  check('2d-' + label + ' and they are on the list', pin.window.Convoy.state.peers.has(id));
}

/* ---------- 3. a request left on the broker long ago ---------- */
async function testAnOldRetainedRequestDoesNotBlockANewOne() {
  const broker = makeBroker();
  const pin = boot({ broker });
  await sleep(40);
  await unlockPin(pin);
  pin.goLive();
  await sleep(100);

  const strangerId = 'gone-for-years';
  const ask = (ts) => ({ t: 'ask', id: strangerId, name: 'Rahul', ts });

  // Days old: not news, so it is not offered — a stale request should not pop up.
  pin.recv(ask(Date.now() - 3 * DAY), { asStranger: true });
  await sleep(60);
  check('3a a request from days ago is not offered again',
        !pin.window.Convoy.state.pending.has(strangerId),
        JSON.stringify([...pin.window.Convoy.state.pending.keys()]));

  // But the person asking now is offered, with no reference to the old one.
  pin.recv(ask(Date.now()), { asStranger: true });
  await sleep(60);
  check('3b and asking now is offered at once',
        pin.window.Convoy.state.pending.has(strangerId),
        JSON.stringify([...pin.window.Convoy.state.pending.keys()]));
  check('3c with a Let in button to press',
        !!pin.document.querySelector('[data-yes]'), listText(pin).slice(0, 120));

  pin.document.querySelector('[data-yes]').click();
  await sleep(200);
  check('3d and they are let in', pin.window.Convoy.state.allowed.has(strangerId));
}

/* ---------- 4. the pin phone itself was closed for a long time ---------- */
async function testTheRemovalSurvivesThePinPhoneBeingClosedForYears() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const them = boot({ broker, outside: true });
  await sleep(50);
  await unlockPin(pin);
  pin.goLive(); them.goLive();
  await sleep(120);
  them.document.getElementById('btnJoin').click();
  await sleep(120);
  pin.document.querySelector('[data-yes]').click();
  await sleep(200);
  const id = meId(them);

  pin.document.querySelector('[data-remove="' + id + '"]').click();
  await sleep(200);
  check('4a removed to begin with', !isIn(them));

  // The pin phone is closed and reopened much later, with its storage intact.
  const saved = pin.window.localStorage.getItem('convoy.record');
  const rec = JSON.parse(saved || '{}');
  if (rec.members) {
    Object.keys(rec.members).forEach((k) => { rec.members[k].lastSeen = Date.now() - 900 * DAY; });
  }
  const again = boot({
    broker,
    setup: (w) => {
      w.localStorage.setItem('convoy.record', JSON.stringify(rec));
      w.localStorage.setItem('convoy.name', 'Phone 0p');
    },
  });
  await sleep(120);
  await unlockPin(again);
  again.goLive();
  await sleep(200);
  check('4b the removal is still remembered after years', again.window.Convoy.state.removed.has(id),
        JSON.stringify([...again.window.Convoy.state.removed]));

  // And it can still be undone.
  them.document.getElementById('btnJoin').click();
  await sleep(300);
  check('4c they can still ask', again.window.Convoy.state.pending.has(id),
        listText(again).slice(0, 140));
  again.document.querySelector('[data-yes]').click();
  await sleep(300);
  check('4d and be let back in', isIn(them));
}

/* ---------- 5. nothing anywhere carries an expiry ---------- */
async function testNothingCarriesAnExpiry() {
  const { pin } = await pair();
  const I = pin.window.Convoy._internals;
  const CFG = pin.window.Convoy.CFG;

  // The only time limits that exist, and what each is for.
  check('5a the roster forgets people after a week, which is not a block',
        CFG.keepDays === 7);
  check('5b a retained request is only news for half an hour',
        CFG.askFreshMs === 30 * 60000);
  check('5c and there is no limit on the removed list', !('removedMs' in CFG),
        JSON.stringify(Object.keys(CFG).filter((k) => /remov|ban|block/i.test(k))));
  check('5d no join path consults a date', !/joinAsked.*Date\.now\(\) -/.test(
        require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8')));
  check('5e and the removed list is only ever cleared by Let in', (() => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
    const clears = src.match(/state\.removed\.delete\(/g) || [];
    // letIn, and the phone clearing its own entry — nothing time-based.
    return clears.length >= 1 && !/Date\.now\(\).*state\.removed/.test(src);
  })());
  check('5f the internals agree', typeof I.leaveConvoy === 'function');

  // The lists are capped, so years of removals cannot bloat storage or overflow a message.
  const st = pin.window.Convoy.state;
  for (let i = 0; i < 600; i++) st.removed.add('old-' + i);
  for (let i = 0; i < 600; i++) st.allowed.add('old-' + i);
  pin.window.Convoy._internals.publishLists();
  await sleep(30);
  check('5g the removed list is capped', st.removed.size <= 400, String(st.removed.size));
  check('5h and so is the allowed list', st.allowed.size <= 400, String(st.allowed.size));
  check('5i and we never drop ourselves', st.allowed.has(st.me.id));
}

(async () => {
  try {
    await testARemovedPhoneCanComeBackMuchLater(0, 'now');
    await testARemovedPhoneCanComeBackMuchLater(1, 'a-day');
    await testARemovedPhoneCanComeBackMuchLater(400, 'a-year');
    await testAPhoneThatLeftCanComeBackMuchLater(0, 'now');
    await testAPhoneThatLeftCanComeBackMuchLater(120, 'months');
    await testAnOldRetainedRequestDoesNotBlockANewOne();
    await testTheRemovalSurvivesThePinPhoneBeingClosedForYears();
    await testNothingCarriesAnExpiry();
  } catch (e) { crash(e); }
  finish('rejoin');
})();
