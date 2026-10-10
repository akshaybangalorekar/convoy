/* Headless tests for saved rooms and group voice calls.
 * jsdom + stubbed Leaflet, MQTT, WebRTC and getUserMedia. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function layer() {
  const o = {};
  ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
   'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup', 'setZIndex']
    .forEach((m) => { o[m] = () => o; });
  o.getZoom = () => 13;
  o.getPane = () => ({ style: {} });
  o.getContainer = () => ({ addEventListener: () => {} });
  o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => null });
  return o;
}

function makeStream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { _track: track, getAudioTracks: () => [track], getTracks: () => [track] };
}

function boot() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'https://convoy.test/' });
  const { window } = dom;

  window.L = {
    map: layer, tileLayer: layer, polyline: layer, latLngBounds: layer,
    control: { zoom: () => ({ addTo: () => {} }) }, divIcon: (o) => o, marker: layer,
  };

  const clients = [];
  window.mqtt = {
    connect(url) {
      const h = {};
      const c = {
        url, connected: false, published: [], subscribed: null,
        on(e, f) { (h[e] = h[e] || []).push(f); return c; },
        subscribe(t, o, cb) { c.subscribed = t; cb && cb(null); return c; },
        publish(t, m) { c.published.push(m); return c; },
        end() { c.ended = true; return c; },
        _emit(e, ...a) { (h[e] || []).forEach((f) => f(...a)); },
      };
      clients.push(c);
      return c;
    },
  };

  window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  window.speechSynthesis = { speak() {}, cancel() {} };
  window.SpeechSynthesisUtterance = function () {};
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) window.crypto.getRandomValues = (a) => a;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {} };

  // --- WebRTC + microphone stubs
  const pcs = [];
  class FakePC {
    constructor() {
      this.localDescription = null; this.remoteDescription = null;
      this.connectionState = 'new'; this.tracks = [];
      pcs.push(this);
    }
    addTrack(t) { this.tracks.push(t); }
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  }
  window.RTCPeerConnection = FakePC;
  window.RTCSessionDescription = function (d) { return d; };
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

  const streams = [];
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => { const s = makeStream(); streams.push(s); return s; } },
  });

  window.eval(fs.readFileSync(path.join(DIR, 'route.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'voice.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
  return { window, stubs: { clients, pcs, streams } };
}

function join(window, stubs, room, name) {
  const d = window.document;
  d.getElementById('inName').value = name;
  d.getElementById('inRoom').value = room;
  d.getElementById('btnJoin').click();
  const c = stubs.clients[0];
  c.connected = true;
  c._emit('connect');
  return c;
}

const lastSent = (c, t) => {
  const m = c.published.filter((x) => x.includes('"t":"' + t + '"'));
  return m.length ? JSON.parse(m[m.length - 1]) : null;
};
const rooms = (window) => JSON.parse(window.localStorage.getItem('convoy.rooms') || '{}');

/* ---------- Rooms ---------- */
async function testSavedRooms() {
  const { window, stubs } = boot();
  const d = window.document;
  const c = join(window, stubs, 'goa-trip', 'Akshay');
  await sleep(20);

  check('joining saves the room', !!rooms(window)['goa-trip'], Object.keys(rooms(window)).join(','));
  check('the room remembers you',
        Object.values(rooms(window)['goa-trip'].members).some((m) => m.name === 'Akshay'));

  c._emit('message', 'x', Buffer.from(JSON.stringify({
    t: 'pos', id: 'peer-1', name: 'Priya', lat: 15.5, lng: 73.8, ts: Date.now(),
  })));
  await sleep(20);
  check('the room remembers other people',
        Object.values(rooms(window)['goa-trip'].members).some((m) => m.name === 'Priya'),
        JSON.stringify(rooms(window)['goa-trip'].members));

  d.getElementById('btnRooms').click();
  const list = d.getElementById('savedRooms').textContent;
  check('the room is listed by the Rooms button', /goa-trip/.test(list), list);
  check('the list names the people', /Priya/.test(list), list);
  check('the list shows a head count', /2 people/.test(list), list);
  check('a way back to the map is offered',
        d.getElementById('btnJoinCancel').style.display !== 'none');
  d.getElementById('btnJoinCancel').click();
  check('that returns to the map', d.getElementById('join').classList.contains('hidden'));

  // rejoin from the list
  d.getElementById('btnRooms').click();
  d.querySelector('.sr-row').click();
  await sleep(30);
  check('tapping a saved room rejoins it', d.getElementById('roomLabel').textContent === 'goa-trip',
        d.getElementById('roomLabel').textContent);
  check('rejoining does not lose the record', !!rooms(window)['goa-trip']);

  // forget
  d.getElementById('btnRooms').click();
  d.querySelector('.sr-forget').click();
  await sleep(20);
  check('Forget removes the room', !rooms(window)['goa-trip'], Object.keys(rooms(window)).join(','));
}

