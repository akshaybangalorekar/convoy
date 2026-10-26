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
  check('the invite is just the link, because there is no code to send',
        /Open Convoy and you are on the map with me/.test(app) &&
        !/state\.room/.test(app.slice(app.indexOf('async function share()'),
                                      app.indexOf('async function share()') + 700)));
  check('the shared link is the app address, with nothing appended',
        /const inviteLink = \(\) => location\.origin \+ location\.pathname;/.test(app));
  check('the screen is kept awake while the app is in front',
        /navigator\.wakeLock\.request\('screen'\)/.test(app));
  check('and the lock is taken again on coming back, since the browser drops it',
        /askWakeLock\(\);/.test(app) && /addEventListener\('release'/.test(app));
  check('codes are folded down, so capitals and spaces do not matter',
        /function normRoom/.test(app) && /toLowerCase\(\)/.test(app));
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
  check('the sheet has one switch, and it takes you off the map',
        /id="btnPause"/.test(html) && /Hide my location/.test(app) &&
        !/id="btnSaver"/.test(html) && !/id="btnSound"/.test(html) &&
        !/id="btnHere"/.test(html));
  check('and four equal buttons, each an icon over one short word',
        /class="tb"/.test(html) &&
        ['btnInvite', 'btnPause', 'btnEditName', 'btnSettings']
          .every((id) => new RegExp('id="' + id + '" class="tb"').test(html)));
  check('the eye closes when you are hidden',
        /class="ic-off"/.test(html) && /\.tb\.on \.ic-off \{ display: block/.test(css));
  check('sharing is set for battery life, with no switch for it',
        /publishMs: 30000/.test(app) && !/saverPublishMs/.test(app));
  check('the master pin is not written in the source as digits',
        !/1981/.test(app) && /masterHash: 0x[0-9a-f]+/.test(app));
  check('and it is compared as a hash, not as text',
        /function pinHash/.test(app) && /pinHash\(pin\) !== CFG\.masterHash/.test(app));
  check('the settings field is unlabelled, so it does not advertise itself',
        /id="inPin"/.test(html) && !/placeholder[^>]*pin/i.test(html));
  check('the attribution sits along the bottom edge, not floating over the map',
        /\.leaflet-bottom\.leaflet-right \{\s*bottom: calc\(1px/.test(css));
  check('and the sheet clears it', /bottom: calc\(20px \+ var\(--safe-bottom\)\)/.test(css));
  check('there is no room code and no bar at the top',
        !/roomChip/.test(html) && !/class="bar"/.test(html));
  check('and there is no room-name field at all, since a name only caused confusion',
        !/inRoomName/.test(html) && !/roomName/.test(app));
  check('there is no code field at all', !/id="inRoom"/.test(html));
  check('your name is edited in the list, on your own row only',
        /class="myname"/.test(app) && /function setName/.test(app) &&
        !/inMyName/.test(html));
  check('and the controls sit in one row at the foot of the sheet',
        /class="sheet-controls"/.test(html) &&
        /id="btnInvite"/.test(html) && /id="btnPause"/.test(html) &&
        /id="btnSettings"/.test(html));
  check('the clear button lives on the destination row, not in the search sheet',
        /id="btnClearDest"/.test(html) &&
        html.indexOf('id="btnClearDest"') < html.indexOf('id="search"'));
  check('there is no join form at all, and no Leave button',
        !/id="join"/.test(html) && !/btnLeave/.test(html) && !/id="btnGo"/.test(html));
  check('a long press on the map sets the destination',
        /on\('contextmenu'/.test(app) && /function onMapLongPress/.test(app));
  check('and looks up what is there', /function reverse/.test(read('route.js')) &&
        /nominatimReverse/.test(read('route.js')));
  check('arrivals are announced', /has arrived/.test(app) && /function checkArrivals/.test(app));
  check('and are automatic within fifty metres', /arrivedM: 50/.test(app));
  check('there is no button to press to arrive', !/btnHere/.test(app) &&
        /function checkArrivals/.test(app));
  check('and the row is marked arrived once they are there, once, not twice',
        /tag = 'arrived'/.test(app) && !/peta arrived/.test(app));
  check('someone who goes quiet is marked lost, with how long ago',
        /Lost network · ' \+ fmtAgo/.test(app) && /function lastSeenOf/.test(app));
  check('and someone who put the app away is marked as shut down',
        /Shut down app/.test(app));
  check('their circle goes grey rather than the whole row fading',
        /li\.away \.pdot, #people li\.lost \.pdot \{ filter: grayscale\(1\)/.test(css));
  check('and who is behind or ahead of you', /behind you/.test(app) && /ahead of you/.test(app));
  check('pausing is announced rather than looking like silence',
        /state\.paused \? 'paused' : 'sharing'/.test(app));
  check('a notification makes a sound', /function ping/.test(app) && /AudioContext/.test(app));
  check('and nothing is played before the page is touched', /once: true, passive: true/.test(app));
  check('pasting the invite link into the code box works', /function extractRoomCode/.test(app));
  check('tapping a person brings the map to them', /function focusPeer/.test(app));
  check('a relay on 443 is offered, since mobile networks block the usual ports',
        /mqtt\.eclipseprojects\.io:443/.test(app));
  check('the relay library has a second source, since a CDN can fail on a phone',
        /cdn\.jsdelivr\.net\/npm\/mqtt/.test(html));
  check('a missing relay library is named instead of looking like a blocked network',
        /no library/.test(app));
  check('the shell fetch bypasses the HTTP cache, or updates never land',
        /fetch\(req, \{ cache: 'no-store' \}\)/.test(sw));
  check('the app asks for a new service worker on open and on return',
        /function checkForUpdate/.test(app) && /checkForUpdate\(\);/.test(app));
  check('and the build it is running is shown, so a stale copy is visible',
        /id="connBuild"/.test(html) && /build: 'v/.test(app));
  check('the build number in the app matches the shell version', (() => {
    const a = /build: '(v\d+)'/.exec(app);
    const b = /convoy-(v\d+)'/.exec(sw);
    return !!a && !!b && a[1] === b[1];
  })(), 'app ' + (/build: '(v\d+)'/.exec(app) || [])[1] + ' / sw ' + (/convoy-(v\d+)'/.exec(sw) || [])[1]);
  check('and the connection state can be tapped to check the relays',
        /id="connCard"/.test(html) && /function probeRelay/.test(app));
  check('and a relay that cannot be reached says so instead of pretending',
        /no relay/.test(app));
  check('with no banner anywhere except the join request',
        (app.match(/banner\(/g) || []).length === 2,        // the definition, plus one call
        String((app.match(/banner\(/g) || []).length));
  check('the location watch is armed again on coming back',
        /startWatching\(\);/.test(app) && /geoWatch = navigator\.geolocation\.watchPosition/.test(app));
  check('and a touch retries while we have no position', /haveMyPosition/.test(app));
  check('our own row says when we are waiting for a location',
        /waiting for your location/.test(app));
  check('a phone with no position is kept away from the map',
        /function allPeople/.test(app) && /p\.lat != null && p\.lng != null/.test(app));
  check('and the dimmed area closes the search sheet', /e\.target === \$\('search'\)/.test(read('route.js')));
  check('the new messages are all handled',
        /case 'paused'/.test(app) && /case 'sharing'/.test(app) &&
        /case 'arrived'/.test(app) && /case 'paused'/.test(app));
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
  // The scope and id are what let Android hand a link to the installed app instead of a
  // tab. They match the address the app is served from, so nothing is orphaned.
  check('the manifest claims its own address, which is what lets Android hand links to the installed app',
        mf && mf.scope === '.' && mf.start_url === '.' && mf.id === '.',
        JSON.stringify(mf && { id: mf.id, scope: mf.scope, start_url: mf.start_url }));
  check('and an iPhone is told a link opens in Safari rather than the installed app',
        /id="iosNote"/.test(html) && /iosNote/.test(install) && /#iosNote\.hidden/.test(css));

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
  check('the shell version was bumped for this rewrite', /convoy-v32/.test(sw));
  check('tiles are cached for driving through a dead spot', /TILE_CACHE/.test(sw));
} catch (e) { crash(e); }

finish('pwa');
