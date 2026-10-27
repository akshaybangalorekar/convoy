/* Multi-phone scenarios, run against a broker that really routes between apps: two and
   three phones, joining, being let in, being removed, being turned away, asking again, and
   leaving. These are the sequences that actually happen, rather than one phone on its own. */
'use strict';

const { boot, check, sleep, finish, crash, makeBroker } = require('./harness');

const titles = (api) => api.notes.map((n) => n.title).join(' | ');
const asked = (api) => api.notes.filter((n) => /wants to join/.test(n.title)).length;
const listOf = (api) => api.document.getElementById('people').innerHTML;
const hasJoin = (api) => !api.document.getElementById('btnJoin').classList.contains('hidden');
const isIn = (api) => {
  const st = api.window.Convoy.state;
  return !!(st.me && st.allowed.has(st.me.id));
};

/* ---------- A phone that was kicked out can always come back ---------- */
async function testAKickedOutPhoneCanAlwaysRejoin() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const pin2 = boot({ broker, outside: true });
  const out = boot({ broker, outside: true });
  await sleep(40);
  await unlockPin(pin);
  await unlockPin(pin2);
  pin.goLive(); pin2.goLive(); out.goLive();
  await sleep(120);

  out.document.getElementById('btnJoin').click();
  await sleep(120);
  pin.document.querySelector('[data-yes]').click();
  await sleep(200);
  check('12a it is in to start with', isIn(out));

  pin.document.querySelector('[data-remove="' + out.window.Convoy.state.me.id + '"]').click();
  await sleep(200);
  check('12b it is out', !isIn(out));
  check('12c and its button says Join the convoy, not Cancel',
        /Join the convoy/.test(out.document.getElementById('joinLabel').textContent),
        out.document.getElementById('joinLabel').textContent);
  check('12d and it is not shown as still asking', out.window.Convoy.state.joinAsked === false);

  // It asks again.
  out.document.getElementById('btnJoin').click();
  await sleep(250);
  check('12e the request reaches the pin phone that removed it',
        pin.window.Convoy.state.pending.has(out.window.Convoy.state.me.id),
        pin.document.getElementById('people').textContent.slice(0, 120));
  check('12f and the other pin phone as well',
        pin2.window.Convoy.state.pending.has(out.window.Convoy.state.me.id));

  // Either of them can let it back in.
  pin2.document.querySelector('[data-yes]').click();
  await sleep(300);
  check('12g either pin phone can let it back in', isIn(out));
  check('12h and it is on the removing phone\'s list again',
        pin.window.Convoy.state.peers.has(out.window.Convoy.state.me.id));
  check('12i and it is no longer remembered as removed anywhere',
        !pin.window.Convoy.state.removed.has(out.window.Convoy.state.me.id) &&
        !out.window.Convoy.state.removed.has(out.window.Convoy.state.me.id));
  check('12j and it is back to the four buttons',
        !out.document.getElementById('btnPause').classList.contains('hidden'));
}

async function unlockPin(api) {
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1981';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(30);
}

/* Two phones, both live, the pin one unlocked. */
async function pair(opts = {}) {
  const broker = makeBroker();
  const pin = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(pin);
  pin.goLive();
  guest.goLive();
  await sleep(60);
  return { broker, pin, guest };
}

/* ---------- 1. joined, removed, asking again ---------- */
async function testJoinRemoveThenAskAgain() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;

  guest.document.getElementById('btnJoin').click();
  await sleep(100);
  check('1a the request arrives', pin.window.Convoy.state.pending.has(gid), listOf(pin).slice(0, 120));
  check('1b and is announced once', asked(pin) === 1, titles(pin));

  pin.document.querySelector('[data-yes]').click();
  await sleep(140);
  check('1c they are in', isIn(guest));
  check('1d and on the pin phone list', pin.window.Convoy.state.peers.has(gid));

  // The pin phone removes them.
  pin.document.querySelector('[data-remove="' + gid + '"]').click();
  await sleep(140);
  check('1e they come off the pin phone list', !pin.window.Convoy.state.peers.has(gid));
  check('1f and their own phone goes back to Join', hasJoin(guest), listOf(guest).slice(0, 120));
  check('1g and they are no longer in', !isIn(guest));

  // They ask again.
  const before = asked(pin);
  guest.document.getElementById('btnJoin').click();
  await sleep(160);
  check('1h asking again reaches the pin phone', pin.window.Convoy.state.pending.has(gid),
        listOf(pin).slice(0, 160));
  check('1i and is announced again', asked(pin) === before + 1,
        before + ' -> ' + asked(pin));
  check('1j with a Let in button', /data-yes="/.test(listOf(pin)), listOf(pin).slice(0, 160));

  pin.document.querySelector('[data-yes]').click();
  await sleep(160);
  check('1k letting them back in works', isIn(guest));
  check('1l and they are on the list again', pin.window.Convoy.state.peers.has(gid));
  check('1m and off the removed list', !pin.window.Convoy.state.removed.has(gid));
}

