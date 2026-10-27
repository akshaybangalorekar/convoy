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
  check('the map rotation plugin is loaded, pinned and hash-checked',
        /leaflet-rotate@0\.2\.8/.test(html) &&
        /integrity="sha384-[A-Za-z0-9+/=]+"/.test(html.split('leaflet-rotate')[0].split('<script').pop() +
                                                 html.slice(html.indexOf('leaflet-rotate')).slice(0, 400)));
  check('and it is precached with the rest of the shell',
        sw.indexOf('leaflet-rotate') >= 0);
  check('everything that uses it is guarded, so a missing plugin is a north-up map',
        /const canRotate = /.test(app) && /typeof map\.setBearing === 'function'/.test(app));
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
  check('the roster and the destination are remembered in one record on the phone',
        /convoy\.record/.test(app) && !/convoy\.room/.test(app));
  check('install.js is precached and loaded',
        /install\.js/.test(sw) && /install\.js/.test(html));
  check('the app offers to go on the home screen', /function maybeOffer/.test(install));
  check('using the browser\'s own prompt where it is allowed',
        /beforeinstallprompt/.test(install));
  check('and instructions for iOS, where it is not',
        /Add to Home Screen/.test(install));
  check('the offer is remembered once dismissed', /install\.dismissed/.test(install));
  check('there is no room to remember, and no invite code to keep',
        !/convoy\.invite/.test(app) && !/convoy\.room/.test(app));

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
  check('there are no room codes left anywhere in the app',
        !/normRoom|roomFromUrl|extractRoomCode|state\.room\b/.test(app));
  check('the old copy method is kept for browsers that block the clipboard',
        /execCommand/.test(app));
  check('the link is shown to copy by hand when nothing else works',
        /id="shareUrl"/.test(html) && /function showLink/.test(app));
  check('and a link with an old code in it is simply ignored',
        !/location\.hash/.test(app) && !/history\.replaceState\(null, '', location\.pathname/.test(app));
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
        ['btnInvite', 'btnPause', 'btnCentre', 'btnSettings']
          .every((id) => new RegExp('id="' + id + '" class="tb"').test(html)));
  check('the eye closes when you are hidden, and the button inverts',
        /class="ic-off"/.test(html) && /\.tb\.hiding \.ic-off \{ display: block/.test(css) &&
        /\.tb\.hiding \{ background: var\(--orange\); color: var\(--btn-bg\)/.test(css));
  check('there is one real .hidden rule, and it wins',
        /\.hidden \{ display: none !important; \}/.test(css));
  check('the buttons are dark with a bright orange symbol',
        /--orange: #ff9f0a/.test(css) && /--btn-bg: #23232a/.test(css) &&
        /\.tb \{[^}]*background: var\(--btn-bg\); color: var\(--orange\)/.test(css));
  check('sharing is set for battery life, with no switch for it',
        /publishMs: 30000/.test(app) && !/saverPublishMs/.test(app));
  check('the master pin is not written in the source as digits',
        !/1981/.test(app) && /masterHash: 0x[0-9a-f]+/.test(app));
  check('and it is compared as a hash, not as text',
        /function pinHash/.test(app) && /pinHash\(pin\) !== CFG\.masterHash/.test(app));
  check('the help card is five short lines, then the version, then a quiet field',
        /class="help-list"/.test(html) &&
        (html.match(/<li>Tap |<li><b>Invite<\/b>/g) || []).length === 5,
        String((html.match(/<li>Tap |<li><b>Invite<\/b>/g) || []).length));
  check('and the button says Help, not Settings',
        /<span>Help<\/span>/.test(html) && !/<span>Settings<\/span>/.test(html));
  check('the settings field is unlabelled, so it does not advertise itself',
        /id="inPin"/.test(html) && !/placeholder[^>]*pin/i.test(html));
  check('there are no + and - buttons on the map — tapping zooms',
        !/control\.zoom/.test(app) && !/leaflet-control-zoom/.test(html));
  check('the map draws no credit line over itself',
        /attributionControl: false/.test(app) && !/\.leaflet-control-attribution/.test(css));
  check('the credit is in Help instead, with a link to OpenStreetMap',
        /Map data &copy;/.test(html) && /openstreetmap\.org\/copyright/.test(html));
  check('and the sheet is the bottom-most thing, flush to the edge',
        /bottom: 0;/.test(css) && /border-radius: 16px 16px 0 0/.test(css));
  check('there is no floating recenter button, since Location does that job',
        !/id="btnRecenter"/.test(html) && !/\.recenter/.test(css));
  check('removing someone is one action, with no add-back control',
        !/data-add/.test(app) && !/function addPerson/.test(app) &&
        /data-remove/.test(app));
  check('and nobody keeps a row for someone who has been removed',
        /\.filter\(\(p\) => !state\.removed\.has\(p\.id\)\)/.test(app));
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
  check('the map needs no API key, and nothing in it asks for one',
        !/cartocdn|apikey|api_key|access_token/i.test(app + html + css));
  check('the night map is darkened only at night, never by the phone\'s dark mode',
        /#map\.night-tiles \.leaflet-tile-pane/.test(css) &&
        !/\.leaflet-tile \{\s*filter/.test(css));
  check('their circle goes grey rather than the whole row fading',
        /li\.away \.pdot, #people li\.lost \.pdot \{ filter: grayscale\(1\)/.test(css));
  check('and who is behind or ahead of you', /behind you/.test(app) && /ahead of you/.test(app));
  check('pausing is announced rather than looking like silence',
        /state\.paused \? 'paused' : 'sharing'/.test(app));
  check('a notification makes a sound', /function ping/.test(app) && /AudioContext/.test(app));
  check('and nothing is played before the page is touched', /once: true, passive: true/.test(app));
  check('there is no code box to paste into', !/inRoom/.test(html) && !/extractRoomCode/.test(app));
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
        /function allPeople/.test(app) && /hasFix\(p\)/.test(app) &&
        /typeof o\.lat === 'number'/.test(app));
  check('and the dimmed area closes the search sheet', /e\.target === \$\('search'\)/.test(read('route.js')));
  check('the new messages are all handled',
        /case 'paused'/.test(app) && /case 'sharing'/.test(app) &&
        /case 'arrived'/.test(app) && /case 'paused'/.test(app));
  check('one blanket rule: a week after their last sign of life',
        /keepDays: 7/.test(app) && /const keepMs = /.test(app));
  check('applied to the roster as well as the list, so a reload cannot bring them back',
        /function pruneRoster/.test(app) && /forgetMember\(id\)/.test(app));
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
  check('markers are cars in the person\'s own colour', /\.mk \.car/.test(css));
  check('and nothing on the map is ever greyed or faded out',
        !/\.mk\.stale/.test(css) && !/\.mk[^}]*grayscale/.test(css));
  check('the group zooms in when the cars are close and out when they are spread',
        /maxZoom: 18/.test(app) && /fitBounds/.test(app));
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
  check('the shell version was bumped for this rewrite', /convoy-v66/.test(sw));
  check('tiles are cached for driving through a dead spot', /TILE_CACHE/.test(sw));
} catch (e) { crash(e); }

finish('pwa');
