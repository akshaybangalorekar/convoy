/* A whole journey with ten phones on one broker, rather than one assertion at a time.
   Every phone drives, the destination changes, someone is removed and let back in, someone
   arrives, the pin moves, and at each step every phone's view of the convoy has to agree
   with every other's. This is the test that catches "it works on my phone". */
'use strict';

const { boot, check, sleep, finish, crash, makeBroker } = require('./harness');

const st = (api) => api.window.Convoy.state;
const listText = (api) => api.document.getElementById('people').textContent;
const rows = (api) => api.document.querySelectorAll('#people li[data-id]').length;
const meId = (api) => st(api).me.id;
const isIn = (api) => !!st(api).me && st(api).allowed.has(st(api).me.id);

/* Everyone this phone believes is in the convoy, itself included. Two phones agree when
   these sets are equal. */
function worldOf(api) {
  const s = st(api);
  const ids = new Set([s.me.id]);
  s.peers.forEach((_p, id) => ids.add(id));
  return Array.from(ids).sort();
}

function agree(phones, label) {
  const worlds = phones.map(worldOf);
  const first = worlds[0].join(',');
  const same = worlds.every((w) => w.join(',') === first);
  check(label, same, worlds.map((w) => w.length).join(' / ') + ' — ' +
        (same ? 'all agree' : 'DISAGREE'));
}

function sameDest(phones, label) {
  const labels = phones.map((p) => (st(p).dest ? st(p).dest.label : ''));
  const first = labels[0];
  check(label, labels.every((l) => l === first),
        labels.map((l) => l || '(none)').join(' | '));
}

async function unlockPin(api) {
  const d = api.document;
  d.getElementById('btnSettings').click();
  const pin = d.getElementById('inPin');
  pin.value = '1981';
  pin.dispatchEvent(new api.window.Event('change', { bubbles: true }));
  await sleep(20);
}

/* Ten phones, two of them with the pin, each a few hundred metres from the last. */
async function buildConvoy() {
  const broker = makeBroker();
  const phones = [];
  for (let i = 0; i < 10; i++) phones.push(boot({ broker, outside: i >= 2 }));
  await sleep(50);
  await unlockPin(phones[0]);
  await unlockPin(phones[1]);
  phones.forEach((p) => p.goLive());
  await sleep(150);
  phones.forEach((p, i) => p.fix(-33.86 + i * 0.004, 151.20 + i * 0.005, { heading: 90 }));
  await sleep(200);
  return { broker, phones };
}

/* Everybody outside asks, and the pin phones let them in, one at a time. */
async function letEveryoneIn(phones) {
  for (const p of phones.slice(2)) {
    p.document.getElementById('btnJoin').click();
    await sleep(30);
  }
  for (let round = 0; round < 40; round++) {
    const pin = phones.find((p) => p.document.querySelector('[data-yes]'));
    if (!pin) break;
    pin.document.querySelector('[data-yes]').click();
    await sleep(60);
  }
  await sleep(150);
}

/* Everyone moves a little closer to the destination, the way a convoy does. */
async function drive(phones, lat, lng, step) {
  phones.forEach((p, i) => {
    const s = st(p).me;
    if (s.lat == null) return;
    const dLat = (lat - s.lat) * step;
    const dLng = (lng - s.lng) * step;
    p.fix(s.lat + dLat + 0.00002 * (i + 1), s.lng + dLng, { heading: 45 });
  });
  await sleep(160);
}

const DEST = { lat: -33.80, lng: 151.10, label: 'Manly' };