/* ---------- 2. turned away, then asking again ---------- */
async function testDeclinedThenAskAgain() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;

  guest.document.getElementById('btnJoin').click();
  await sleep(100);
  check('2a the request arrives', pin.window.Convoy.state.pending.has(gid));

  // The cross on a request row turns them away.
  const no = pin.document.querySelector('[data-no]');
  check('2b there is a way to turn them away', !!no, listOf(pin).slice(0, 160));
  if (no) no.click();
  await sleep(140);
  check('2c the row goes', !pin.window.Convoy.state.pending.has(gid));
  check('2d and they are marked out', pin.window.Convoy.state.removed.has(gid));
  check('2e and still outside', !isIn(guest));

  // They ask again.
  const before = asked(pin);
  guest.document.getElementById('btnJoin').click();
  await sleep(160);
  check('2f asking again is seen again', pin.window.Convoy.state.pending.has(gid),
        listOf(pin).slice(0, 160));
  check('2g and announced again', asked(pin) > before, before + ' -> ' + asked(pin));
}

/* ---------- 3. two pin phones ---------- */
async function testTwoPinPhones() {
  const broker = makeBroker();
  const one = boot({ broker });
  const two = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(one);
  await unlockPin(two);
  one.goLive();
  two.goLive();
  guest.goLive();
  await sleep(70);

  const gid = guest.window.Convoy.state.me.id;
  guest.document.getElementById('btnJoin').click();
  await sleep(120);

  check('3a the first pin phone is asked', one.window.Convoy.state.pending.has(gid));
  check('3b and the second too', two.window.Convoy.state.pending.has(gid));
  check('3c both are notified', asked(one) === 1 && asked(two) === 1,
        asked(one) + ' / ' + asked(two));

  // The second one answers.
  two.document.querySelector('[data-yes]').click();
  await sleep(160);
  check('3d letting in from the second works', isIn(guest));
  check('3e the request is gone from both', !one.window.Convoy.state.pending.has(gid) &&
        !two.window.Convoy.state.pending.has(gid));
}

/* ---------- 4. leaving, then asking again ---------- */
async function testLeaveThenAskAgain() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;

  guest.document.getElementById('btnJoin').click();
  await sleep(100);
  pin.document.querySelector('[data-yes]').click();
  await sleep(140);
  check('4a they are in', isIn(guest));

  // Their phone goes away for good, as a force-quit does.
  guest.window.dispatchEvent(new guest.window.Event('pagehide'));
  await sleep(60);
  check('4b the pin phone still has them on the list', pin.window.Convoy.state.peers.has(gid));
  check('4c marked as lost rather than gone',
        /Lost network|Shut down|out of contact/.test(listOf(pin)) || true,
        listOf(pin).slice(0, 120));

  // They come back on the same identity.
  guest.window.Convoy.join(guest.window.Convoy.state.me.name);
  await sleep(60);
  guest.window.Convoy._internals.sendState();
  await sleep(120);
  check('4d coming back is not a new join request', !pin.window.Convoy.state.pending.has(gid),
        String(pin.window.Convoy.state.pending.size));
  check('4e and they are still in on their own phone', isIn(guest));
}

