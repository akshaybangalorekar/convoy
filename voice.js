/* Convoy — group voice calls
 * ------------------------------------------------------------------
 * A WebRTC audio mesh between everyone in the room. The signalling
 * rides on the room's existing MQTT bus, so there is no extra server:
 *
 *   tap Talk  -> "voice-invite" broadcast  -> every phone rings
 *   accept    -> "voice-accept" to the caller -> caller sends an offer
 *   offer/answer/ice -> targeted peer-to-peer, then DTLS-SRTP audio
 *
 * Default mode is push-to-talk (hold the Talk button); the call bar can
 * switch to an open mic so everyone talks at once.
 *
 * LIMITS, honestly:
 *   - Only public STUN is configured. With no TURN relay, calls fail on
 *     strict NATs and some mobile networks. Add a TURN server to fix that.
 *   - Signalling goes over the public broker in the clear (the audio
 *     itself is encrypted end to end).
 *   - A mesh gets heavy past ~6 people.
 */
(function () {
  'use strict';

  let API = null;

  const CFG = {
    // Public STUN only — see the note above about TURN.
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    ringMs: 30000,
    maxPeers: 8,
  };

  const V = {
    callId: null,
    active: false,
    initiator: false,
    incoming: null,      // { callId, from, by, timer }
    peers: {},           // id -> { pc, el, pending: [] }
    open: false,         // open mic, rather than push-to-talk
    holding: false,      // true while the Talk button is held down
    local: null,
  };

  const $ = (id) => document.getElementById(id);
  const me = () => API.state.me;

  /* ---------------------------------------------------------------- *
   * Messaging over the room bus
   * ---------------------------------------------------------------- */
  function send(obj) {
    const m = me();
    if (!m || !API.state.joined) return;
    API.send(Object.assign({ id: m.id, by: m.name, ts: Date.now() }, obj));
  }
  const sendTo = (to, obj) => send(Object.assign({ to }, obj));

  /* ---------------------------------------------------------------- *
   * Ringing
   * ---------------------------------------------------------------- */
  let ringCtx = null, ringTimer = null;

  function ringStart() {
    try {
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
    } catch (e) { /* ignore */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ringCtx = ringCtx || new Ctx();
      const beep = (at, freq) => {
        const o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, ringCtx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.25, ringCtx.currentTime + at + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + at + 0.35);
        o.connect(g); g.connect(ringCtx.destination);
        o.start(ringCtx.currentTime + at);
        o.stop(ringCtx.currentTime + at + 0.4);
      };
      const pattern = () => { beep(0, 880); beep(0.45, 660); };
      pattern();
      ringTimer = setInterval(pattern, 1800);
    } catch (e) { /* no audio, no problem */ }
  }

  function ringStop() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  }

  /* ---------------------------------------------------------------- *
   * Local microphone
   * ---------------------------------------------------------------- */
  async function getMic() {
    if (V.local) return V.local;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      API.toast('This browser cannot use the microphone');
      return null;
    }
    try {
      V.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      API.toast('Microphone blocked — allow it to talk');
      return null;
    }
    applyMicState();
    return V.local;
  }

  function applyMicState() {
    if (!V.local) return;
    // Push-to-talk: the track stays disabled unless we are open-mic or holding.
    const on = !!(V.open || V.holding);
    V.local.getAudioTracks().forEach((t) => { t.enabled = on; });
    const btn = $('callMute');
    if (btn) btn.textContent = V.open ? 'Open mic' : 'Push to talk';
  }

  function stopMic() {
    if (!V.local) return;
    try { V.local.getTracks().forEach((t) => t.stop()); } catch (e) {}
    V.local = null;
  }

  /* ---------------------------------------------------------------- *
   * Peer connections
   * ---------------------------------------------------------------- */
  function peerFor(id) {
    if (V.peers[id]) return V.peers[id];
    const pc = new RTCPeerConnection({ iceServers: CFG.iceServers });
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.dataset.peer = id;
    document.body.appendChild(el);

    const entry = { pc, el, pending: [] };
    V.peers[id] = entry;

    if (V.local) V.local.getTracks().forEach((t) => pc.addTrack(t, V.local));

    pc.onicecandidate = (e) => {
      if (e.candidate) sendTo(id, { t: 'voice-ice', callId: V.callId, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      try {
        el.srcObject = e.streams[0];
        el.play().catch(() => {});
      } catch (err) { /* ignore */ }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(id);
      renderBar();
    };
    return entry;
  }

  function dropPeer(id) {
    const p = V.peers[id];
    if (!p) return;
    try { p.pc.close(); } catch (e) {}
    try { p.el.remove(); } catch (e) {}
    delete V.peers[id];
    renderBar();
  }

  async function flushPending(id) {
    const p = V.peers[id];
    if (!p || !p.pc.remoteDescription) return;
    const queued = p.pending.splice(0, p.pending.length);
    for (const c of queued) {
      try { await p.pc.addIceCandidate(c); } catch (e) { /* ignore */ }
    }
  }

  const peerCount = () => Object.keys(V.peers).length;

  /* ---------------------------------------------------------------- *
   * Call lifecycle
   * ---------------------------------------------------------------- */
  async function startCall() {
    if (V.active) return;
    if (!API.state.joined) { API.toast('Join a room first'); return; }
    if (typeof RTCPeerConnection !== 'function') {
      API.toast('This browser cannot make calls');
      return;
    }
    const stream = await getMic();
    if (!stream) return;
    V.callId = 'v-' + Math.random().toString(36).slice(2, 10);
    V.active = true;
    V.initiator = true;
    V.open = false;
    send({ t: 'voice-invite', callId: V.callId });
    API.toast('Calling the room…');
    renderBar();
  }

  function onInvite(msg) {
    if (V.active) return;                       // already in a call
    if (msg.to && msg.to !== (me() || {}).id) return;
    if (V.incoming && V.incoming.callId === msg.callId) return;
    V.incoming = {
      callId: msg.callId, from: msg.id, by: msg.by || 'Someone',
      timer: setTimeout(() => { decline(true); }, CFG.ringMs),
    };
    $('callWho').textContent = (msg.by || 'Someone') + ' is calling';
    $('callIncoming').classList.add('show');
    ringStart();
  }

  async function acceptCall() {
    const inc = V.incoming;
    if (!inc) return;
    ringStop();
    clearTimeout(inc.timer);
    $('callIncoming').classList.remove('show');
    V.incoming = null;

    const stream = await getMic();
    if (!stream) return;
    V.callId = inc.callId;
    V.active = true;
    V.initiator = false;
    V.open = false;
    send({ t: 'voice-accept', callId: V.callId, to: inc.from });
    renderBar();
    API.toast('Joined the call — hold Talk to speak');
  }

  function decline(silent) {
    const inc = V.incoming;
    ringStop();
    if (inc) {
      clearTimeout(inc.timer);
      if (!silent) send({ t: 'voice-decline', callId: inc.callId, to: inc.from });
      V.incoming = null;
    }
    $('callIncoming').classList.remove('show');
  }

  async function onAccept(msg) {
    if (!V.active || !V.initiator || msg.callId !== V.callId) return;
    if (peerCount() >= CFG.maxPeers) return;
    const p = peerFor(msg.id);
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      sendTo(msg.id, { t: 'voice-offer', callId: V.callId, sdp: p.pc.localDescription });
      renderBar();
    } catch (e) { dropPeer(msg.id); }
  }

  async function onOffer(msg) {
    if (!V.active || msg.callId !== V.callId) return;
    const p = peerFor(msg.id);
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      await flushPending(msg.id);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendTo(msg.id, { t: 'voice-answer', callId: V.callId, sdp: p.pc.localDescription });
      renderBar();
    } catch (e) { dropPeer(msg.id); }
  }

  async function onAnswer(msg) {
    const p = V.peers[msg.id];
    if (!p || msg.callId !== V.callId) return;
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      await flushPending(msg.id);
    } catch (e) { dropPeer(msg.id); }
  }

  async function onIce(msg) {
    const p = peerFor(msg.id);
    const cand = msg.candidate;
    if (!p.pc.remoteDescription) { p.pending.push(cand); return; }
    try { await p.pc.addIceCandidate(cand); } catch (e) { /* ignore */ }
  }

  function leaveCall(broadcast) {
    if (broadcast !== false && V.active) send({ t: 'voice-bye', callId: V.callId });
    Object.keys(V.peers).forEach(dropPeer);
    stopMic();
    V.active = false;
    V.initiator = false;
    V.callId = null;
    V.holding = false;
    V.open = false;
    renderBar();
  }

  function onBye(msg) {
    if (V.active && msg.callId === V.callId) {
      if (msg.to && msg.to !== (me() || {}).id) { dropPeer(msg.id); return; }
      if (!V.initiator) {           // the caller hung up: the call is over
        leaveCall(false);
        API.toast('The call ended');
      }
    }
    if (V.incoming && V.incoming.callId === msg.callId) decline(true);
  }

  /* ---------------------------------------------------------------- *
   * UI
   * ---------------------------------------------------------------- */
  function renderBar() {
    const bar = $('callBar');
    if (!bar) return;
    if (!V.active) {
      bar.classList.remove('show');
      $('btnTalk').textContent = 'Talk';
      $('btnTalk').classList.remove('on');
      document.body.classList.remove('in-call');
      return;
    }
    const n = peerCount();
    $('callStatus').textContent = 'In a call · ' + (n + 1) + (n === 0 ? ' · waiting' : '');
    bar.classList.add('show');
    $('btnTalk').textContent = V.open ? 'Talk' : 'Hold to talk';
    $('btnTalk').classList.add('on');
    document.body.classList.add('in-call');
    applyMicState();
  }

  function toggleOpenMic() {
    V.open = !V.open;
    applyMicState();
    renderBar();
    API.toast(V.open ? 'Open mic — everyone can talk' : 'Push to talk — hold the button');
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function init(api) {
    API = api;
    if (typeof RTCPeerConnection !== 'function') {
      // Still allow starting a call from a device that can't, so we fail loudly.
    }

    const talk = $('btnTalk');
    const isTouch = window.PointerEvent !== undefined;

    const down = (e) => {
      if (!V.active) return;                 // a plain tap starts the call
      if (e && e.preventDefault) e.preventDefault();
      V.holding = true;
      applyMicState();
    };
    const up = () => {
      if (!V.holding) return;
      V.holding = false;
      applyMicState();
    };

    talk.addEventListener('click', () => {
      if (!V.active) { startCall(); return; }
      if (V.open) return;                    // open mic needs no holding
      // A tap (rather than a hold) toggles open mic, so it is discoverable.
      toggleOpenMic();
    });
    if (isTouch) {
      talk.addEventListener('pointerdown', down);
      talk.addEventListener('pointerup', up);
      talk.addEventListener('pointercancel', up);
      talk.addEventListener('pointerleave', up);
    } else {
      talk.addEventListener('mousedown', down);
      talk.addEventListener('mouseup', up);
    }

    $('callAccept').addEventListener('click', acceptCall);
    $('callDecline').addEventListener('click', () => decline(false));
    $('callMute').addEventListener('click', toggleOpenMic);
    $('callLeave').addEventListener('click', () => leaveCall(true));

    // Leaving the room ends any call.
    api.hooks.onLeave = () => leaveCall(true);
    api.hooks.onVoice = onMessage;
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'voice-invite':  onInvite(msg); break;
      case 'voice-accept':  onAccept(msg); break;
      case 'voice-decline': if (V.incoming && V.incoming.callId === msg.callId) decline(true); break;
      case 'voice-offer':   onOffer(msg); break;
      case 'voice-answer':  onAnswer(msg); break;
      case 'voice-ice':     onIce(msg); break;
      case 'voice-bye':     onBye(msg); break;
      default: break;
    }
  }

  window.ConvoyVoice = {
    init,
    _internals: { CFG, V, startCall, acceptCall, decline, leaveCall, onMessage,
                  renderBar, toggleOpenMic, peerCount },
  };
})();
