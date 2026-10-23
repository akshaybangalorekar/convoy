/* The installable shell: manifest, icons, service worker, and the shape of the app. */
'use strict';

const fs = require('fs');
const path = require('path');
const { check, finish, crash, DIR } = require('./harness');

const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(DIR, p));

try {
  const html = read('index.html');
  const css = read('styles.css');
  const sw = read('sw.js');
  const app = read('app.js');
  const install = read('install.js');

  /* ---------- What the app is ---------- */
  check('the page loads the map library', /unpkg\.com\/leaflet@/.test(html));
  check('the page loads the relay library', /unpkg\.com\/mqtt@/.test(html));
  check('the page loads the routing module', /<script src="route\.js">/.test(html));
  check('the page loads the app', /<script src="app\.js">/.test(html));

  /* ---------- What it is not ---------- */
  ['voice.js', 'sync.js'].forEach((f) => {
    check(f + ' is gone', !exists(f));
    check(f + ' is not loaded', html.indexOf(f) < 0 && sw.indexOf(f) < 0);
  });
  check('the map rotation plugin is gone', html.indexOf('leaflet-rotate') < 0 &&
        sw.indexOf('leaflet-rotate') < 0);
  ['navbanner', 'offlineBar', 'btnFit', 'btnFollow', 'btnNames', 'micSwitch', 'a2hs']
    .forEach((gone) => {
      check('the old ' + gone + ' control is gone', html.indexOf(gone) < 0);
    });
  check('turn-by-turn is gone', app.indexOf('speechSynthesis') < 0);
  check('the GitHub token settings are gone', app.indexOf('github_pat') < 0 &&
        app.indexOf('localStorage.setItem(\'convoy.sync') < 0);

  /* ---------- The three things it does ---------- */
  check('there is an invite button', /id="btnInvite"/.test(html));
  check('the invite copies a room link', /navigator\.clipboard\.writeText/.test(app) ||
        /navigator\.share/.test(app));
  check('there is a destination row', /id="destRow"/.test(html));
  check('one tap zooms out and two zoom in', /function handleTap/.test(app));
  check('the browser double tap is off so ours is the only one',
        /doubleClickZoom: false/.test(app));
  check('anyone can set the destination', /function setDest/.test(app) &&
        /t: 'dest'/.test(app));
  check('the destination travels to the room', /'dest-clear'/.test(app));
  check('arrival times are published', /t: 'eta'/.test(app));
  check('and shown for each person', /function etaCell/.test(app));
  check('the app says when it goes to the background', /t: 'away'/.test(app));
  check('and when it comes back', /t: 'back'/.test(app));
  check('a phone pushes its whole state on reconnecting', /function sendState/.test(app));
  check('the room, and the destination in it, are remembered on the phone',
        /convoy\.room\./.test(app));
  check('install.js is precached and loaded',
        /install\.js/.test(sw) && /install\.js/.test(html));
  check('the app offers to go on the home screen', /function maybeOffer/.test(install));
  check('using the browser\'s own prompt where it is allowed',
        /beforeinstallprompt/.test(install));
  check('and instructions for iOS, where it is not',
        /Add to Home Screen/.test(install));
  check('the offer is remembered once dismissed', /install\.dismissed/.test(install));
  check('an invite link is kept, so installing does not lose the room',
        /convoy\.invite/.test(app));

  /* ---------- Same on both kinds of phone ---------- */
  check('a link opened inside a chat app is noticed', /function appBrowser/.test(install));
  check('and it says to open Convoy in the real browser',
        /Open Convoy in your browser/.test(install));
  check('pointing at Safari on an iPhone and Chrome on Android',
        /Open in Safari/.test(install) && /Open in Chrome/.test(install));
  check('a refused location says the same thing', /showOpenInBrowser/.test(install));
  check('the invite link goes in the share text as well as the url',
        /Join my Convoy group: ' \+ url/.test(app));
  check('the old copy method is kept for browsers that block the clipboard',
        /execCommand/.test(app));
  check('the link is shown to copy by hand when nothing else works',
        /id="shareUrl"/.test(html) && /function showLink/.test(app));
  check('both link shapes are accepted, hash and query',
        /function roomFromUrl/.test(app) && /location\.search/.test(app));
  check('the back button closes the search sheet rather than leaving the app',
        /convoySheet/.test(read('route.js')) && /popstate/.test(read('route.js')));
  check('the map does not let a double tap zoom the page on iOS',
        /touch-action: none/.test(css));
  check('overlays scroll, so the keyboard does not push the card off screen',
        /overflow-y: auto/.test(css) && /margin: auto/.test(css));

  /* ---------- The later features ---------- */
  check('the sheet has exactly one switch, and it takes you off the map',
        /id="btnPause"/.test(html) && /Hide my location/.test(html) &&
        !/id="btnSaver"/.test(html) && !/id="btnSound"/.test(html) &&
        !/id="btnHere"/.test(html));
  check('sharing is set for battery life, with no switch for it',
        /publishMs: 30000/.test(app) && !/saverPublishMs/.test(app));
  check('the room can be named', /id="inRoomName"/.test(html) && /function setRoomName/.test(app));
  check('the name is shared with the room', /t: 'room-name'/.test(app));
  check('a long press on the map sets the destination',
        /on\('contextmenu'/.test(app) && /function onMapLongPress/.test(app));
  check('and looks up what is there', /function reverse/.test(read('route.js')) &&
        /nominatimReverse/.test(read('route.js')));
  check('arrivals are announced', /has arrived/.test(app) && /function checkArrivals/.test(app));
  check('and are automatic within fifty metres', /arrivedM: 50/.test(app));
  check('there is no button to press to arrive', !/btnHere/.test(app) &&
        /function checkArrivals/.test(app));
  check('and the arrival time gives way to arrived once they are there',
        /peta arrived/.test(app) && /\.peta\.arrived/.test(css));
  check('out-of-contact people say when they were last heard from',
        /last seen /.test(app) && /function lastSeenOf/.test(app));
  check('and who is behind or ahead of you', /behind you/.test(app) && /ahead of you/.test(app));
  check('pausing is announced rather than looking like silence',
        /state\.paused \? 'paused' : 'sharing'/.test(app));
  check('a notification makes a sound', /function ping/.test(app) && /AudioContext/.test(app));
  check('and nothing is played before the page is touched', /once: true, passive: true/.test(app));
  check('pasting the invite link into the code box works', /function extractRoomCode/.test(app));
  check('tapping a person brings the map to them', /function focusPeer/.test(app));
  check('the new messages are all handled',
        /case 'paused'/.test(app) && /case 'sharing'/.test(app) &&
        /case 'arrived'/.test(app) && /case 'room-name'/.test(app));
  check('a room lasts a week by default', /roomDays: 7/.test(app));
  check('nobody is dropped from the room while it is open', /roomLifeMs/.test(app));
  check('closing the app is not treated as leaving', !/beforeunload/.test(app));
  check('silence is reported honestly, not as a kill',
        /out of contact/.test(app) && !/was killed/.test(app));
  check('a notification goes out on a destination change',
        /set the destination/.test(app));
  check('on someone joining', /joined/.test(app));
  check('and on someone leaving', /left/.test(app));
  check('and when someone goes out of contact', /out of contact/.test(app));

  /* ---------- The look ---------- */
  check('the UI follows the phone\'s light or dark setting',
        /prefers-color-scheme/.test(css));
  check('the people list is a bottom sheet', /#sheet \{/.test(css));
  check('cards are used for the chrome', /\.card \{/.test(css));
  check('markers are drawn as coloured dots', /\.mk \.dot/.test(css));
  check('controls do not select their text on a long press',
        /-webkit-user-select: none/.test(css));

  /* ---------- Manifest and icons ---------- */
  let mf = null;
  try { mf = JSON.parse(read('manifest.webmanifest')); } catch (e) { /* leave null */ }
  check('the manifest is valid JSON', !!mf);
  check('the manifest names the app', mf && mf.short_name === 'Convoy', mf && mf.short_name);
  check('the manifest opens standalone', mf && mf.display === 'standalone', mf && mf.display);
  check('the manifest lists icons', mf && Array.isArray(mf.icons) && mf.icons.length >= 3,
        String(mf && mf.icons && mf.icons.length));
  (mf && mf.icons ? mf.icons : []).forEach((i) => {
    if (i.src === 'icon.svg') return;
    check('the icon ' + i.src + ' exists', exists(i.src));
  });
  check('the page links the manifest', /rel="manifest"\s+href="manifest\.webmanifest"/.test(html));
  check('there is an apple touch icon', /rel="apple-touch-icon"/.test(html));

  /* ---------- The service worker ---------- */
  const shellBlock = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  const shellFiles = (shellBlock.match(/'\.\/([^']+)'/g) || [])
    .map((s) => s.slice(3, -1)).filter((s) => s);
  check('the service worker precaches a shell', shellFiles.length >= 6,
        String(shellFiles.length));
  shellFiles.forEach((f) => {
    check('precached file exists: ' + f, exists(f));
  });
  check('the routing module is precached', shellFiles.indexOf('route.js') >= 0);
  check('the app is precached', shellFiles.indexOf('app.js') >= 0);
  check('the shell version was bumped for this rewrite', /convoy-v11/.test(sw));
  check('tiles are cached for driving through a dead spot', /TILE_CACHE/.test(sw));
} catch (e) { crash(e); }

finish('pwa');
