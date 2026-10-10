# Convoy — live group map + routing

A tiny web app that puts everyone in your group on **one live map**, and plans the
route to where you're all going. Made for road trips, group rides, hikes and
meet-ups: pick a room code, share the link, and every phone that opens it shows up
as a moving pin.

No accounts, no backend to deploy, no build step. Static files plus free map,
geocoding and routing services.

```
convoy/
├── index.html            # the whole UI
├── app.js                # map, live sync, geolocation, demo mode, install flow
├── route.js              # address search, routing, turn-by-turn, voice
├── styles.css            # dark, mobile-first styling
├── sw.js                 # service worker: offline app shell + tile cache
├── manifest.webmanifest  # installable web app
├── icon.svg              # vector app icon
├── icons/                # PNG icons (192, 512, maskable, iOS 180, favicon 32)
├── tests/
│   ├── app-test.js       # live-map tests
│   ├── route-test.js     # routing + navigation tests
│   └── pwa-test.js       # manifest, service worker + install flow
├── LICENSE
└── README.md
```

---

## Try it in 10 seconds (no setup)

Open `index.html` and click **"Preview with 4 demo cars"**. That runs a completely
offline simulation — five cars driving a loop — so you can see the UI without any
server or phone.

Route planning needs a network connection (and, for the live map, HTTPS — see
*Hosting*).

---

## Put it on your phone

Open the site on your phone and add it to your home screen. It then runs full-screen
with no browser chrome, and keeps working when the signal drops.

- **iPhone / iPad** — open it in Safari, tap the **Share** button, then **Add to Home
  Screen**. Safari has no automatic install prompt, so the app shows a one-time hint
  explaining where the button is.
- **Android** — open it in Chrome and tap the app's **Install** button, or use Chrome's
  own *Add to Home screen*.

Once installed it caches the app itself, so it opens instantly and still loads with no
connection at all. It also caches the map tiles you've already looked at (capped at
around 400 — roughly an afternoon of driving) so a dead spot doesn't blank the map.
New tiles, address search and routing still need a connection.

Location access requires a **secure origin** — HTTPS (which GitHub Pages gives you) or
`localhost`. On plain `http://` the browser will refuse to share your position.

The layout is built for one hand: 44px touch targets, no accidental double-tap zoom,
dynamic viewport units so mobile browser bars don't crop the panels, safe-area insets
for notched phones, and a compact layout for landscape when the phone is in a mount.

---

## Features

**Live map**
- Everyone in the room on one map, each as a small **vehicle icon** in their own colour,
  rotated to the direction they're actually heading. The icon follows the travel mode —
  cars for a driving trip, bikes for a cycle, walkers on foot.
- **Names are off by default**, so the map isn't plastered with labels while you're
  driving. Tap a vehicle to find out who it is and how far away they are; turn on the
  **Names** toggle when you want them all shown.
- Breadcrumb trails, distance and bearing from you, speed, and how long since each
  person was last seen.
- Tap a vehicle or a list row to jump to that person. Follow-me and fit-all buttons.
- **Controls sit on the left edge**, within reach in a right-hand-drive car.
- **Tap gestures**: one tap on the map zooms out, a double tap zooms in. While the
  driving controls are hidden, the first tap just brings them back.
- **The map stays aligned with the direction of travel** — heading-up, like a satnav —
  and it holds the last bearing when you stop rather than snapping back to north at
  every red light.
- The basemap **turns dark after sunset and light again after sunrise**, using real sun
  times computed for your position — so it's right whether you're in Sydney in October
  or Melbourne in June. There's a `?theme=dark` / `?theme=light` override for testing.

**Routing & navigation**
- Type a **start** and **destination** address, with type-ahead suggestions. Tap
  **Here** to use your current location as either end.
- Address search is **scoped to the country you're in**. The phone reverse-geocodes your
  position once, then suggestions are limited to that country — so a "Springfield"
  search from India returns Indian places, not Illinois. A toggle in the route sheet
  widens it to the whole world when you're planning a trip abroad.
- Three travel modes: **Car**, **Cycle**, **Walk** — each with its own routing profile,
  so a cycle route genuinely differs from a driving one.
- The route is drawn on the map with A/B pins, plus total distance, travel time and
  an estimated arrival clock.
