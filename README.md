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
├── app.js                # map, live sync, geolocation, demo mode
├── route.js              # address search, routing, turn-by-turn, voice
├── styles.css            # dark, mobile-first styling
├── manifest.webmanifest  # "Add to Home Screen"
├── icon.svg              # app icon
├── tests/
│   ├── app-test.js       # live-map tests
│   └── route-test.js     # routing + navigation tests
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

## Features

**Live map**
- Everyone in the room on one map, each with their own colour and breadcrumb trail.
- Distance and bearing from you, speed, and how long since each person was last seen.
- Tap a pin or a list row to jump to that person. Follow-me and fit-all buttons.

**Routing & navigation**
- Type a **start** and **destination** address, with type-ahead suggestions. Tap
  **Here** to use your current location as either end.
- Three travel modes: **Car**, **Cycle**, **Walk** — each with its own routing profile,
  so a cycle route genuinely differs from a driving one.
- The route is drawn on the map with A/B pins, plus total distance, travel time and
  an estimated arrival clock.
- A full **turn-by-turn step list** ("Turn left onto MG Road", "At the roundabout,
  take the 2nd exit onto…").
- **Live navigation**: a banner showing the next manoeuvre and the distance to it,
  with **spoken prompts** as you approach (at ~500 m, ~200 m and ~60 m for driving;
  tighter for cycling and walking). Mute any time.
- Off-route detection, remaining distance / time / progress, and a one-tap
  **Recalculate**.

**Shared with the room**
- A route belongs to the room: whoever sets it, everyone sees the same start,
  destination, route line and step list. The setter's name is shown, and the shared
  line is drawn dashed in a different colour so it's clear it isn't yours.
- Clearing the route clears it for everyone.

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
```

`route.js` — routing and navigation:

```js
routers: { car: [...], bike: [...], foot: [...] },  // add your own routing server
geocoders: [ ... ],        // add your own geocoder
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

Two headless jsdom suites (stubbed Leaflet, MQTT, fetch and speech) cover the real
`app.js` and `route.js`:

- `tests/app-test.js` — join → live message → render → leave, demo mode, invite links.
- `tests/route-test.js` — geocoding, routing, step text, shared routes, live
  navigation, mute, off-route detection and failure handling.

```bash
npm install
npm test
```

---

## License

MIT — see [LICENSE](LICENSE). Map data © OpenStreetMap contributors. Routing by
FOSSGIS OSRM. Geocoding by Photon (komoot) and Nominatim.
