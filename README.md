# Convoy

Everyone in your group on one map, with the time each person will reach the destination.

Three things, and nothing else:

1. **Invite by link.** Anyone in the group can start one and share the link. Whoever opens it
   is on the map.
2. **Anyone can set the destination.** Everyone sees every car, and each person's arrival time
   at that destination — worked out on that person's own phone, so it is accurate for them.
3. **Notifications.** A ping when the destination changes, and when someone joins, leaves or
   drops out of contact.

No sign-up, no account, no backend. Positions and destinations travel as small messages over
a public relay.

Live at **https://akshaybangalorekar.github.io/convoy/**

---

## Try it

Open the link, type your name, and press **Start a new group**. You get a code and a map.

To bring someone in, tap **Invite** and send them the link. They type their name and they are
on your map.

Someone opening that link for the first time is also **offered the app on their home screen**,
so it opens full-screen from then on rather than in a browser tab. On Android that is one tap —
the browser hands the app its own install prompt and the app fires it from its own button.
**On iOS Safari there is no such thing**: Apple does not let a page trigger the install, so the
app shows where the Share button is and the user does it in two taps. That is a platform limit,
not something we chose.

**Neither phone shows a system pop-up of its own** — what you get is this app's own card. It
appears whenever the app is not already installed on that phone, which includes after someone
deletes it, and never inside an app that is already on the home screen. "Not now" is remembered.

If someone installs from an invite link, the code they were invited with is kept, so the
installed app still offers them the right room rather than starting a new one.

To see it work on one phone, tap **Just looking? Preview with demo cars** on the join screen.

On the map: **one tap zooms out, two zoom in.** A tap on a car or a button belongs to that
instead, and a finger that moves was panning, not tapping.

**Hold a finger on the map** to set the destination right there. It looks up what is at that
point, so the row reads as an address rather than a pair of numbers.

Searching for a destination keeps your **last five places** at the top of the search sheet,
ready to tap again. That history is kept on your phone and nowhere else — it is never sent to
the room, so it is yours alone rather than the group's. Picking somewhere you have been before
moves it back to the top instead of listing it twice.

The sheet under the map holds four switches:

- **Pause sharing** stops sending your position without leaving the room, and *tells* the group
  you have paused rather than going quiet — so nobody thinks you have been lost.
- **Battery saver** drops from sharing every five seconds to every thirty. On a long drive that
  is the difference between arriving with a phone and arriving with a dead one.
- **Sound** — a short ping on a notification, which matters most on an iPhone, where there is
  no vibration at all.
- **Arrived** marks you arrived early. You rarely need it: the app does it for you the
  moment you come within 50 m of the destination. Until then everyone keeps seeing your
  arrival time, and once you are there that time is replaced by "arrived".

Tapping a name brings the map to that person and stops the view chasing everyone else. Each row
says how long ago you last heard from them, and — once a destination is set — who is ahead of
you and who has fallen behind: *"3.2 km behind you"*. When someone comes within 50 m of the
destination the room is told, *"Priya has arrived."*

You can also **name the room** — "Sunday drive" instead of `goa-trip` — and the name travels
round the group the same way the destination does. And if someone pastes the whole invite link
into the code box, the app pulls the code out of it for them.

## Put it on your phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app / Add to Home screen.

It then opens full-screen like any other app.

## The same on an iPhone and an Android

Everything works on both. Three things differ, and two of them are Apple's decisions rather
than ours:

- **A link shared in a chat opens in the chat app's own browser.** WhatsApp, Instagram and
  Facebook all do this. That browser has no location, no notifications and no installing — so
  the app notices where it is and says **"Open Convoy in your browser"**, pointing at the right
  button for the phone it is on. This is the one to know about if you are sharing by WhatsApp:
  the link works, but the recipient should open it in Safari or Chrome for the full app.
- **Installing is one tap on Android and two on an iPhone.** Android hands the app its own
  install prompt, which it fires from its own button. Safari has no such thing — Apple does not
  let a page trigger it — so the card points at the Share button instead. Note that on iOS the
  home-screen app keeps its own storage, separate from Safari, so it starts fresh: after
  installing, that person needs the room code again (or the link).
- **Notifications on an iPhone need the app installed.** In a plain Safari tab iOS gives a page
  no way to notify you at all. Once Convoy is on the home screen it can ask, and then it behaves
  like Android. On Android it works in the tab as well. Vibration is Android only, because
  `navigator.vibrate` does not exist in Safari — which is exactly why there is a sound, and why
  it needs one touch before the browser will let it play anything.

