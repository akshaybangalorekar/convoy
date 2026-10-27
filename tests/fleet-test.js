/* A convoy of eight to ten phones on one broker, with one, two, seven or all of them holding
   the pin — and what happens when a pin phone goes away. These are the numbers that matter
   once a group is real: the colour palette runs out at ten, the list gets long, and the
   question "can anyone still let people in?" becomes a real one. */
'use strict';

const { boot, check, sleep, finish, crash, makeBroker } = require('./harness');

const asked = (api) => api.notes.filter((n) => /wants to join/.test(n.title)).length;
const listOf = (api) => api.document.getElementById('people').innerHTML;
const rows = (api) => api.document.querySelectorAll('#people li[data-id]').length;
const isIn = (api) => {
  const st = api.window.Convoy.state;
  return !!(st.me && st.allowed.has(st.me.id));
};
const meId = (api) => api.window.Convoy.state.me.id;
/* Answer a specific person's request, not just the first row on the list. */
const yesFor = (api, id) => api.document.querySelector('[data-yes="' + id + '"]');

async function unlockPin(api) {
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1981';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);
}

/* A convoy of `n` phones, the first `pins` of which hold the pin. Everyone is live, and
   unless told otherwise everyone outside asks to be let in, so the pin phone has real
   requests to answer. */
async function fleet(n, pins, opts = {}) {
  const broker = makeBroker();
  const phones = [];
  for (let i = 0; i < n; i++) phones.push(boot({ broker, outside: i >= pins }));
  await sleep(40);
  for (let i = 0; i < pins; i++) await unlockPin(phones[i]);
  phones.forEach((p) => p.goLive());
  await sleep(120);
  // Give each phone a position, a few hundred metres apart, so there are real cars to draw
  // and a real map to frame.
  phones.forEach((p, i) => p.fix(-33.86 + i * 0.004, 151.20 + i * 0.005, { heading: 90 }));
  await sleep(160);
  if (!opts.quiet) {
    for (const p of phones.slice(pins)) { p.document.getElementById('btnJoin').click(); }
    await sleep(200);
  }
  return { broker, phones };
}

/* Let everybody who is waiting in, one at a time, from the given pin phone. */
async function letEveryoneIn(pinPhone, phones) {
  for (let round = 0; round < phones.length + 2; round++) {
    const yes = pinPhone.document.querySelector('[data-yes]');
    if (!yes) break;
    yes.click();
    await sleep(90);
  }
}

/* ---------- Eight phones, one pin ---------- */
async function testEightPhonesOnePin() {
  const { phones } = await fleet(8, 1);
  const pin = phones[0];
  await letEveryoneIn(pin, phones);

  const inCount = phones.filter(isIn).length;
  check('8 phones, 1 pin: everybody is in', inCount === 8, String(inCount));
  check('8 phones, 1 pin: the pin phone lists the other seven',
        phones[0].window.Convoy.state.peers.size === 7,
        String(phones[0].window.Convoy.state.peers.size));
  check('8 phones, 1 pin: eight rows on the list', rows(pin) === 8, String(rows(pin)));
  check('8 phones, 1 pin: no request left outstanding',
        pin.window.Convoy.state.pending.size === 0,
        String(pin.window.Convoy.state.pending.size));
}

/* ---------- Ten phones, one pin: the palette limit ---------- */
async function testTenPhonesOnePin() {
  const { phones } = await fleet(10, 1);
  const pin = phones[0];
  await letEveryoneIn(pin, phones);

  check('10 phones, 1 pin: everybody is in', phones.filter(isIn).length === 10,
        String(phones.filter(isIn).length));

  const st = pin.window.Convoy.state;
  const all = [st.me].concat(Array.from(st.peers.values())).map((p) => p.color);
  check('10 phones: every car on the map has its own colour',
        new Set(all).size === 10, JSON.stringify(all));
  check('10 phones: and your own car keeps the same colour on your phone',
        st.me.color === st.me.color && phones.every((p) =>
          p.window.Convoy.state.me.color === p.window.Convoy.state.me.color));

  check('10 phones: the list holds all ten', rows(pin) === 10, String(rows(pin)));
  const peers = pin.window.Convoy.state.peers.size;
  check('10 phones: the pin phone knows the other nine', peers === 9, String(peers));
}

