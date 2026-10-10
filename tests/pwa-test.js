/* Headless tests for Convoy's phone/PWA layer:
 * manifest + icons + service worker consistency, and the install flow.
 * Mixes static file checks with jsdom behaviour tests. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra = '') =>
  results.push({ name, ok: !!cond, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(DIR, p));

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
               '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

/* ---------- Test 1: static files line up ---------- */
function testStaticFiles() {
  const html = read('index.html');

  check('index.html links the manifest', /rel="manifest"\s+href="manifest\.webmanifest"/.test(html));
  check('index.html has a PNG favicon', /rel="icon"[^>]*favicon-32\.png/.test(html));
  check('index.html has an apple-touch-icon', /rel="apple-touch-icon"[^>]*apple-touch-icon\.png/.test(html));
  check('apple-touch-icon is not an SVG (iOS ignores SVG there)',
        !/rel="apple-touch-icon"[^>]*\.svg/.test(html));
  check('viewport uses viewport-fit=cover', /viewport-fit=cover/.test(html));
  check('has mobile-web-app-capable', /mobile-web-app-capable/.test(html));
  check('has apple-mobile-web-app-title', /apple-mobile-web-app-title/.test(html));
  check('declares a dark color-scheme', /name="color-scheme"[^>]*dark/.test(html));
  check('has the install bar markup', /id="a2hs"/.test(html) && /id="a2hsGo"/.test(html));
  check('controls live in the left-hand rail, Route nearest the thumb',
        /class="rail"[\s\S]*?id="btnLeave"[\s\S]*?id="btnShare"[\s\S]*?id="btnRoute"/.test(html));
  check('the rail is outside the top bar',
        html.indexOf('class="rail"') > html.indexOf('</header>'));

  const css = read('styles.css');
  const railRules = css.match(/\.rail \{[\s\S]*?\}/g) || [];
  const railAll = railRules.join('\n');
  check('the rail is anchored to the bottom', /bottom:\s*calc\(/.test(railAll), railAll.slice(0, 140));
  check('the rail no longer sits at the top', /top:\s*auto/.test(railAll), railAll.slice(0, 140));
  check('the bottom panels start clear of the rail',
        /#panel, \.navstatus, \.a2hs \{ left: var\(--rail-off\)/.test(css));

  // --- manifest
  let mf = null;
  try { mf = JSON.parse(read('manifest.webmanifest')); } catch (e) { /* leave null */ }
  check('manifest is valid JSON', !!mf);
  if (mf) {
    check('manifest names the app', mf.name && mf.short_name === 'Convoy', mf.short_name);
    check('manifest is standalone', mf.display === 'standalone', mf.display);
    check('manifest allows any orientation (car mounts)', mf.orientation === 'any', mf.orientation);
    check('manifest has theme + background colours',
          !!mf.theme_color && !!mf.background_color);
    check('manifest declares at least 192 and 512 icons',
          (mf.icons || []).some((i) => i.sizes === '192x192') &&
          (mf.icons || []).some((i) => i.sizes === '512x512'));
    check('manifest declares a maskable icon',
          (mf.icons || []).some((i) => (i.purpose || '').includes('maskable')));

    // every declared icon must exist, be a real PNG, and match its stated size
    let iconsOk = true, notes = [];
    (mf.icons || []).forEach((i) => {
      if (i.type === 'image/svg+xml') {
        if (!exists(i.src)) { iconsOk = false; notes.push('missing ' + i.src); }
        return;
      }
      if (!exists(i.src)) { iconsOk = false; notes.push('missing ' + i.src); return; }
      const buf = fs.readFileSync(path.join(DIR, i.src));
      const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
      const w = isPng ? buf.readUInt32BE(16) : 0;
      const h = isPng ? buf.readUInt32BE(20) : 0;
      const want = parseInt(String(i.sizes).split('x')[0], 10);
      if (!isPng || w !== want || h !== want) {
        iconsOk = false;
        notes.push(`${i.src} is ${w}x${h}, declared ${i.sizes}`);
      }
    });
    check('every declared icon exists and matches its size', iconsOk, notes.join('; '));
  }

  check('apple-touch-icon file exists', exists('icons/apple-touch-icon.png'));
  check('favicon file exists', exists('icons/favicon-32.png'));

  // --- service worker
  const sw = read('sw.js');
  check('sw.js registers install/activate/fetch listeners',
        /addEventListener\('install'/.test(sw) &&
        /addEventListener\('activate'/.test(sw) &&
        /addEventListener\('fetch'/.test(sw));
  check('sw.js ignores non-GET requests', /req\.method !== 'GET'/.test(sw));
  check('sw.js versions its cache', /const VERSION = 'convoy-v1'/.test(sw));
  check('sw.js deletes old caches on activate', /caches\.delete/.test(sw));
  check('sw.js bounds the tile cache', /MAX_TILES/.test(sw));

  const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  check('sw.js declares a SHELL list', !!shellBlock);
  if (shellBlock) {
    const paths = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const missing = paths.filter((p) => {
      const rel = p === './' ? 'index.html' : p.replace(/^\.\//, '');
      return !exists(rel);
    });
    check(`all ${paths.length} precached files exist on disk`, missing.length === 0,
          'missing: ' + missing.join(', '));
    check('sw.js precaches the app scripts',
          paths.includes('./app.js') && paths.includes('./route.js') && paths.includes('./styles.css'));
  }

  // --- every local asset the page references should be present
  const localRefs = [...html.matchAll(/(?:src|href)="((?!https?:|#|data:)[^"]+)"/g)]
    .map((m) => m[1]);
  const badRefs = localRefs.filter((r) => !exists(r.replace(/^\.\//, '')));
  check('every local asset referenced by index.html exists', badRefs.length === 0,
        'missing: ' + badRefs.join(', '));
}

/* ---------- jsdom harness ---------- */
function makeStubs(window) {
  const layer = () => {
    const o = {};
    ['addTo', 'setLatLng', 'setLatLngs', 'setView', 'panTo', 'fitBounds', 'getBounds',
     'removeLayer', 'on', 'off', 'getZoom', 'setStyle', 'bindPopup', 'setZIndex']
      .forEach((m) => { o[m] = () => o; });
    o.getZoom = () => 13;
    o.getPane = () => ({ style: {} });
    o.getContainer = () => ({ addEventListener: () => {} });
    o.getElement = () => ({ classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => null });
    return o;
  };
  window.L = {
    map: layer, tileLayer: layer, marker: layer, polyline: layer, latLngBounds: layer,
    control: { zoom: () => ({ addTo: () => {} }) }, divIcon: (o) => o,
  };
  window.mqtt = { connect: () => ({ on: () => {}, subscribe() {}, publish() {}, end() {} }) };
  window.crypto = window.crypto || {};
  if (!window.crypto.getRandomValues) window.crypto.getRandomValues = (a) => a;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {} };
}

function boot(opts = {}) {
  const html = read('index.html');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://convoy.test/',
  });
  const { window } = dom;
  makeStubs(window);

  // jsdom 29 ignores its own `userAgent` option, so set it ourselves.
  if (opts.ua) {
    try {
      Object.defineProperty(window.navigator, 'userAgent', { value: opts.ua, configurable: true });
    } catch (e) { /* ignore */ }
  }

  const registered = [];
  if (opts.serviceWorker !== false) {
    Object.defineProperty(window.navigator, 'serviceWorker', {
      value: { register: (u) => { registered.push(u); return Promise.resolve({ scope: '/' }); } },
      configurable: true,
    });
  }
  window.eval(read('app.js'));
  return { window, registered };
}

function join(window) {
  const d = window.document;
  d.getElementById('inName').value = 'Akshay';
  d.getElementById('inRoom').value = 'phone-test';
  d.getElementById('btnJoin').click();
}

/* ---------- Test 2: service worker registration ---------- */
function testServiceWorkerRegistration() {
  const a = boot();
  check('registers sw.js on a secure origin',
        a.registered.length === 1 && a.registered[0] === 'sw.js', a.registered.join(','));

  const b = boot({ serviceWorker: false });
  check('does not explode when service workers are unavailable', !!b.window.document.getElementById('btnJoin'));
}

/* ---------- Test 3: iOS install hint ---------- */
async function testIosInstallHint() {
  const { window } = boot({ ua: IOS_UA });
  const d = window.document;

  check('iOS hint names the Share menu', /Add to Home Screen/.test(d.getElementById('a2hsTxt').textContent),
        d.getElementById('a2hsTxt').textContent);
  check('install bar hidden before joining', !d.getElementById('a2hs').classList.contains('show'));

  join(window);
  await sleep(20);
  check('install bar shown after joining', d.getElementById('a2hs').classList.contains('show'));
  check('body marked so the panel lifts', d.body.classList.contains('a2hs-on'));

  d.getElementById('a2hsClose').click();
  check('dismiss hides the bar', !d.getElementById('a2hs').classList.contains('show'));
  check('dismiss clears the body flag', !d.body.classList.contains('a2hs-on'));
  check('dismiss is remembered', window.localStorage.getItem('convoy.a2hs') === 'done',
        window.localStorage.getItem('convoy.a2hs'));

  d.getElementById('a2hsClose').click();
  check('dismissing twice is harmless', !d.getElementById('a2hs').classList.contains('show'));
}

/* ---------- Test 4: Android install prompt ---------- */
async function testAndroidInstallPrompt() {
  const { window } = boot({ ua: ANDROID_UA });
  const d = window.document;

  check('no bar before the browser offers one', !d.getElementById('a2hs').classList.contains('show'));

  let prompted = false;
  const ev = new window.Event('beforeinstallprompt');
  ev.prompt = () => { prompted = true; };
  ev.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(ev);
  await sleep(20);

  check('Android copy used once the prompt is available',
        /Install Convoy/.test(d.getElementById('a2hsTxt').textContent),
        d.getElementById('a2hsTxt').textContent);

  join(window);
  await sleep(20);
  check('install bar shown for Android too', d.getElementById('a2hs').classList.contains('show'));

  d.getElementById('a2hsGo').click();
  await sleep(20);
  check('tapping Install triggers the browser prompt', prompted);
  check('bar closes after installing', !d.getElementById('a2hs').classList.contains('show'));
}

/* ---------- Run ---------- */
(async () => {
  try {
    testStaticFiles();
    testServiceWorkerRegistration();
    await testIosInstallHint();
    await testAndroidInstallPrompt();
  } catch (e) {
    results.push({ name: 'suite crashed: ' + e.message, ok: false,
                   extra: e.stack ? String(e.stack).split('\n')[1] : '' });
  }
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <-- ' + r.extra}`));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