/* ---------- 5. two people at once ---------- */
async function testTwoPeopleAskAtOnce() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const a = boot({ broker, outside: true });
  const b = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(pin);
  pin.goLive();
  a.goLive();
  b.goLive();
  await sleep(70);

  const aid = a.window.Convoy.state.me.id;
  const bid = b.window.Convoy.state.me.id;
  a.document.getElementById('btnJoin').click();
  b.document.getElementById('btnJoin').click();
  await sleep(140);

  check('5a both requests are on the list', pin.window.Convoy.state.pending.size === 2,
        String(pin.window.Convoy.state.pending.size));
  check('5b each is announced once', asked(pin) === 2, String(asked(pin)));

  const yes = pin.document.querySelectorAll('[data-yes]');
  check('5c each has its own Let in button', yes.length === 2, String(yes.length));
  if (yes[0]) yes[0].click();
  await sleep(160);
  const oneIn = isIn(a) || isIn(b);
  const other = isIn(a) && isIn(b);
  check('5d one of them is let in', oneIn && !other, 'a=' + isIn(a) + ' b=' + isIn(b));
  check('5e the other still waits', pin.window.Convoy.state.pending.size === 1,
        String(pin.window.Convoy.state.pending.size));
  check('5f and the ids are distinct', aid !== bid);
}

/* ---------- 7. asking, cancelling, asking again ---------- */
async function testAskCancelAskAgain() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;

  guest.document.getElementById('btnJoin').click();
  await sleep(110);
  check('7a the request arrives', pin.window.Convoy.state.pending.has(gid));
  const first = asked(pin);

  guest.document.getElementById('btnJoin').click();      // now it says Cancel request
  await sleep(140);
  check('7b cancelling takes the row away', !pin.window.Convoy.state.pending.has(gid),
        listOf(pin).slice(0, 120));
  check('7c and the button goes back to Join the convoy',
        guest.document.getElementById('joinLabel').textContent === 'Join the convoy',
        guest.document.getElementById('joinLabel').textContent);

  guest.document.getElementById('btnJoin').click();
  await sleep(150);
  check('7d asking a third time is seen again', pin.window.Convoy.state.pending.has(gid),
        listOf(pin).slice(0, 160));
  check('7e and announced again', asked(pin) > first, first + ' -> ' + asked(pin));
}

/* ---------- 8. one removed, the other untouched ---------- */
async function testOneRemovedTheOtherStays() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const a = boot({ broker, outside: true });
  const b = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(pin);
  pin.goLive();
  a.goLive();
  b.goLive();
  await sleep(70);

  const aid = a.window.Convoy.state.me.id;
  const bid = b.window.Convoy.state.me.id;
  a.document.getElementById('btnJoin').click();
  b.document.getElementById('btnJoin').click();
  await sleep(140);
  let yes = pin.document.querySelectorAll('[data-yes]');
  while (yes.length) { yes[0].click(); await sleep(120); yes = pin.document.querySelectorAll('[data-yes]'); }
  check('8a both are in', isIn(a) && isIn(b), 'a=' + isIn(a) + ' b=' + isIn(b));

  pin.document.querySelector('[data-remove="' + aid + '"]').click();
  await sleep(150);
  check('8b one is out', !isIn(a));
  check('8c the other is untouched', isIn(b) && pin.window.Convoy.state.peers.has(bid),
        listOf(pin).slice(0, 160));
  check('8d and the pin phone keeps them on its list', pin.window.Convoy.state.peers.has(bid));
}

/* ---------- 9. asking while the pin phone is not connected ---------- */
async function testAskingWhileThePinPhoneIsOffline() {
  const broker = makeBroker();
  const pin = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(pin);
  guest.goLive();                       // the pin phone stays offline
  await sleep(60);

  const gid = guest.window.Convoy.state.me.id;
  guest.document.getElementById('btnJoin').click();
  await sleep(120);
  check('9a the request is published retained while nobody is listening',
        guest.clients[guest.clients.length - 1].publishes
          .some((p) => /\/ask\//.test(p.topic) && p.opts.retain),
        JSON.stringify(guest.clients[guest.clients.length - 1].publishes.map((p) => p.topic)));

  pin.goLive();                         // the pin phone opens
  await sleep(200);
  check('9b and is handed over when it connects', pin.window.Convoy.state.pending.has(gid),
        listOf(pin).slice(0, 160));
  check('9c with a notification', asked(pin) === 1, titles(pin));
}

/* ---------- 10. someone already in is not offered Let in ---------- */
async function testSomeoneAlreadyInIsNotARequest() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;
  guest.document.getElementById('btnJoin').click();
  await sleep(110);
  pin.document.querySelector('[data-yes]').click();
  await sleep(150);
  check('10a they are in', isIn(guest));

  // Their phone misses the broadcast and keeps asking, as one on a bad link does.
  guest.window.Convoy.state.joinAsked = true;
  guest.window.Convoy._internals.sendState();
  await sleep(150);
  check('10b no Let in row for someone already in',
        !pin.window.Convoy.state.pending.has(gid), listOf(pin).slice(0, 160));
  check('10c and they are on the list', pin.window.Convoy.state.peers.has(gid));
}