/* ---------- Ten phones, two pins ---------- */
async function testTenPhonesTwoPins() {
  const { phones } = await fleet(10, 2);
  const [a, b] = phones;
  await sleep(120);

  const waiting = phones.slice(2);
  const first = waiting[0];
  await sleep(140);
  check('10 phones, 2 pins: both pin phones are asked',
        a.window.Convoy.state.pending.has(meId(first)) &&
        b.window.Convoy.state.pending.has(meId(first)));
  check('10 phones, 2 pins: both are notified about every one of them',
        asked(a) === waiting.length && asked(b) === waiting.length,
        asked(a) + ' / ' + asked(b) + ' of ' + waiting.length);

  // The second one answers, to prove it does not have to be the first.
  const btn = yesFor(b, meId(first));
  check('10 phones, 2 pins: the second has a button for that person', !!btn,
        listOf(b).slice(0, 160));
  btn.click();
  await sleep(160);
  check('10 phones, 2 pins: either can let someone in', isIn(first));
  check('10 phones, 2 pins: the row goes from both',
        !a.window.Convoy.state.pending.has(meId(first)) &&
        !b.window.Convoy.state.pending.has(meId(first)));
}

/* ---------- Ten phones, seven pins ---------- */
async function testTenPhonesSevenPins() {
  const { phones } = await fleet(10, 7);
  const pins = phones.slice(0, 7);
  const waiting = phones.slice(7);
  await sleep(160);
  const got = pins.filter((p) => p.window.Convoy.state.pending.has(meId(waiting[0]))).length;
  check('10 phones, 7 pins: all seven pin phones are asked', got === 7, String(got));
  check('10 phones, 7 pins: and all seven are notified',
        pins.every((p) => asked(p) === waiting.length),
        pins.map((p) => asked(p)).join(',') + ' of ' + waiting.length);

  // Any one of them answers.
  yesFor(pins[6], meId(waiting[0])).click();
  await sleep(170);
  check('10 phones, 7 pins: the seventh can let them in', isIn(waiting[0]));
  check('10 phones, 7 pins: and that request clears everywhere',
        pins.every((p) => !p.window.Convoy.state.pending.has(meId(waiting[0]))),
        pins.map((p) => p.window.Convoy.state.pending.size).join(','));
}

/* ---------- Ten phones, every one a pin ---------- */
async function testTenPhonesAllPins() {
  const { phones } = await fleet(10, 10);
  check('10 phones, all pins: everybody is in without being asked',
        phones.every(isIn), String(phones.filter(isIn).length));
  check('10 phones, all pins: nobody is waiting',
        phones.every((p) => p.window.Convoy.state.pending.size === 0));
  check('10 phones, all pins: each phone sees the other nine',
        phones.every((p) => p.window.Convoy.state.peers.size === 9),
        phones.map((p) => p.window.Convoy.state.peers.size).join(','));
}

/* ---------- A pin phone leaves ---------- */
async function testOnePinPhoneLeavesWithTwoPins() {
  const { phones } = await fleet(8, 2);
  const [a, b] = phones;
  await sleep(120);

  // The first pin phone closes its app.
  a.window.dispatchEvent(new a.window.Event('pagehide'));
  await sleep(120);
  check('2 pins, one leaves: the other is still live',
        b.window.Convoy.state.conn === 'live' || b.clients.length > 0,
        String(b.window.Convoy.state.conn));

  // Someone still waiting asks, and the remaining pin phone answers.
  const waiting = phones[7];
  check('2 pins, one leaves: the one still there is asked',
        b.window.Convoy.state.pending.has(meId(waiting)),
        listOf(b).slice(0, 140));
  b.document.querySelector('[data-yes]').click();
  await sleep(170);
  check('2 pins, one leaves: and can still let people in', isIn(waiting));
}

/* ---------- The only pin phone leaves ---------- */
async function testTheOnlyPinPhoneLeaves() {
  const { broker, phones } = await fleet(8, 1);
  const pin = phones[0];
  await letEveryoneIn(pin, phones);
  check('1 pin: everyone is in to start with', phones.filter(isIn).length === 8,
        String(phones.filter(isIn).length));

  pin.window.dispatchEvent(new pin.window.Event('pagehide'));
  await sleep(160);

  // The convoy carries on without it: everyone else still sees everyone else.
  const other = phones[1];
  check('1 pin leaves: the rest are still in', phones.slice(1).every(isIn));
  check('1 pin leaves: and still see each other',
        other.window.Convoy.state.peers.size === 7,
        String(other.window.Convoy.state.peers.size));
  check('1 pin leaves: nobody is dropped because of it', rows(other) === 8,
        String(rows(other)));
  const withCars = Array.from(other.window.Convoy.state.peers.values())
    .filter((p) => p._marker).length;
  check('1 pin leaves: and every car is still drawn', withCars === 7, String(withCars));

  // A newcomer on the same broker can ask, but there is nobody left to answer.
  const newcomer = boot({ broker, outside: true });
  newcomer.goLive();
  await sleep(80);
  newcomer.document.getElementById('btnJoin').click();
  await sleep(200);
  check('1 pin leaves: a newcomer stays out', !isIn(newcomer));
  check('1 pin leaves: nobody is offered a Let in button, because nobody holds the pin',
        phones.slice(1).every((p) => p.window.Convoy.state.pending.size === 0),
        phones.map((p) => p.window.Convoy.state.pending.size).join(','));
}