- A full **turn-by-turn step list** ("Turn left onto MG Road", "At the roundabout,
  take the 2nd exit onto…").
- **Live navigation**: a banner showing the next manoeuvre and the distance to it,
  with **spoken prompts** as you approach (at ~500 m, ~200 m and ~60 m for driving;
  tighter for cycling and walking). Mute any time. While navigating, the rest of the
  chrome gets out of the way so the screen stays readable at a glance.
- **Three candidate routes** are compared and the best one picked — quickest, with a
  preference for shorter, straighter, fewer-turn roads. The summary tells you why.
- Off-route detection, remaining distance / time / progress, and a one-tap
  **Recalculate** that always asks before changing anything.
- **Immersive navigation**: the moment you start navigating, every control gets out of
  the way for a full-screen map showing the cars in your room. **Tap the map** to bring
  the controls back; they fade out again a few seconds later. Prompts that need an
  answer — a re-route offer, a coverage warning — bring the controls back on their own.

**Shared with the room**
- A route belongs to the room: whoever sets it, everyone sees the same start,
  destination, route line and step list. The setter's name is shown, and the shared
  line is drawn dashed in a different colour so it's clear it isn't yours.
- Clearing the route clears it for everyone.

**Offline & remote driving**
- **Save the route**, and turn-by-turn, spoken prompts, remaining distance and the step
  list all keep working with **no signal at all** — the route is stored on the device and
  restored automatically next time you open the app.
- The app watches whether the connection is actually holding up. When it starts to drop,
  you're prompted to save the route while you still can.
- In **Australia** it also checks the ACCC / Department of Infrastructure mobile coverage
  data along your route and warns you before you set off: *"About 24 km of this route has
  no predicted 4G coverage."* There's a **Check coverage** button too.
- **What it deliberately does not do:** pre-download map tiles. OpenStreetMap's Tile
  Usage Policy prohibits "download for offline" buttons and any pre-emptive tile
  fetching, and blocks apps that do it. So the map background is only what you've already
  viewed — it's the *navigation* that's saved. For offline map imagery you need your own
  tile source; see the notes below.

---

## How a route is chosen

For each travel mode Convoy asks OSRM for three candidate routes, then scores them and
picks one, so you don't have to:

1. **Duration is the primary term** — the genuinely quickest road normally wins.
2. **Distance, turn count and straightness are secondary penalties**, in seconds:
   `+0.02 s` per metre, `+12 s` per turn, `+60 s` per unit of winding ("sinuosity" —
   route length divided by straight-line distance).

So a route that is a little slower but noticeably shorter, straighter and with far
fewer turns will be chosen — usually the easier, more economical drive. A route that is
*much* quicker still wins, because duration dominates. The summary tells you what was
picked and why ("3 turns · chose fewest turns of 3 options"), and every weight is
tunable in `CFG.weights`.

**Convoy never changes your route behind your back.** Recalculate works out a new
route, and if it's worth having — or you've drifted off the current one — you get a
prompt: *"A faster route is available — saves 4 min. Switch to it?"* with **Use it**
and **Keep current**. Nothing is swapped until you say so.

> **About traffic.** There is no live traffic feed here. The public routing servers use
> static OpenStreetMap data — road classes, speed limits, turn restrictions — not
> real-time congestion, so Convoy cannot "see" a snarl-up. The prompt is triggered by
> comparing the new route against the one you're on, not by traffic detection. Genuine
> traffic-aware routing needs a provider with a traffic feed (Google, TomTom, HERE, or
> an OSRM built on a traffic-enriched graph) and an API key; the hook is `CFG.routers`
> in `route.js`.

---

## How it works

| Piece | What it does |
|---|---|
| **Leaflet + OpenStreetMap** | Draws the map, pins and route lines. Free, no API key. |
| **MQTT over WebSocket** | Each phone publishes its position — and the route — to one topic per room. That's the whole "live" part. |
| **Browser Geolocation API** | `watchPosition` gives continuous fixes. |
| **Public MQTT brokers** | `broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`, tried in order with automatic failover. |
| **Photon / Nominatim** | Address search. Photon (komoot) first for type-ahead, Nominatim (OpenStreetMap) as fallback. Both free, no key. |
| **FOSSGIS OSRM** | Routing via `routed-car`, `routed-bike` and `routed-foot` — three separate servers, one per travel mode. Free, no key. |
| **SpeechSynthesis API** | Spoken turn prompts. Built into the browser. |
| **Service worker** | Makes the app installable and serves it offline — it caches the app shell, the CDN libraries and the tiles you've already viewed. |

Messages are small JSON blobs published to one topic per room:

```
sarvam-convoy/v1/<room-code>/bus
{ "t":"pos", "id":"c-9f2k...", "name":"Priya", "lat":15.51, "lng":73.81,
  "spd":12.4, "hdg":118, "acc":7, "ts":1760000000000 }

{ "t":"route", "id":"c-9f2k...", "by":"Priya", "mode":"bike",
  "distance":12480, "duration":2400,
  "start":{"lat":..,"lng":..,"label":".."}, "end":{"lat":..,"lng":..,"label":".."},
  "geometry":[[lat,lng],...], "steps":[{"text":"Turn left onto MG Road", ...}] }

{ "t":"route-clear", "id":"c-9f2k..." }
```

Nothing is stored on a server; when the last person leaves, the room is empty.

---

## Using it

1. Open the app. Enter **your name** and a **room code** (e.g. `goa-7f3k9`).
2. Tap **Join room**, and **allow location access** when your browser asks.
3. Tap **Share** to send the invite link to your group.
4. Tap **Route** to plan: pick Car / Cycle / Walk, type where you're going, and press
   **Get route**. Everyone in the room sees it.
5. Press **Start navigation** for live prompts, then **Stop** when you're done.

A person fades to grey after 90 seconds of silence and is removed after 10 minutes.

---

## Hosting it

### GitHub Pages (free, gives you HTTPS)

```bash
git init
git add .
git commit -m "Convoy — live group map"
git branch -M main
git remote add origin https://github.com/<you>/convoy.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.

### Anything else

Any static host works — Netlify, Vercel, Cloudflare Pages, S3, or
`python3 -m http.server` for local testing on `http://localhost` (localhost counts as
a secure origin, so location works).

