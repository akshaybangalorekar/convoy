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
  check('anyone can set the destination', /function setDest/.test(app) &&
        /t: 'dest'/.test(app));
  check('the destination travels to the room', /'dest-clear'/.test(app));
  check('arrival times are published', /t: 'eta'/.test(app));
  check('and shown for each person', /function etaCell/.test(app));
  check('a notification goes out on a destination change',
        /set the destination/.test(app));
  check('on someone joining', /joined/.test(app));
  check('and on someone leaving', /left/.test(app));

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
  check('the shell version was bumped for this rewrite', /convoy-v2/.test(sw));
  check('tiles are cached for driving through a dead spot', /TILE_CACHE/.test(sw));
} catch (e) { crash(e); }

finish('pwa');