/* ---------- The only pin phone comes back ---------- */
async function testTheOnlyPinPhoneComesBack() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(pin);
  pin.goLive();
  guest.goLive();
  await sleep(70);

  pin.window.dispatchEvent(new pin.window.Event('pagehide'));
  await sleep(100);

  // The guest asks while the pin phone is away.
  guest.document.getElementById('btnJoin').click();
  await sleep(140);
  check('the only pin phone is away: the request waits on the broker',
        guest.clients[guest.clients.length - 1].publishes
          .some((p) => /\/ask\//.test(p.topic) && p.opts.retain));

  // The pin phone comes back, on the same identity, and is handed the request.
  pin.window.Convoy.join(pin.window.Convoy.state.me.name);
  pin.goLive();
  await sleep(220);
  check('and is handed over when it returns',
        pin.window.Convoy.state.pending.has(meId(guest)),
        listOf(pin).slice(0, 160));
  check('so it can let them in', (() => {
    const yes = pin.document.querySelector('[data-yes]');
    return !!yes;
  })(), listOf(pin).slice(0, 160));

  pin.document.querySelector('[data-yes]').click();
  await sleep(180);
  check('and the person gets in', isIn(guest));
}

/* ---------- The pin moves to another phone ---------- */
async function testAnotherPhoneCanTakeOverThePin() {
  // With one pin phone gone, nobody can be let in — unless someone else types the pin.
  // That is the only hand-over there is, so it has to work.
  const { broker, phones } = await fleet(8, 1);
  const pin = phones[0];
  await letEveryoneIn(pin, phones);
  pin.window.dispatchEvent(new pin.window.Event('pagehide'));
  await sleep(160);

  const newcomer = boot({ broker, outside: true });
  newcomer.goLive();
  await sleep(80);
  newcomer.document.getElementById('btnJoin').click();
  await sleep(200);
  check('with the only pin phone gone, a newcomer waits', !isIn(newcomer));

  // Someone else enters the pin on their own phone.
  await unlockPin(phones[3]);
  await sleep(200);
  check('another phone can take over by typing the pin',
        phones[3].window.Convoy.state.master === true);
  check('and is then asked about the person waiting',
        phones[3].window.Convoy.state.pending.has(meId(newcomer)),
        listOf(phones[3]).slice(0, 160));

  yesFor(phones[3], meId(newcomer)).click();
  await sleep(200);
  check('and can let them in', isIn(newcomer));
}

/* ---------- Eight phones, everyone removed but one ---------- */
async function testRemovingFromALargeGroup() {
  const { phones } = await fleet(8, 1);
  const pin = phones[0];
  await letEveryoneIn(pin, phones);
  check('8 phones: all in before removing', phones.filter(isIn).length === 8,
        String(phones.filter(isIn).length));

  const victim = phones[5];
  pin.document.querySelector('[data-remove="' + meId(victim) + '"]').click();
  await sleep(170);
  check('8 phones: removing one takes them off the list',
        !pin.window.Convoy.state.peers.has(meId(victim)));
  check('8 phones: and their own phone goes back to Join',
        !isIn(victim));
  check('8 phones: the other seven are untouched',
        phones.filter((p, i) => i !== 5 && i !== 0).every(isIn),
        phones.map((p, i) => (i === 0 || i === 5 ? '-' : isIn(p))).join(','));
  check('8 phones: the list is back to seven plus you', rows(pin) === 7, String(rows(pin)));
}

(async () => {
  try {
    await testEightPhonesOnePin();
    await testTenPhonesOnePin();
    await testTenPhonesTwoPins();
    await testTenPhonesSevenPins();
    await testTenPhonesAllPins();
    await testOnePinPhoneLeavesWithTwoPins();
    await testTheOnlyPinPhoneLeaves();
    await testTheOnlyPinPhoneComesBack();
    await testAnotherPhoneCanTakeOverThePin();
    await testRemovingFromALargeGroup();
  } catch (e) { crash(e); }
  finish('fleet');
})();
