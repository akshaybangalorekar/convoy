/* Convoy — offering to put the app on the home screen.
 *
 * On Android (Chrome, Edge, Samsung Internet, Brave) and on desktop Chrome the browser
 * hands us a deferred install prompt that we can fire from our own button, so it is a
 * single tap. On iOS Safari there is no such API — Apple does not allow a page to
 * trigger it — so the most we can do is point at the Share button. That is a platform
 * limit, not an oversight, and the card says so plainly rather than pretending.
 *
 * It is offered once, on a phone that has never used the app, and only when the app is
 * not already installed. Dismissing it is remembered.
 */
(function () {
  'use strict';

  const LS = {
    dismissed: 'convoy.install.dismissed',
    name: 'convoy.name',
    room: 'convoy.room',
  };

  let deferred = null;    // the browser's install event, held for our button
  let offered = false;

  const $ = (id) => document.getElementById(id);

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  // Already running as an installed app, rather than in a browser tab?
  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;                  // iOS
      if (!window.matchMedia) return false;
      return window.matchMedia('(display-mode: standalone)').matches ||
             window.matchMedia('(display-mode: fullscreen)').matches;
    } catch (e) { return false; }
  }

  // Never used it on this phone: no name and no room kept.
  const isFirstTime = () => !read(LS.name) && !read(LS.room);

  function isIOS() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS reports itself as a Mac, but has a touch screen.
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  function hide() {
    const card = $('installCard');
    if (card) card.classList.add('hidden');
  }

  function wireDismiss() {
    const no = $('btnInstallNo');
    if (!no) return;
    no.addEventListener('click', () => {
      write(LS.dismissed, '1');
      hide();
    });
  }

  function render() {
    const card = $('installCard');
    const body = $('installBody');
    if (!card || !body) return;

    if (deferred) {
      body.innerHTML =
        '<p class="install-sub">It opens full-screen, like an app, and keeps working when ' +
        'the signal drops.</p>' +
        '<button id="btnInstall" class="primary">Add to home screen</button>' +
        '<button id="btnInstallNo" class="linkish">Not now</button>';
      $('btnInstall').addEventListener('click', async () => {
        const held = deferred;
        deferred = null;
        hide();
        try {
          held.prompt();
          await held.userChoice;
        } catch (e) { /* they closed it */ }
      });
    } else if (isIOS()) {
      body.innerHTML =
        '<p class="install-steps">Tap the <b>Share</b> button in Safari, then choose ' +
        '<b>Add to Home Screen</b>.</p>' +
        '<button id="btnInstallNo" class="linkish">Not now</button>';
    } else {
      hide();          // nothing we can offer on this browser
      return;
    }

    wireDismiss();
    card.classList.remove('hidden');
  }

  function maybeOffer() {
    if (offered || isStandalone() || read(LS.dismissed) || !isFirstTime()) return;
    offered = true;
    render();
  }

  function init() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();          // keep it, and fire it from our own button
      deferred = e;
      maybeOffer();
    });
    window.addEventListener('appinstalled', () => {
      write(LS.dismissed, '1');
      hide();
    });

    // iOS never fires the event, so offer on the spot instead of waiting for one.
    if (isIOS()) setTimeout(maybeOffer, 400);
  }

  window.ConvoyInstall = {
    init, maybeOffer, isStandalone, isFirstTime, isIOS,
    _internals: { hasPrompt: () => !!deferred, hide, render },
  };
})();