Everything else behaves identically: the live map, the destination anyone can set, everyone's
arrival time, the notifications that do arrive, unique car colours, the view that keeps everyone
in frame, one tap out and two taps in, the last five places, and — on Android, which is the only
one with a back button — back closing the search sheet instead of leaving the app.

## The one thing to know about notifications

The ping appears as a banner on screen and a vibration **whenever the app is open**, and as a
system notification too if you allow it.

**It cannot arrive when the app is fully closed.** Waking a closed app needs a push service
and a server to send through, and this app deliberately has neither. So: leave Convoy open
(or in the background) on the drive and the pings land; force-quit it and they will not.
That is a real limitation, not a setting.

## Who is still with you

Each person on the list is in one of four states, and the app is careful about which is
which:

| | What it means | How we know |
|---|---|---|
| **live** | Sending positions | They are publishing |
| **app in the background** | Their phone put the app away | They *told us* on the way out |
| **out of contact** | Nothing has arrived for a while | We are *inferring* from silence |
| **left** | They pressed Leave | They told us |

When someone's app is put away, the phone sends one last note on the way out, so the group
sees "app in the background" instead of guessing. When it comes back it says so, pushes its
whole state again, and the group gets an "is back" ping.

**A force-kill cannot announce itself.** That is the one thing a killed app cannot do — the
code is gone before it can send anything. So a force-kill shows up as **out of contact**:
nothing has arrived, and after 90 seconds of silence the group is told, once. The wording
deliberately does not claim to know *why*. Silence in a tunnel and a force-kill look
identical from the other phones, and the app says so rather than guessing.

In practice a force-kill often *does* leave a trace, because iOS and Android background an
app before killing it — so the "away" note frequently gets out, and the group sees "app in
the background" rather than silence. But that is a happy accident, not a guarantee.

Someone brought back from the room's roster shows as **out of contact** until they send
something. The app does not pretend they are live just because they were here yesterday.

## The room stays open

A room is not something the app can close, because there is no server holding it — so
instead it makes sure it never closes one by accident:

- **Nobody is dropped.** A phone that goes quiet stays on the list as out of contact for as
  long as the room is open. There is no timer quietly removing people.
- **Closing the app is not leaving.** Shutting the tab or force-quitting sends the same
  "away" note as backgrounding does, so you look like a phone that went quiet rather than
  someone who walked out. Only the **Leave** button takes you off the room's roster.
- **The room is remembered for a week.** Each phone keeps the room — its code, its
  destination, and everyone who has been in it — and it lapses a week after anyone last used
  it, so a room in use never closes. Reopen the app inside that week and the whole group is
  back on the list, marked out of contact until they reappear.
- The foot of the sheet says where you stand: "Room open for another week", or a countdown
  once it has been quiet for a while.

The week is `CFG.roomDays` in `app.js`.

## Where the state lives: on the phones

The room has no server, so the shared state lives on the phones and is rebuilt by everyone
re-announcing it. When a phone reconnects — after a tunnel, a background spell, or being
reopened — it pushes everything it knows in one go: who it is, where it is, the
destination, and its arrival time.

That works because the two kinds of state are treated differently:

- **The destination is a decision, so it is kept.** Each phone stores the destination and
the moment it was decided. Reopening the app restores it and puts it back on the air, so a
room can outlive every phone in it. Every destination carries its timestamp, so the newest
decision wins and a phone coming back cannot overwrite it with what it remembered from
before. Clearing counts as a decision too.
- **Positions are measurements, so they are not kept.** A remembered position is a lie — it
says someone is somewhere they left ten minutes ago. They are never restored, only received
live.

So the only thing that has to survive is a decision, and decisions are tiny. That is what
makes a server unnecessary here rather than merely absent.

---

## How it works

