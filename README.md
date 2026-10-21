# Convoy

Everyone in your group on one map, with the time each person will reach the destination.

Three things, and nothing else:

1. **Invite by link.** Anyone in the group can start one and share the link. Whoever opens it
   is on the map.
2. **Anyone can set the destination.** Everyone sees every car, and each person's arrival time
   at that destination — worked out on that person's own phone, so it is accurate for them.
3. **Notifications.** A ping when the destination changes, and when someone joins or leaves.

No sign-up, no account, no backend. Positions and destinations travel as small messages over
a public relay.

Live at **https://akshaybangalorekar.github.io/convoy/**

---

## Try it

Open the link, type your name, and press **Start a new group**. You get a code and a map.

To bring someone in, tap **Invite** and send them the link. They type their name and they are
on your map.

To see it work on one phone, tap **Just looking? Preview with demo cars** on the join screen.

## Put it on your phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app / Add to Home screen.

It then opens full-screen like any other app.

## The one thing to know about notifications

The ping appears as a banner on screen and a vibration **whenever the app is open**, and as a
system notification too if you allow it.

**It cannot arrive when the app is fully closed.** Waking a closed app needs a push service
and a server to send through, and this app deliberately has neither. So: leave Convoy open
(or in the background) on the drive and the pings land; force-quit it and they will not.
That is a real limitation, not a setting.

---

## How it works

| Piece | What it does |
|---|---|
| **Leaflet + OpenStreetMap** | Draws the map and the cars. Free, no API key. |
| **MQTT over WebSocket** | One topic per room carries positions, the destination and arrival times. |
| **Photon / Nominatim** | Place search. Photon first, OpenStreetMap's Nominatim as the fallback. Both free, no key. |
| **FOSSGIS OSRM** | The car route from you to the destination, which gives your arrival time. Free, no key. |
| **Notifications API** | The system ping, with an on-screen banner and vibration as well. |
| **Service worker** | Installable, works offline, and keeps the map tiles you have already seen. |

Messages are small JSON blobs on one topic per room:

```
sarvam-convoy/v1/<room-code>/bus

{ "t":"hello",      "id":"c-9f2k...", "name":"Priya" }
{ "t":"pos",        "id":"c-9f2k...", "name":"Priya", "lat":-33.86, "lng":151.20,
                    "spd":12.4, "hdg":118, "acc":7, "ts":1760000000000 }
{ "t":"dest",       "id":"c-9f2k...", "by":"Priya", "lat":-33.90, "lng":151.30,
                    "label":"Bondi Beach" }
{ "t":"eta",        "id":"c-9f2k...", "dur":1840, "dist":24300 }
{ "t":"dest-clear", "id":"c-9f2k...", "by":"Priya" }
{ "t":"bye",        "id":"c-9f2k...", "name":"Priya" }
```

Each phone works out **its own** arrival time — it routes itself to the destination and
publishes how long it will take. Everyone else just displays it, so the times stay accurate
and nobody has to route the whole group.

Nothing is stored anywhere. When the last person leaves, the room is empty.

---

## Customising

`route.js` — search and routing:

```js
country: 'au',                              // 'au' Australia, 'in' India, '' anywhere
countryBox: { au: '112,-44,154,-10', in: '68,6,98,36' },
osrm: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
```

`app.js` — the app:

```js
brokers: [ ... ],       // public relays, tried in order
publishMs: 5000,        // how often a phone shares its position
etaMs: 60000,           // how often it recomputes its arrival time
fallbackCenter: { lat: -33.8688, lng: 151.2093 },   // shown before GPS arrives
```

The look follows your phone's light or dark setting. In dark mode the OpenStreetMap tiles are
darkened with a CSS filter, because the only keyless tile source is the standard light one —
point the tile layer at a real dark basemap (which needs a key) and drop that rule for a
proper night map.

---

## Testing

Four headless jsdom suites run the real `app.js` and `route.js` against stubbed Leaflet, MQTT,
geolocation, notifications and network — 173 checks:

```bash
npm install
npm test
```

- `tests/app-test.js` — starting a group, joining by code and by link, people appearing,
  arrival times computed and shared, destination changes from either side, and every
  notification.
- `tests/route-test.js` — place search, the fallback when Photon is down, the car route, and
  the search sheet end to end.
- `tests/map-test.js` — rejoining on launch, unique car colours, and the view that keeps
  everyone in frame.
- `tests/pwa-test.js` — manifest, icons, service worker, and that the removed features are
  really gone.

---

## Limits worth knowing

- **Notifications need the app open** (see above). This is the big one.
- **Arrival times come from a public routing service.** If it is busy or the phone has no
  signal, that person shows a dash until it recovers.
- **The relay is public.** Anyone who guesses the room code can watch the room. Use a code
  that is hard to guess and do not post it publicly.
- **Colours repeat past ten cars.** There are ten in the palette.
- **Ten cars or so is the comfortable ceiling** for a room.

## License

MIT. See [LICENSE](LICENSE).
