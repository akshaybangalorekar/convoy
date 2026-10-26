/* Offering to put the app on the home screen, once, on a phone that has never used it. */
'use strict';

const { boot, check, sleep, finish, crash } = require('./harness');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
               '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const card = (api) => api.document.getElementById('installCard');
const body = (api) => api.document.getElementById('installBody').textContent;
// Visible means visible: the card has its own overlay now, and a card inside a hidden
// overlay is not something anyone can see.
const shown = (api) => {
  const wrap = api.document.getElementById('installOverlay');
  return !card(api).classList.contains('hidden') && !!wrap && !wrap.classList.contains('hidden');
};

/* ---------- Who gets offered it ---------- */
async function testTheOfferComesBackIfTheAppIsDeleted() {
  // A phone that has used Convoy before but is not running it from the home screen:
  // either the app was deleted, or it was never installed. The browser only fires the
  // install event when the app is not installed, so the event is the signal — which is
  // why this no longer depends on remembering whether the phone is new.
  const api = boot({ setup: (w) => {
    w.localStorage.setItem('convoy.name', 'Akshay');
    w.localStorage.setItem('convoy.room', 'goa-trip');
  } });
  await sleep(20);
  check('nothing is offered before the browser says it can be installed', !shown(api));
  api.installPrompt();
  await sleep(20);
  check('deleting the app and opening the link again offers it again', shown(api), body(api));
}

async function testOfferedOnAndroid() {
  const api = boot();
  await sleep(20);
  check('nothing is offered before the browser says it can be', !shown(api));

  const seen = api.installPrompt();
  await sleep(20);
  check('the browser\'s install offer brings up our card', shown(api));
  check('it says what it is for', /home screen/i.test(card(api).textContent),
        card(api).textContent);
  check('there is a button to install',
        !!api.document.getElementById('btnInstall'));
  check('and a way to say no', !!api.document.getElementById('btnInstallNo'));

  api.document.getElementById('btnInstall').click();
  await sleep(20);
  check('tapping it fires the browser\'s own install prompt', seen.prompted);
  check('and our card gets out of the way', !shown(api));
}

async function testDismissingIsRemembered() {
  const api = boot();
  await sleep(20);
  api.installPrompt();
  await sleep(20);
  api.document.getElementById('btnInstallNo').click();
  await sleep(20);

  check('saying not now hides the card', !shown(api));
  check('and is remembered', api.window.localStorage.getItem('convoy.install.dismissed') === '1',
        String(api.window.localStorage.getItem('convoy.install.dismissed')));

  // and it does not come back in the same session
  api.installPrompt();
  await sleep(20);
  check('and it does not come back', !shown(api));
}

async function testNotOfferedInsideTheInstalledApp() {
  const api = boot({ setup: (w) => {
    Object.defineProperty(w.navigator, 'standalone', { configurable: true, value: true });
  } });
  api.installPrompt();
  await sleep(30);
  check('an app already on the home screen is not asked again', !shown(api));
  check('and no install event is even expected there',
        api.window.ConvoyInstall.isStandalone() === true);
}

/* ---------- iOS, where the browser will not let us ---------- */
async function testIOSGetsInstructions() {
  const api = boot({ setup: (w) => {
    Object.defineProperty(w.navigator, 'userAgent', { configurable: true, get: () => IPHONE });
  } });
  await sleep(30);
  check('iOS is recognised', api.window.ConvoyInstall.isIOS() === true);
  check('the card appears without waiting for an event iOS will never fire',
        shown(api), body(api));
  check('with the instructions, since there is no button we can press',
        /Share/.test(body(api)) && /Add to Home Screen/.test(body(api)), body(api));
  check('and no install button that would do nothing',
        !api.document.getElementById('btnInstall'));
  check('but still a way to say no', !!api.document.getElementById('btnInstallNo'));
}

/* ---------- An invite link survives installing ---------- */
async function testInviteIsRemembered() {
  const api = boot({ setup: (w) => {
    w.history.replaceState(null, '', '/#r=ride-7f3k9');
  } });
  await sleep(20);
  check('opening a link remembers the code',
        api.window.localStorage.getItem('convoy.invite') === 'ride-7f3k9',
        String(api.window.localStorage.getItem('convoy.invite')));
}

async function testInviteSurvivesInstalling() {
  // They opened the link once, installed, and the installed app opened at the root. With
  // one room for everyone there is no code to carry across, so installing cannot lose it.
  const api = boot({ setup: (w) => {
    w.localStorage.setItem('convoy.invite', 'goa-trip');     // left by an older build
  } });
  await sleep(20);
  const d = api.document;
  check('installing cannot lose your place, because there is no code to lose',
        api.window.Convoy.state.room === 'convoy', api.window.Convoy.state.room);
  check('and the app opens straight onto the map',
        d.getElementById('join').classList.contains('hidden'));
}

/* ---------- Links shared through a chat land in the app's own browser ---------- */
// An iOS in-app browser is a WKWebView: it says Mobile but never Safari.
const APP_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
                '(KHTML, like Gecko) Mobile/15E148';
// Android in-app browsers are WebViews, which mark themselves with "wv".
const APP_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 ' +
                    'Mobile Safari/537.36';
const REAL_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
                 '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const REAL_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

const withUA = (ua) => (w) => Object.defineProperty(w.navigator, 'userAgent',
  { configurable: true, get: () => ua });