| Piece | What it does |
|---|---|
| **Leaflet + OpenStreetMap** | Draws the map and the cars. Free, no API key. |
| **MQTT over WebSocket** | One topic per room carries positions, the destination and arrival times. |
| **Photon / Nominatim** | Place search. Photon is asked first, always — it is quick and has no rate limit. A street address (a query starting with a number) that comes back without a postcode is then looked up through Nominatim, which keeps the suburb and postcode that Photon often drops; the quick answer shows first and the fuller one swaps in when it lands. Both free, no key. Results are reassembled from the parts each service returns: number and street, then the suburb, then state and postcode, so `92 mimosa road` reads `92 Mimosa Road, Carnegie, Victoria 3163`. Whatever is more local than the city wins. The search leans towards where the phone is, and Nominatim calls are spaced a second apart. **If the country restriction hides everything, the question is asked again without it** — a preference must never be the reason for "nothing found". |
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
                    "label":"Bondi Beach", "ts":1760000000000 }
{ "t":"eta",        "id":"c-9f2k...", "dur":1840, "dist":24300 }
{ "t":"dest-clear", "id":"c-9f2k...", "by":"Priya", "ts":1760000000000 }
{ "t":"away",       "id":"c-9f2k...", "name":"Priya" }
{ "t":"back",       "id":"c-9f2k...", "name":"Priya" }
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
staleMs: 90000,         // silence before someone counts as out of contact
awayMs: 180000,         // backgrounded this long counts as out of contact too
roomDays: 7,            // a room lapses this long after anyone last used it
tapZoom: { delayMs: 260, moveTolerancePx: 12 },   // one tap out, two taps in
fallbackCenter: { lat: -33.8688, lng: 151.2093 },   // shown before GPS arrives
```

The look follows your phone's light or dark setting. In dark mode the OpenStreetMap tiles are
darkened with a CSS filter, because the only keyless tile source is the standard light one —
point the tile layer at a real dark basemap (which needs a key) and drop that rule for a
proper night map.

---

## Testing

Eight headless jsdom suites run the real `app.js`, `route.js` and `install.js` against
stubbed Leaflet, MQTT, geolocation, notifications and network — 496 checks:

```bash
npm install
npm test
```

- `tests/app-test.js` — starting a group, joining by code and by link, people appearing,
  arrival times computed and shared, destination changes from either side, every notification,
  and inviting: the link going into the share text as well as the url, the older copy method,
  the link shown by hand when nothing else works, and both shapes of invite link.
- `tests/presence-test.js` — announcing that our own app went to the background and back,
  seeing the same for someone else, the out-of-contact sweep and its wording, the full
  state push on reconnect, and the destination outliving a restart without overwriting a
  newer decision.
- `tests/room-test.js` — the room's life: that it lasts a week, that using it pushes the
  week out, that a phone quiet for an hour is still in the room, that closing the app is not
  treated as leaving, that Leave is, and that the whole group comes back with the room.
- `tests/install-test.js` — who gets offered the install and who does not, the browser's own
  prompt being fired from our button, dismissing it being remembered, the iOS instructions
  where there is no prompt to fire, an invite code surviving the install, and a link opened
  inside a chat app being spotted and answered with the right advice for each phone.
- `tests/features-test.js` — last-seen times, arrival announcements and their reset, the
  pause and battery-saver and sound switches, a long press setting the destination, pasting an
  invite link into the code box, naming the room, tapping a person, and who is behind whom.
- `tests/route-test.js` — place search, the suburb beating the city, the postcode, a fuller
  answer arriving after the quick one, a service answering with an empty list not hiding one
  that has an answer, a broken service not emptying the search, the country restriction never
  being the reason for nothing, the message saying which of the two kinds of failure it was,
  the bias towards where the phone is, the rate gap and the cache, tapping a result actually
  setting it, the row surviving the fuller answer arriving underneath a finger, the
  recent-places history and its five-item cap, the car route, and the search sheet.
- `tests/map-test.js` — rejoining on launch, unique car colours, the view that keeps
  everyone in frame, and the one-tap-out / two-taps-in gestures.
- `tests/pwa-test.js` — manifest, icons, service worker, and that the removed features are
  really gone.

---

## Limits worth knowing

- **Notifications need the app open** (see above). This is the big one.
- **A force-kill cannot be told apart from no signal.** Both look like silence, so the app
  reports "out of contact" rather than claiming to know which.
- **Arrival times come from a public routing service.** If it is busy or the phone has no
  signal, that person shows a dash until it recovers.
- **The relay is public.** Anyone who guesses the room code can watch the room. Use a code
  that is hard to guess and do not post it publicly.
- **Your recent places live on your phone.** They are not shared with the room and are not
  on any server, so a phone that is wiped loses them.
- **The roster lives on each phone.** A phone that has never had the room does not know who
  was in it, so the group reappears only on phones that were there — which is every phone
  that had the room, since each one keeps its own copy.
- **Colours repeat past ten cars.** There are ten in the palette.
- **Ten cars or so is the comfortable ceiling** for a room.

## License

MIT. See [LICENSE](LICENSE).
