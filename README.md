# Convoy — live group map

A tiny web app that puts everyone in your group on **one live map**. Made for road
trips, group rides, hikes and meet-ups: pick a room code, share the link, and every
phone that opens it shows up as a moving pin.

No accounts, no backend to deploy, no build step. It's three static files plus a
free map and a free real-time relay.

```
convoy/
├── index.html            # the whole UI
├── app.js                # map, live sync, geolocation, demo mode
├── styles.css            # dark, mobile-first styling
├── manifest.webmanifest  # "Add to Home Screen"
├── icon.svg              # app icon
├── LICENSE
└── README.md
```

---

## Try it in 10 seconds (no setup)

Open `index.html` in a browser and click **"Preview with 4 demo cars"**. That runs a
completely offline simulation — five cars driving a loop — so you can see the UI
without any server or phone.

To try it for real you need it served over **HTTPS** (browsers only allow location
access on secure origins). See *Hosting* below.

---

## How it works

| Piece | What it does |
|---|---|
| **Leaflet + OpenStreetMap** | Draws the map and the pins. Free, no API key. |
| **MQTT over WebSocket** | Each phone publishes its position to a topic and subscribes to the same one. That's the whole "live" part. |
| **Browser Geolocation API** | `watchPosition` gives continuous fixes. |
| **Public MQTT brokers** | `broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`. Tried in order; if one is down it fails over to the next. |

Every message is a small JSON blob published to one topic per room:

```
sarvam-convoy/v1/<room-code>/bus
{ "t":"pos", "id":"c-9f2k...", "name":"Priya", "lat":15.51, "lng":73.81,
  "spd":12.4, "hdg":118, "acc":7, "ts":1760000000000 }
```

Each client also sends a `hello` on join and a `bye` on leave. Nothing is stored on a
server; when the last person leaves, the room is empty.

---

## Using it

1. Open the app. Enter **your name** and a **room code** (e.g. `goa-7f3k9`).
2. Tap **Join room**, and **allow location access** when your browser asks.
3. Tap **Share** to send the invite link to your group. Anyone who opens it lands in
   the same room.
4. Everyone appears on the map with their own colour, a breadcrumb trail, and their
   distance/bearing from you, speed, and how long ago they were last seen.

**Buttons**

- **Follow me** — keeps the map centred on you. Turns off automatically if you pan away.
- **Fit all** — zoom out to fit the whole group.
- **Leave** — stops sharing and clears the map.
- Tap any pin or list row to jump to that person.

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
Your app is live at `https://<you>.github.io/convoy/` within a minute or two. Share
that link (with a room code appended like `#r=goa-7f3k9`).

### Anything else

Any static host works — Netlify, Vercel, Cloudflare Pages, S3, or even
`python3 -m http.server` for local testing on `http://localhost` (localhost counts as
a secure origin, so location works).

---

## Important limitations — please read

This is a **working prototype**, and its simplicity comes with real trade-offs:

- **The relay is public.** Anyone who knows (or guesses) your room code can subscribe
  and watch the map. Use a long, random code like `goa-7f3k9` rather than `trip`.
- **Traffic is not end-to-end encrypted.** Positions travel in plaintext through a
  third-party broker. Don't use it for anything sensitive, and don't rely on it for
  anyone's safety.
- **Location accuracy depends on the phone** — GPS in a car is good, indoors it can be
  off by tens of metres. The app shows an accuracy value per fix internally.
- **Background tracking is limited.** Phones throttle location updates when the screen
  is off. The app requests a wake lock to keep the screen on while it's open, but a
  fully backgrounded phone will report less often.
- **Public brokers are best-effort.** They occasionally go down or rate-limit. The app
  fails over between three of them, but there's no uptime guarantee.

### If you want to take this further

For anything real (a product, a company trip, anything private), swap the public broker
for a backend you control and add auth:

- **Firebase Realtime Database / Firestore** or **Supabase Realtime** — drop-in
  replacement for the MQTT layer, plus real accounts and security rules.
- **Your own MQTT broker** (EMQX, HiveMQ Cloud, Mosquitto) with TLS and per-room
  credentials.
- **End-to-end encryption** — encrypt the payload with a key derived from the room
  code, so even the broker can't read positions.

The app is structured so that only two functions need to change: `connect()` and
`send()` in `app.js`.

---

## Customising

Everything tunable is in the `CFG` object at the top of `app.js`:

```js
publishMs: 5000,   // how often each phone broadcasts (lower = smoother, more data)
staleMs: 90000,    // when a peer is greyed out
dropMs: 600000,    // when a peer is removed
maxTrail: 60,      // breadcrumb points kept per person
brokers: [ ... ],  // add your own broker here
```

To use a different map provider, change the `L.tileLayer(...)` URL in `initMap()`.

---

## Troubleshooting

- **"Location permission denied"** — the browser needs HTTPS and explicit permission.
  Check the site settings / the padlock icon.
- **Stuck on "Connecting…"** — a firewall, VPN, or school/office network is probably
  blocking WebSockets. Try mobile data, or add your own broker to `CFG.brokers`.
- **Pins are stale** — the other person's phone is asleep or has lost signal.
- **Nothing loads at all** — Leaflet and the MQTT client are pulled from a CDN
  (unpkg); you need internet on first load.

---

## Testing

The logic is covered by a headless jsdom harness (stubbed Leaflet + MQTT) that
exercises the join → live-message → render → leave path, the demo animation, and
invite-link auto-join. See `tests/app-test.js`.

```bash
npm install jsdom
node tests/app-test.js
```

---

## License

MIT — see [LICENSE](LICENSE). Map data © OpenStreetMap contributors.