---

## Important limitations — please read

This is a **working prototype**, and its simplicity comes with real trade-offs:

- **The relay is public.** Anyone who knows (or guesses) your room code can watch the
  map and see the route. Use a long, random code like `goa-7f3k9` rather than `trip`.
- **Traffic is not end-to-end encrypted.** Positions and routes travel in plaintext
  through a third-party broker. Don't use it for anything sensitive, and don't rely
  on it for anyone's safety.
- **The routing and geocoding servers are free community services.** They're
  best-effort, rate-limited, and have no uptime guarantee — if one is down you'll see
  a "could not find a route" message rather than a route. For anything serious, run
  your own OSRM/Nominatim instance or use a paid provider.
- **Routes are a suggestion, not a guarantee.** OSM data and routing profiles can be
  wrong or out of date, especially for footpaths, cycleways and private roads. Follow
  local signs and your own judgement — don't treat spoken prompts as authoritative.
- **No live traffic data.** See the note above: the "faster route" prompt compares
  routes, it does not detect congestion. A jam on your current road won't be seen.
- **The "fuel-efficient" preference is a heuristic.** Fewer turns and less distance do
  generally mean less fuel, but Convoy has no fuel model — it's a weighted score, not a
  consumption estimate.
- **Offline map tiles aren't included, and that's deliberate.** Pre-fetching tiles from
  `tile.openstreetmap.org` is prohibited by the OSM Tile Usage Policy, and apps that do it
  are blocked without notice. What *is* saved is the route itself, which is enough to keep
  navigating without signal. If you want offline map imagery, point the tile layer at a
  source that permits it: your own tile server, a provider plan that allows offline use
  (MapTiler, Stadia, Thunderforest), or Protomaps PMTiles vector tiles.
- **Map rotation needs a third-party plugin.** Leaflet cannot rotate a map on its own,
  so heading-up mode uses `leaflet-rotate`, which patches parts of Leaflet's internals.
  If it fails to load the app carries on unchanged with a north-up map; set
  `CFG.bearing.enabled = false` to turn it off deliberately.