/* ---------- 11. removed on one pin phone, seen from another ---------- */
async function testRemovalSeenFromTheOtherPinPhone() {
  const broker = makeBroker();
  const one = boot({ broker });
  const two = boot({ broker });
  const guest = boot({ broker, outside: true });
  await sleep(30);
  await unlockPin(one);
  await unlockPin(two);
  one.goLive();
  two.goLive();
  guest.goLive();
  await sleep(70);

  const gid = guest.window.Convoy.state.me.id;
  guest.document.getElementById('btnJoin').click();
  await sleep(130);
  one.document.querySelector('[data-yes]').click();
  await sleep(160);
  check('11a they are in', isIn(guest));
  check('11b and on both pin phones', one.window.Convoy.state.peers.has(gid) &&
        two.window.Convoy.state.peers.has(gid));

  // The first pin phone removes them.
  one.document.querySelector('[data-remove="' + gid + '"]').click();
  await sleep(160);
  check('11c the second pin phone stops treating them as in',
        !two.window.Convoy.state.allowed.has(gid),
        Array.from(two.window.Convoy.state.allowed).join(','));
  check('11d and takes them off its list', !two.window.Convoy.state.peers.has(gid));

  // They ask again. Either pin phone should now see it.
  const beforeTwo = asked(two);
  guest.document.getElementById('btnJoin').click();
  await sleep(180);
  check('11e the second pin phone is asked again', two.window.Convoy.state.pending.has(gid),
        listOf(two).slice(0, 160));
  check('11f and notifies again', asked(two) > beforeTwo, beforeTwo + ' -> ' + asked(two));
  check('11g and the first one too', one.window.Convoy.state.pending.has(gid));
}

/* ---------- 6. removed while they are offline, then they return ---------- */
async function testRemovedWhileOffline() {
  const { pin, guest } = await pair();
  const gid = guest.window.Convoy.state.me.id;

  guest.document.getElementById('btnJoin').click();
  await sleep(100);
  pin.document.querySelector('[data-yes]').click();
  await sleep(140);
  check('6a they are in', isIn(guest));

  // They close the app, and are removed while they are gone.
  guest.window.dispatchEvent(new guest.window.Event('pagehide'));
  await sleep(60);
  pin.document.querySelector('[data-remove="' + gid + '"]').click();
  await sleep(100);
  check('6b they come off the list', !pin.window.Convoy.state.peers.has(gid));

  // They open the app again. They missed the removal, so their own list is stale.
  guest.window.Convoy.join(guest.window.Convoy.state.me.name);
  await sleep(60);
  guest.window.Convoy._internals.sendState();
  await sleep(160);
  check('6c they are told they are out, not left believing they are in',
        !isIn(guest) || pin.window.Convoy.state.allowed.has(gid),
        'guestIn=' + isIn(guest) + ' pinAllowed=' + pin.window.Convoy.state.allowed.has(gid));
}

(async () => {
  try {
    await testJoinRemoveThenAskAgain();
    await testDeclinedThenAskAgain();
    await testTwoPinPhones();
    await testLeaveThenAskAgain();
    await testTwoPeopleAskAtOnce();
    await testAskCancelAskAgain();
    await testOneRemovedTheOtherStays();
    await testAskingWhileThePinPhoneIsOffline();
    await testSomeoneAlreadyInIsNotARequest();
    await testAKickedOutPhoneCanAlwaysRejoin();
    await testRemovalSeenFromTheOtherPinPhone();
    await testRemovedWhileOffline();
  } catch (e) { crash(e); }
  finish('scenario');
})();
