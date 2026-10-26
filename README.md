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

To bring someone in, tap **Invite**. The message leads with the **link**, because a link can be
tapped and needs no typing at all: it carries the room code, so the code is filled in for them
and the only thing they type is their name. The code is repeated underneath as a fallback, for
anyone the link will not open for — and **codes are not case-sensitive**, so capitals and spaces
are folded away and `Goa Trip` and `goa-trip` are the same room. The shared link uses a query
string (`?r=`) rather than a `#` fragment, since chat apps and link previewers keep that more
reliably.

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

The sheet under the map puts **the people first**, then the one switch, then the room name —
which is only a label and does not deserve the best space in the sheet. When there is no
destination it says so once, in the header, rather than on every row.

It holds one switch:

- **Hide my location** takes you off everyone's map without leaving the room, and *tells* the
  group you have hidden rather than going quiet — so nobody thinks you have been lost.

There is deliberately no battery switch: sharing every 30 seconds is simply the setting, chosen
for battery life, because on a long drive that is the difference between arriving with a phone
and arriving with a dead one. It is well inside the 90 seconds that counts as out of contact, so
sharing less often can never make anyone look lost. Nor is there a button to say you have
arrived — coming within 50 m of the destination does it, and until then everyone keeps seeing
your arrival time.

**Names on the map** are shown for your own car, the nearest one, and whichever car you have
tapped. Every name at once collides into an unreadable stack the moment cars are close, which
is exactly when the map matters; the dots always show everyone, and tapping a car names it and
brings the map to it. Tapping a name in the list does the same. A car within 50 m reads
*"next to you"* rather than `0 m N`. Each row
says how long ago you last heard from them, and — once a destination is set — who is ahead of
you and who has fallen behind: *"3.2 km behind you"*. When someone comes within 50 m of the
destination the room is told, *"Priya has arrived"*, and their arrival time is replaced by
"arrived" — nobody has to press anything.

There is **no room name** — only the code. A name was tried and removed: it is the code that
puts two phones in the same room, and a friendly label beside it invited people to type the
name into the code box and land in a different room altogether. One identifier, no ambiguity. And if someone pastes the whole invite link
into the code box, the app pulls the code out of it for them.

## The screen stays awake

While Convoy is open — in a browser tab or as the installed app — it holds a screen wake
lock, so the phone does not go to sleep mid-drive, the way a maps app behaves. Browsers drop
that lock the moment the page is hidden and never hand it back on their own, so it is taken
again every time the app returns to the front, and on any touch, which is also what iOS needs
in Low Power Mode. There is no switch for it, for the same reason there is no switch for the
sharing rate.

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
- **A link opens the app on Android, but never on an iPhone.** The manifest claims the app's
  own address, so on Android Chrome hands a link to the app already on the home screen rather
  than opening a tab. Apple gives a web page no way to do that — there is no manifest field, no
  API, and Universal Links need a real native app — so on an iPhone a link always opens in
  Safari. The join card says so, walks them through adding it and opening it from the home
  screen, and offers a button to copy the code, since carrying that across is the one manual
  step an iPhone forces. This is the one place the two phones genuinely cannot be made to
  behave the same, and it is Apple's rule.
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
| **MQTT over WebSocket** | One topic per room carries positions, the destination and arrival times. Four public relays, tried in turn — and one of them listens on port 443, because mobile networks routinely block the 8081/8084/8884 the others use. That is why a laptop on Wi-Fi can go live while a phone on mobile data never connects. |
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
stubbed Leaflet, MQTT, geolocation, notifications and network — 600 checks:

```bash
npm install
npm test
```

- `tests/app-test.js` — starting a group, joining by code and by link, people appearing,
  arrival times computed and shared, destination changes from either side, every notification,
  and inviting: the link going into the share text as well as the url, the older copy method,
  the link shown by hand when nothing else works, and both shapes of invite link.
- `tests/presence-test.js` — the location watch being armed again on coming back and on a
  touch while we have none, announcing that our own app went to the background and back,
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
- `tests/features-test.js` — last-seen times, arrival announcements and their reset, that
  arriving is automatic and has no button, the sharing rate and that there is no switch for it,
  the sound, the hide-my-location switch, a long press setting the destination, pasting an
  invite link into the code box, naming the room, tapping a person, who is behind whom, and
  that a phone with no position yet is never handed to the map.
