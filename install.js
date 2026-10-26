/* Convoy — getting the app onto the phone properly, on both kinds of phone.
 *
 * Three different situations, and the card says a different thing for each:
 *
 *   1. Inside another app's browser (WhatsApp, Instagram, Facebook, an Android
 *      WebView). This is what happens when someone taps a link shared in a chat.
 *      Location, notifications and installing all need the real browser, so the
 *      card tells them how to get there. It is the most important of the three,
 *      because a shared link almost always lands here first.
 *
 *   2. Android (Chrome, Edge, Samsung Internet, Brave) and desktop Chrome. The
 *      browser hands us a deferred install prompt that we fire from our own
 *      button, so it is one tap.
 *
 *   3. iOS Safari. There is no install API — Apple does not let a page trigger
 *      it — so the card points at the Share button instead. That is a platform
 *      limit, not an oversight.
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

  function isIOS() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS reports itself as a Mac, but has a touch screen.
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  // Are we inside another app's browser rather than a real one? Everything shared through
  // a chat opens here first, and it is missing location, notifications and installing.
  function appBrowser() {
    const ua = navigator.userAgent || '';
    if (/WhatsApp|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|TikTok|SnapChat/i.test(ua)) {
      return true;
    }
    if (/Android/.test(ua) && /\bwv\b/.test(ua)) return true;
    // An iOS in-app browser is a WKWebView: it says Mobile but never Safari. The real
    // browsers on iOS (Safari, Chrome, Firefox, Edge) all say Safari in the user agent.
    if (/iPhone|iPad|iPod/.test(ua) && !/Safari/.test(ua)) return true;
    return false;
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

  function hide() {
    const card = $('installCard');
    if (card) card.classList.add('hidden');
    const wrap = $('installOverlay');
    if (wrap) wrap.classList.add('hidden');
  }

  function show() {
    const card = $('installCard');
    if (card) card.classList.remove('hidden');
    const wrap = $('installOverlay');
    if (wrap) wrap.classList.remove('hidden');
  }

  function setTitle(text) {
    const el = $('installTitle');
    if (el) el.textContent = text;
  }

  function wireDismiss(persist) {
    const no = $('btnInstallNo');
    if (!no) return;
    no.addEventListener('click', () => {
      if (persist) write(LS.dismissed, '1');
      hide();
    });
  }

  const DONE = '<button id="btnInstallNo" class="linkish">Not now</button>';

  function render() {
    const card = $('installCard');
    const body = $('installBody');
    if (!card || !body) return;

    if (appBrowser()) {
      // The most useful message of the three: this is where a shared link lands.
      setTitle('Open Convoy in your browser');
      body.innerHTML =
        '<p class="install-steps">' +
          (isIOS() ? 'Tap the menu at the top, then <b>Open in Safari</b>.'
                   : 'Tap the <b>&#8942;</b> menu at the top, then <b>Open in Chrome</b>.') +
        '</p>' +
        '<p class="install-sub">Your location, notifications and adding Convoy to the home ' +
        'screen all need the real browser — the one built into a chat app cannot do them. ' +
        (isIOS() ? '' : 'And if Convoy is already on your home screen, opening it in Chrome ' +
                        'goes straight into it.') + '</p>' +
        DONE;
      wireDismiss(false);          // worth saying again next time; not remembered
    } else if (deferred) {
      setTitle('Keep Convoy on your home screen');
      body.innerHTML =
        '<p class="install-sub">It opens full-screen, like an app, and keeps working when ' +
        'the signal drops.</p>' +
        '<button id="btnInstall" class="primary">Add to home screen</button>' +
        DONE;
      $('btnInstall').addEventListener('click', async () => {
        const held = deferred;
        deferred = null;
        hide();
        try {
          held.prompt();
          await held.userChoice;
        } catch (e) { /* they closed it */ }
      });
      wireDismiss(true);
    } else if (isIOS()) {
      setTitle('Keep Convoy on your home screen');
      body.innerHTML =
        '<p class="install-steps">Tap the <b>Share</b> button in Safari, then choose ' +
        '<b>Add to Home Screen</b>.</p>' +
        '<p class="install-sub">Notifications only work once it is on your home screen.</p>' +
        DONE;
      wireDismiss(true);
    } else {
      hide();          // nothing we can offer on this browser
      return;
    }

    show();
  }

  function maybeOffer() {
    if (offered) return;

    // Inside another app's browser, say so even to someone who has used the app before:
    // the app is genuinely limited here, so it is a compatibility note, not a sales pitch.
    if (appBrowser()) { offered = true; render(); return; }

    if (isStandalone() || read(LS.dismissed)) return;

    // On Android the browser fires the install event only when the app is NOT already
    // installed, so the event itself is the signal. That is better than asking whether
    // this phone has used Convoy before, because it means deleting the app and opening
    // the link again offers it again.
    if (deferred) { offered = true; render(); return; }

    // iOS fires no such event, so fall back to asking whether this phone has used it.
    // Deleting a home-screen app on iOS clears its storage, so that comes back too.
    if (isIOS() && isFirstTime()) { offered = true; render(); return; }
  }

  // Location was refused. If we are inside another app's browser, that is usually why —
  // so say it again even if the card was dismissed.
  function showOpenInBrowser() {
    if (!appBrowser()) return;
    show();
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
    maybeOffer();

    // On an iPhone a link can never open the home-screen app — Apple gives a web page no
    // way to do it — so if it is already installed, the kindest thing is to say so.
    const note = $('iosNote');
    if (note && isIOS() && !isStandalone()) note.classList.remove('hidden');
  }

  window.ConvoyInstall = {
    init, maybeOffer, isStandalone, isFirstTime, isIOS, appBrowser, showOpenInBrowser,
    _internals: { hasPrompt: () => !!deferred, hide, render },
  };
})();