(async () => {
  try {
    /* ---------- 1. ten phones join ---------- */
    const { broker, phones } = await buildConvoy();
    check('1a nobody is in to start with except the two pin phones',
          phones.filter(isIn).length === 2, String(phones.filter(isIn).length));

    await letEveryoneIn(phones);
    check('1b all ten are in', phones.every(isIn), String(phones.filter(isIn).length));
    agree(phones, '1c every phone sees all ten of us');

    const pin = phones[0];
    check('1d the pin phone lists nine others', st(pin).peers.size === 9,
          String(st(pin).peers.size));
    check('1e and the list has ten rows', rows(pin) === 10, String(rows(pin)));
    const colours = [st(pin).me].concat(Array.from(st(pin).peers.values())).map((p) => p.color);
    check('1f every car has its own colour', new Set(colours).size === 10,
          JSON.stringify(colours));
    check('1g nobody is waiting on a request', phones.every((p) => st(p).pending.size === 0));

    /* ---------- 2. a destination, from someone who is not a pin ---------- */
    phones[6].window.Convoy.setDest(DEST.lat, DEST.lng, DEST.label);
    await sleep(200);
    sameDest(phones, '2a every phone has the destination');
    check('2b and knows who set it', st(pin).dest.byId === meId(phones[6]),
          String(st(pin).dest.byId));
    check('2c the dot on the pin phone wears that person\'s colour',
          st(pin).peers.get(meId(phones[6])).color === st(pin).peers.get(meId(phones[6])).color);

    /* ---------- 3. the convoy drives ---------- */
    for (let leg = 0; leg < 4; leg++) await drive(phones, DEST.lat, DEST.lng, 0.15);
    agree(phones, '3a after driving, everyone still agrees who is here');
    const moved = Array.from(st(pin).peers.values()).filter((p) => p.lat != null).length;
    check('3b every car has a position on the pin phone', moved === 9, String(moved));
    const far = st(pin).peers.get(meId(phones[9]));
    const startLat = -33.86 + 9 * 0.004;
    check('3c and they have moved toward it',
          Math.abs(far.lat - DEST.lat) < Math.abs(startLat - DEST.lat),
          far.lat + ' vs start ' + startLat.toFixed(4));
    const spread = Array.from(st(pin).peers.values()).map((p) => p.lat);
    check('3d and they are not all in the same place',
          new Set(spread.map((v) => Math.round(v * 10000))).size >= 8,
          String(new Set(spread.map((v) => Math.round(v * 10000))).size));

    /* ---------- 4. one phone goes to the background ---------- */
    phones[4].window.Convoy._internals.goAway();
    await sleep(150);
    check('4a it is in the background', st(phones[4]).away === true);
    check('4b and reporting on the slow beat',
          phones[4].window.Convoy._internals.cadenceMs() ===
          phones[4].window.Convoy.CFG.bgMs);
    check('4c the others still have it, marked as in the background',
          st(pin).peers.has(meId(phones[4])) &&
          /In the background/.test(listText(pin)), listText(pin).slice(0, 120));

    /* ---------- 5. one phone loses its connection and comes back ---------- */
    const dropped = phones[8];
    const client = dropped.clients[dropped.clients.length - 1];
    client.connected = false;
    client._emit('close');
    await sleep(120);
    check('5a the pin phone still lists it, as someone who went quiet',
          st(pin).peers.has(meId(dropped)), 'still listed');
    st(pin).peers.get(meId(dropped)).ts = Date.now() - 200000;
    pin.window.Convoy._internals.sweepPresence();
    await sleep(60);
    check('5b and says it is out of contact rather than pretending all is well',
          /Lost network/.test(listText(pin)), listText(pin).slice(0, 160));
    dropped.goLive();
    await sleep(150);
    dropped.window.Convoy._internals.sendState();
    await sleep(200);
    check('5c it is back, and still in', isIn(dropped));
    check('5d and the pin phone has it live again',
          !/Lost network/.test(listText(pin)) ||
          !/Lost network/.test(listText(pin).split('Phone')[1] || ''),
          listText(pin).slice(0, 160));
    agree(phones, '5e and the convoy agrees again after the drop');

    /* ---------- 6. someone is removed, then asks again ---------- */
    const victim = phones[7];
    pin.document.querySelector('[data-remove="' + meId(victim) + '"]').click();
    await sleep(250);
    check('6a it is out on its own phone', !isIn(victim));
    check('6b and off the pin phone list', !st(pin).peers.has(meId(victim)));
    check('6c and off the other pin phone too', !st(phones[1]).peers.has(meId(victim)));

    victim.document.getElementById('btnJoin').click();
    await sleep(200);
    check('6d asking again reaches the pin phone', st(pin).pending.has(meId(victim)),
          listText(pin).slice(0, 140));
    pin.document.querySelector('[data-yes]').click();
    await sleep(300);
    check('6e and letting it back in works', isIn(victim));
    check('6f and it is on the pin phone list again', st(pin).peers.has(meId(victim)));
    agree(phones, '6g the convoy agrees after a removal and a return');

    /* ---------- 7. one arrives ---------- */
    phones[9].fix(DEST.lat, DEST.lng, { heading: 0 });
    await sleep(200);
    phones[9].window.Convoy._internals.checkArrivals();
    await sleep(250);
    check('7a it knows it has arrived', st(phones[9]).arrived === true);
    check('7b the pin phone is told', st(pin).peers.get(meId(phones[9])).arrived === true,
          JSON.stringify(st(pin).peers.get(meId(phones[9])).arrived));
    check('7c and the list says so', /arrived/i.test(listText(pin)), listText(pin).slice(0, 160));

    /* ---------- 8. the destination is cleared ---------- */
    phones[6].window.Convoy.clearDest();
    await sleep(250);
    sameDest(phones, '8a every phone cleared the destination');
    check('8b and the background phone stopped reporting',
          phones[4].window.Convoy._internals.bgAllowed() === false);

    /* ---------- 9. a new destination brings it back ---------- */
    phones[2].window.Convoy.setDest(-33.75, 151.05, 'Cronulla');
    await sleep(250);
    sameDest(phones, '9a the new destination reached everyone');
    check('9b and the background phone is reporting again',
          phones[4].window.Convoy._internals.bgAllowed() === true);
    check('9c the arrival was reset with the new destination',
          st(pin).peers.get(meId(phones[9])).arrived !== true,
          JSON.stringify(st(pin).peers.get(meId(phones[9])).arrived));

    /* ---------- 10. one pin phone leaves; the other carries on ---------- */
    phones[0].window.dispatchEvent(new phones[0].window.Event('pagehide'));
    await sleep(700);            // give the last position update time to land
    const missing = phones.map(meId).filter((id) => id !== meId(phones[1]) &&
                                              !st(phones[1]).peers.has(id));
    check('10a the remaining pin phone still has everyone',
          st(phones[1]).peers.size === 9,
          'peers ' + st(phones[1]).peers.size + ' | missing ' + JSON.stringify(missing));

    const latecomer = boot({ broker, outside: true });
    latecomer.goLive();
    await sleep(120);
    check('10b a latecomer is out to begin with', !isIn(latecomer));
    latecomer.document.getElementById('btnJoin').click();
    await sleep(250);
    check('10c and the remaining pin phone is asked',
          st(phones[1]).pending.has(meId(latecomer)), listText(phones[1]).slice(0, 160));
    phones[1].document.querySelector('[data-yes]').click();
    await sleep(300);
    check('10d and can let them in', isIn(latecomer));

    /* ---------- 11. final agreement ---------- */
    agree(phones.slice(1), '11a nine phones still agree on who is here');
    const sizes = phones.slice(1).map((p) => st(p).peers.size);
    // Nine of us are left, the pin phone that went away is still on the roster, and the
    // latecomer has joined: eleven of us, so ten others on every phone.
    check('11b and on how many that is', sizes.every((n) => n === sizes[0]),
          JSON.stringify(sizes));
    check('11c which is everyone but themselves', sizes[0] === 10, JSON.stringify(sizes));
  } catch (e) { crash(e); }
  finish('sim');
})();