- `tests/route-test.js` — place search, the suburb beating the city, the postcode, a fuller
  answer arriving after the quick one, a service answering with an empty list not hiding one
  that has an answer, a broken service not emptying the search, the country restriction never
  being the reason for nothing, the message saying which of the two kinds of failure it was,
  the bias towards where the phone is, the rate gap and the cache, tapping a result actually
  setting it, the row surviving the fuller answer arriving underneath a finger, the
  recent-places history and its five-item cap, the car route, and the search sheet.
- `tests/map-test.js` — rejoining on launch, unique car colours, the view that keeps
  everyone in frame, the one-tap-out / two-taps-in gestures, and which cars carry a name.
- `tests/pwa-test.js` — manifest, icons, service worker, and that the removed features are
  really gone.

---

## Limits worth knowing

- **Notifications need the app open** (see above). This is the big one.
- **A force-kill cannot be told apart from no signal.** Both look like silence, so the app
  reports "out of contact" rather than claiming to know which.
- **Arrival times come from a public routing service.** If it is busy or the phone has no
  signal, that person shows a dash until it recovers.
- **A phone whose location is switched off still appears on everyone's list.** Until this,
  a person was only added to the list when they sent a *position*, so a laptop with location
  off got a "joined" notification and was then invisible — it could see everyone and nobody
  could see it. Anyone we hear from at all goes on the list now, reads "not sharing their
  location", and says hello every thirty seconds so it does not age into "out of contact".
- **A relay that keeps dropping is abandoned after two quick drops.** A connection that held
  for a minute and then ended is not a flap, so it is kept. The keepalive is 30 seconds
  because mobile networks drop idle sockets well before MQTT's default minute, and each
  attempt uses its own client id — two copies of the app on one phone share a device id, and
  a broker kicks the older session when a second client arrives with the same one, which
  looks exactly like a connection that keeps dropping.
- **A missing relay library used to look like a blocked network.** The MQTT library comes
  from a CDN; if it did not arrive, every relay attempt threw before reaching the network
  and the app cycled the relays for ever — the same symptom as a carrier blocking the
  ports. There is now a second source (jsDelivr) and, if both fail, the app says
  "relay library missing" rather than pretending to try.
- **The 443 relay is tried first**, because outdoors on mobile data it is the only one that
  can work.
- **Updates can lag on GitHub Pages.** Its files carry a ten-minute HTTP cache, so a phone
  can keep running an older build with nothing looking wrong — which is why the app now
  bypasses that cache for its own files, asks for a new service worker on open and on
  returning to the front, and prints the build it is running in the relay check.
- **Tap the connection state to find out what the relays are doing.** It opens a plain
  WebSocket to each relay and reports reached, blocked or no answer — the one question a
  connection attempt cannot answer, because a blocked port, a dead broker and a bug in the
  app all look the same from inside one.
- **A mobile network can block the relay entirely.** The public relays sit on ports 8081,
  8084 and 8884; carriers block everything but 80 and 443. The app now includes one relay on
  443 and, after a few failures, says "relay unreachable" rather than sitting on "connecting"
  for ever. If a phone cannot connect, try Wi-Fi first.
- **The relay is public.** Anyone who guesses the room code can watch the room. Use a code
  that is hard to guess and do not post it publicly.
- **Coming back from the background re-arms the location watch.** iOS in particular can
  drop it while the app is away, and without it you are on nobody's map — not even your own.
  It is armed again every time the app returns, and on any touch while you still have no
  position, since iOS will not hand over a location until the page has been touched.
- **A force-quit still lands you back in the room.** The room, your identity and your name
  all live on the phone, so reopening puts you straight back in. If the name ever went
  missing, the room's own roster has it, because you were added to it when you joined.
- **Clearing the destination is a small cross on the destination row**, not a button inside
  the search sheet, so search keeps one job.
- **Your recent places live on your phone.** They are not shared with the room and are not
  on any server, so a phone that is wiped loses them.
- **The roster lives on each phone.** A phone that has never had the room does not know who
  was in it, so the group reappears only on phones that were there — which is every phone
  that had the room, since each one keeps its own copy.
- **Colours repeat past ten cars.** There are ten in the palette.
- **Ten cars or so is the comfortable ceiling** for a room.

## License

MIT. See [LICENSE](LICENSE).