async function testSharedLinksLandInAppBrowsers() {
  const ios = boot({ setup: withUA(APP_IOS) });
  await sleep(30);
  check('an iPhone\'s in-app browser is recognised',
        ios.window.ConvoyInstall.appBrowser() === true);
  check('the card appears straight away, with no waiting for an event', shown(ios), body(ios));
  check('it says to open Convoy in the real browser',
        /Open Convoy in your browser/i.test(card(ios).textContent), card(ios).textContent);
  check('and where that button is on an iPhone', /Safari/.test(body(ios)), body(ios));
  check('explaining what will not work in there',
        /location/i.test(body(ios)) && /notification/i.test(body(ios)), body(ios));
  check('and offering no install button that could not work',
        !ios.document.getElementById('btnInstall'));

  const android = boot({ setup: withUA(APP_ANDROID) });
  await sleep(30);
  check('an Android in-app browser is recognised',
        android.window.ConvoyInstall.appBrowser() === true);
  check('and it points at Chrome', /Chrome/.test(body(android)), body(android));
}

async function testRealBrowsersAreNotMistakenForAppBrowsers() {
  const safari = boot({ setup: withUA(REAL_IOS) });
  check('Safari is not mistaken for an app browser',
        safari.window.ConvoyInstall.appBrowser() === false);
  const chrome = boot({ setup: withUA(REAL_ANDROID) });
  check('nor is Chrome on Android', chrome.window.ConvoyInstall.appBrowser() === false);
  const plain = boot();
  check('nor is a desktop browser', plain.window.ConvoyInstall.appBrowser() === false);
}

async function testTheAppBrowserNoteRepeats() {
  const api = boot({ setup: withUA(APP_ANDROID) });
  await sleep(30);
  api.document.getElementById('btnInstallNo').click();
  await sleep(10);
  check('it can be dismissed for now', !shown(api));
  check('but that is not remembered, because it matters on every visit',
        api.window.localStorage.getItem('convoy.install.dismissed') === null,
        String(api.window.localStorage.getItem('convoy.install.dismissed')));
}

async function testItIsShownEvenToSomeoneWhoHasUsedTheApp() {
  const api = boot({ setup: (w) => {
    w.localStorage.setItem('convoy.name', 'Akshay');
    w.localStorage.setItem('convoy.room', 'goa-trip');
    withUA(APP_IOS)(w);
  } });
  await sleep(30);
  check('a returning user inside a chat app is still told the app is limited there',
        shown(api), body(api));
}

async function testARefusedLocationSaysWhy() {
  const api = boot({ setup: withUA(APP_IOS) });
  await sleep(30);
  api.document.getElementById('btnInstallNo').click();
  await sleep(10);
  check('dismissed for now', !shown(api));

  api.join('Akshay', 'goa-trip');
  api.geoError(1);                       // permission denied
  await sleep(10);
  check('a refused location brings the note back, since that is usually the reason',
        shown(api), body(api));
}

/* ---------- A link cannot open the installed app on an iPhone ---------- */
const iosNote = (api) => api.document.getElementById('iosNote');
const noteShown = (api) => !iosNote(api).classList.contains('hidden');

async function testTheIPhoneIsToldWhereToOpenIt() {
  const ios = boot({ setup: withUA(REAL_IOS) });
  await sleep(30);
  check('an iPhone is told a link opens in Safari, not the home-screen app',
        noteShown(ios), iosNote(ios).textContent);
  check('and where to go instead', /home screen/i.test(iosNote(ios).textContent),
        iosNote(ios).textContent);

  const android = boot({ setup: withUA(REAL_ANDROID) });
  await sleep(30);
  check('Android is not told that, because there a link does open the installed app',
        !noteShown(android));

  const installed = boot({ setup: (w) => {
    withUA(REAL_IOS)(w);
    Object.defineProperty(w.navigator, 'standalone', { configurable: true, value: true });
  } });
  await sleep(30);
  check('nor is an app already on the home screen', !noteShown(installed));

  const plain = boot();
  await sleep(30);
  check('nor is a desktop browser', !noteShown(plain));
}

async function testTheIPhoneNoteWalksThemThroughIt() {
  const api = boot({ setup: (w) => {
    withUA(REAL_IOS)(w);
    w.history.replaceState(null, '', '/#r=goa-trip');
  } });
  await sleep(30);
  const note = iosNote(api).textContent;
  check('the note names both steps: add it, then open it from the home screen',
        /Add to Home Screen/.test(note) && /home screen/i.test(note), note);
  check('and says plainly that there is no way round it',
        /no way round it|always opens/.test(note), note);

  // There is no code to carry across any more, so the note asks for nothing.
  check('and asks for no code, since there is none',
        !/code/i.test(note) || !/paste/i.test(note), note);
}

async function testAndroidIsToldWhereTheHandOffLands() {
  const api = boot({ setup: withUA(APP_ANDROID) });
  await sleep(30);
  check('an Android phone in a chat app is told the browser hand-off reaches the app',
        /goes straight into it/.test(body(api)), body(api));
}

/* ---------- Run ---------- */
(async () => {
  try {
    await testTheOfferComesBackIfTheAppIsDeleted();
    await testOfferedOnAndroid();
    await testDismissingIsRemembered();
    await testNotOfferedInsideTheInstalledApp();
    await testIOSGetsInstructions();
    await testInviteIsRemembered();
    await testInviteSurvivesInstalling();
    await testSharedLinksLandInAppBrowsers();
    await testRealBrowsersAreNotMistakenForAppBrowsers();
    await testTheAppBrowserNoteRepeats();
    await testItIsShownEvenToSomeoneWhoHasUsedTheApp();
    await testARefusedLocationSaysWhy();
    await testTheIPhoneIsToldWhereToOpenIt();
    await testTheIPhoneNoteWalksThemThroughIt();
    await testAndroidIsToldWhereTheHandOffLands();
  } catch (e) { crash(e); }
  finish('install');
})();