- **The night map is a darkened version of the same tiles, not a purpose-built dark
  basemap.** OSM's standard tiles are the only keyless raster source, so the dark theme
  applies a CSS filter to them — easier on the eyes at night, but not as clean as a real
  dark style. CARTO Dark Matter or Stadia would look better, and both need a free API
  key (CARTO's raster tiles now serve a visible watermark without one). Point
  `CFG.theme.dark.url` at such a source and set `filter: null` to switch over.
- **Coverage warnings are predictions, not measurements.** The Australian data is each
  carrier's own predictive model — outdoor, at ground level, 100 m resolution, refreshed
  quarterly. It doesn't reflect being inside a vehicle or a building, and it isn't a live
  reading of your phone's signal. The signal-drop prompt is the real-world check.
- **The coverage check is set up for Australia only.** Other countries would need a
  comparable service wired into `CFG.offline.coverage`.
- **Address coverage is uneven, and thinnest in India.** The geocoders are
  OpenStreetMap based, so rural Indian addresses, house numbers and newer layouts are
  patchy. Google Maps and MapmyIndia/Mappls have noticeably deeper Indian address data —
  but both need an API key and billing, and a key embedded in a static page is public, so
  either would also need a small proxy to keep it server-side. To swap providers, change
  `CFG.geocoders` in `route.js`.
- **Offline is partial.** The app shell and the tiles you've already viewed are cached;
  new map areas, address search and routing all need a connection. The tile cache is
  deliberately small to stay within OpenStreetMap's tile usage policy — a production app
  should use its own tile provider.
- **Location accuracy depends on the phone.** GPS in a car is good; indoors it can be
  off by tens of metres, which also makes the "next turn" banner jittery.
- **Background tracking is limited.** Phones throttle location updates when the screen
  is off. The app requests a wake lock while it's open, but a fully backgrounded phone
  reports less often.

### If you want to take this further

For anything real, swap the public services for ones you control:

- **Firebase / Supabase** for the live sync — drop-in replacement for the MQTT layer,
  plus real accounts and security rules.
- **Your own MQTT broker** (EMQX, HiveMQ Cloud, Mosquitto) with TLS and per-room
  credentials, and **end-to-end encryption** so the broker can't read positions.
- **Your own OSRM / Valhalla** for routing, or OpenRouteService / GraphHopper for a
  supported API with a key.

The app is structured so this is contained: `connect()` / `send()` in `app.js` for the
transport, and `CFG.geocoders` / `CFG.routers` in `route.js` for the data sources.

---

## Customising

Tunables live in two `CFG` objects:

`app.js` — the live map:

```js
publishMs: 5000,   // how often each phone broadcasts
staleMs: 90000,    // when a peer is greyed out
dropMs: 600000,    // when a peer is removed
maxTrail: 60,      // breadcrumb points per person
brokers: [ ... ],  // add your own broker
theme: {
  auto: true,      // dark after sunset, light after sunrise
  checkMs: 300000, // how often to re-evaluate
  dark: { url: '<tile url>', filter: 'invert(1) hue-rotate(180deg) ...' },
},
tapZoom: { enabled: true, delayMs: 260 },        // single tap out, double tap in
bearing: { enabled: true, minSpeedMps: 0.8, lerp: 0.25 },  // heading-up rotation
```

`route.js` — routing and navigation:

```js
routers: { car: [...], bike: [...], foot: [...] },  // add your own routing server
geocoders: [ ... ],        // add your own geocoder
countryScope: true,        // restrict address search to the detected country
offline: {
  suggestOverM: 150000,    // suggest saving the route on drives longer than this
  pingMs: 45000,           // how often to test whether we still have data
  coverage: {
    enabled: true,
    countries: ['au'],     // the coverage check is wired up for Australia
    service: '<ArcGIS REST coverage service>',
    layerMatch: /Telstra.*4G.*Outdoor/i,
  },
},
offRouteM: 90,             // metres from the line before "off route"
arriveM: 40,               // metres to the destination = arrived
MODES.car.speak: [500, 200, 60],   // announcement thresholds, in metres
```

To use a different map provider, change the `L.tileLayer(...)` URL in `initMap()`.

---

## Troubleshooting

- **"Location permission denied"** — the browser needs HTTPS and explicit permission.
- **Stuck on "Connecting…"** — a firewall, VPN or school/office network is probably
  blocking WebSockets. Try mobile data, or add your own broker.
- **"Could not find a route"** — the public routing server is unreachable, rate-limited,
  or has no route between those points. Try again, or a different travel mode.
- **Address suggestions don't appear** — the geocoders are down or blocked; you can
  still route using **Here** for both ends.
- **No spoken prompts** — check the **Voice** button isn't muted, that the device isn't
  on silent, and that your browser supports speech synthesis.

---

## Testing

Three headless jsdom suites (stubbed Leaflet, MQTT, fetch and speech) cover the real
`app.js` and `route.js` — 209 checks in total:

- `tests/app-test.js` — join → live message → render → leave, demo mode, invite links.
- `tests/route-test.js` — vehicle markers and the names toggle, geocoding,
  country-scoped address search, routing, choosing between alternatives, the re-route
  consent prompt, step wording, shared routes, live navigation, mute, off-route
  detection, saving/restoring the route for offline use, the signal-drop prompt, the
  coverage warning and its country gating, immersive navigation, the day/night map, the
  tap zoom gestures and the heading-up bearing.
- `tests/pwa-test.js` — manifest and icon consistency (every declared icon is a real PNG
  of the size it claims), that every file the service worker precaches actually exists,
  and the iOS and Android install flows.

```bash
npm install
npm test
```

---

## License

MIT — see [LICENSE](LICENSE). Map data © OpenStreetMap contributors. Routing by
FOSSGIS OSRM. Geocoding by Photon (komoot) and Nominatim.