/* ---------- Voice: outgoing ---------- */
async function testOutgoingCall() {
  const { window, stubs } = boot();
  const d = window.document;
  const c = join(window, stubs, 'call-room', 'Akshay');
  await sleep(20);

  check('the call bar is hidden before calling',
        !d.getElementById('callBar').classList.contains('show'));
  d.getElementById('btnTalk').click();
  await sleep(40);

  const invite = lastSent(c, 'voice-invite');
  check('tapping Talk rings the room', !!invite, JSON.stringify(invite));
  check('a call id is broadcast', !!(invite && /^v-/.test(invite.callId)), invite && invite.callId);
  check('the call bar appears', d.getElementById('callBar').classList.contains('show'));
  check('the page is marked in-call', d.body.classList.contains('in-call'));
  check('the microphone was requested', stubs.streams.length === 1, String(stubs.streams.length));
  check('push-to-talk starts muted', stubs.streams[0]._track.enabled === false,
        String(stubs.streams[0]._track.enabled));

  c._emit('message', 'x', Buffer.from(JSON.stringify({
    t: 'voice-accept', id: 'peer-1', by: 'Priya', callId: invite.callId,
  })));
  await sleep(40);
  const offer = lastSent(c, 'voice-offer');
  check('an offer goes to the joiner', !!offer);
  check('the offer is addressed to them', offer && offer.to === 'peer-1', offer && offer.to);
  check('a peer connection was created', stubs.pcs.length === 1, String(stubs.pcs.length));
  check('the call bar counts them', /2/.test(d.getElementById('callStatus').textContent),
        d.getElementById('callStatus').textContent);

  d.getElementById('callMute').click();
  await sleep(10);
  check('open mic unmutes', stubs.streams[0]._track.enabled === true);
  check('the button relabels to Open mic',
        d.getElementById('callMute').textContent === 'Open mic', d.getElementById('callMute').textContent);
  d.getElementById('callMute').click();
  await sleep(10);
  check('back to push to talk', d.getElementById('callMute').textContent === 'Push to talk');
  check('and muted again', stubs.streams[0]._track.enabled === false);

  d.getElementById('callLeave').click();
  await sleep(20);
  check('leaving tells the room', !!lastSent(c, 'voice-bye'));
  check('the call bar hides', !d.getElementById('callBar').classList.contains('show'));
  check('the microphone was released', stubs.streams[0]._track.stopped === true);
  check('the in-call mark is cleared', !d.body.classList.contains('in-call'));
}

/* ---------- Voice: incoming ---------- */
async function testIncomingCall() {
  const { window, stubs } = boot();
  const d = window.document;
  const c = join(window, stubs, 'ring-room', 'Akshay');
  await sleep(20);

  check('no incoming prompt yet', !d.getElementById('callIncoming').classList.contains('show'));
  c._emit('message', 'x', Buffer.from(JSON.stringify({
    t: 'voice-invite', id: 'peer-9', by: 'Priya', callId: 'v-abc123',
  })));
  await sleep(20);
  check('an invite rings the phone', d.getElementById('callIncoming').classList.contains('show'));
  check('the prompt names the caller', /Priya/.test(d.getElementById('callWho').textContent),
        d.getElementById('callWho').textContent);

  d.getElementById('callAccept').click();
  await sleep(40);
  const acc = lastSent(c, 'voice-accept');
  check('accepting answers the caller', !!acc && acc.to === 'peer-9', JSON.stringify(acc));
  check('the prompt closes on accept', !d.getElementById('callIncoming').classList.contains('show'));
  check('we are in the call', d.getElementById('callBar').classList.contains('show'));

  // --- decline path
  const b = boot();
  const d2 = b.window.document;
  const c2 = join(b.window, b.stubs, 'ring2', 'Akshay');
  await sleep(20);
  c2._emit('message', 'x', Buffer.from(JSON.stringify({
    t: 'voice-invite', id: 'peer-8', by: 'Rahul', callId: 'v-xyz',
  })));
  await sleep(20);
  d2.getElementById('callDecline').click();
  await sleep(20);
  check('declining tells the caller', !!lastSent(c2, 'voice-decline'));
  check('declining closes the prompt', !d2.getElementById('callIncoming').classList.contains('show'));

  // --- an invite while already in a call is ignored
  const before = d.getElementById('callWho').textContent;
  c._emit('message', 'x', Buffer.from(JSON.stringify({
    t: 'voice-invite', id: 'peer-7', by: 'Meera', callId: 'v-later',
  })));
  await sleep(20);
  check('a second invite does not interrupt a call',
        !d.getElementById('callIncoming').classList.contains('show'),
        d.getElementById('callWho').textContent + ' (was ' + before + ')');
}

/* ---------- Voice: no microphone ---------- */
async function testNoMic() {
  const { window, stubs } = boot();
  const d = window.document;
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => { throw new Error('denied'); } },
  });
  const c = join(window, stubs, 'nomic', 'Akshay');
  await sleep(20);
  d.getElementById('btnTalk').click();
  await sleep(40);
  check('a blocked microphone does not start a call',
        !d.getElementById('callBar').classList.contains('show'));
  check('a blocked microphone does not ring anyone', !lastSent(c, 'voice-invite'));
  check('the user is told why', /Microphone blocked/.test(d.getElementById('toast').textContent),
        d.getElementById('toast').textContent);
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testSavedRooms();
    await testOutgoingCall();
    await testIncomingCall();
    await testNoMic();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
