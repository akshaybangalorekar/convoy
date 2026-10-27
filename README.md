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

Open the link and you are on the map. There is no code, no sign-in and nothing to fill in: your
name comes from the device and can be changed by tapping it in the list. If the phone with the
pin is around, it lets you in; until then you see a waiting note and nothing else.

To bring someone in, tap **Invite**. The message is just the link — a link can be tapped and
needs no typing at all.

**The search bar rides above the keyboard.** A phone shrinks the visible area when the
keyboard opens, but a fixed overlay stays put in the layout viewport — so a bottom-anchored
sheet ends up behind the keyboard with the field you are typing into invisible. The sheet is
lifted by exactly the height the keyboard takes, measured from `visualViewport`.

**The map uses the standard OpenStreetMap tiles**, which are the only ones left that need no
API key. The styled basemaps that look like a phone map — CARTO, MapTiler, Stadia — all want a
key now, and a key cannot be shipped in a page that anyone can read. If you want one of those
styles, get a free key and it is a one-line change in `TILES`.

An earlier version tried CARTO without a key and the map came up asking for one. That is the
whole reason this is now the plain tiles and nothing else: one source, no key, no fallback
machinery to go wrong.

**The map goes dark after sunset.** Not on a clock and not on a phone setting: the sun's
elevation is worked out for where you are, and the tiles are darkened when it drops below
-0.833°, which is the standard definition of sunset. Only the tile pane is filtered, so the
cars keep their own colours — they are what you are reading the map for. It follows the sun
as you drive, so a long trip at dusk changes over on its own.

**Search results lead with the name of the place** when the map service gives one — the hotel,
the lookout, the station — with the address underneath. That is what tells you a result is the
place you meant; an address alone could be any building on the street. A plain street address
is not given a name line, because the service calls it by its own street name and the row would
say the same thing twice. Choosing a named result puts the name on the destination bar too.

Someone opening that link for the first time is also **offered the app on their home screen**,
so it opens full-screen from then on rather than in a browser tab. On Android that is one tap —
the browser hands the app its own install prompt and the app fires it from its own button.
**On iOS Safari there is no such thing**: Apple does not let a page trigger the install, so the
app shows where the Share button is and the user does it in two taps. That is a platform limit,
not something we chose.

**Neither phone shows a system pop-up of its own** — what you get is this app's own card. It
appears whenever the app is not already installed on that phone, which includes after someone
deletes it, and never inside an app that is already on the home screen. "Not now" is remembered.

If someone installs from an invite link, they land in the one room, so the
installed app still offers them the right room rather than starting a new one.

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

**Every car on the map is a car**, not a dot: a small body in that person's own colour with
a white outline, turned to face the way they are heading. **Nothing on the map is ever grey or
faded**, because a colour is the only thing telling one car from another — a greyed-out car is
a car you cannot name. Someone who has gone quiet is still drawn in their colour; the list is
what says they are lost.

**The map turns so the way you are going is up**, the way a sat-nav does, and a small badge in
the bottom-left corner says which way that is — **NE**, **SW**, **N**, **E**. Tapping the badge
turns the rotation off and puts the map back north-up; tapping again turns it on. It only turns
while the view is following you, so once you have dragged or zoomed the map yourself it is left
exactly where you put it.

Rotation is not something Leaflet does on its own: it needs `leaflet-rotate`, pinned and
hash-checked like Leaflet itself. Everything that touches it is guarded — if that script never
loads, the map is simply north-up as before and nothing breaks. The sign is worth knowing: the
plugin turns the map clockwise by the bearing, so the bearing is set to the negative of the
heading to put that heading at the top. That was measured, not guessed.

**There are no zoom buttons.** A tap on the map zooms out and two taps zoom in; pinch works
too, as it always did. The + and − were the only chrome left in that corner, and they were
redundant.

**The view keeps everyone in frame.** `fitBounds` zooms in when the cars are bunched together
and out when they are spread apart, with the zoom capped at 18 so a tight group is pulled
apart rather than left as one blob. Take the map yourself — drag, zoom, or tap a name — and it
stops chasing.

**Names on the map** are shown for your own car, the nearest one, and whichever car you have
tapped. Every name at once collides into an unreadable stack the moment cars are close, which
is exactly when the map matters; the dots always show everyone, and tapping a car names it and
brings the map to it. Tapping a name in the list does the same. A car within 50 m reads
*"next to you"* rather than `0 m N`. Each row
says how long ago you last heard from them, and — once a destination is set — who is ahead of
you and who has fallen behind: *"3.2 km behind you"*. When someone comes within 50 m of the
destination the room is told, *"Priya has arrived"*, and their arrival time is replaced by
"arrived" — nobody has to press anything.

**Everything lives at the bottom of the screen**, and the sheet is the bottom-most thing —
flush to the edge, square at the bottom, with the phone's safe area handled inside it, so no
map shows underneath: the people, then a
row of four equal buttons — **Invite**, **Sharing**, **Location** and **Help** — each an icon
over one short word so they all match whatever the state. The connection state sits in the
sheet's header, beside the count. The top of the screen holds only the destination.

- **The buttons are dark with a bright orange symbol**, so the thing you press is the
  brightest thing on the screen. **Sharing** inverts when you are hidden — the whole button
  goes orange and the eye turns dark — which is the exact opposite of sharing, so there is no
  reading it twice. It says what state you are in rather than what the button does, which is
  what lets it be the same size both ways.
- **There is no separate recenter button** — Location does that job, and a second circle
  doing nearly the same thing was one more thing on the map.
- **There is no separate recenter button** — Location does that job, and a second circle
  doing nearly the same thing was one more thing on the map.
- **All** frames every car at once, yours included, and starts following again so they stay
  in frame. Zooming in on one car is a pinch away, which beats a button guessing which car
  you meant. With no fix yet it asks for one instead of jumping to nowhere. Your name is
  edited by tapping it in the list — your row is the only editable one, and it carries a
  dashed underline.

**There is no code and nothing to set up.** Open the app and you are in the same room as
everyone else who has it open: no invite code, no room name, no sign-in. Your name is the one
thing anyone needs, and it is taken from the device — an iPhone shows as "iPhone 4a" — so even
the first launch asks for nothing. You can change it in the sheet.

The trade is worth stating plainly: keeping two separate groups apart requires an identifier,
so with none there is only ever one room. That suits a group who all know each other, which is
what this is for. An invite is now just the app's own address.

## The pin: who gets in, and who gets out

Nobody is in the room until the phone with the pin lets them in.

- **Opening the app puts you in the waiting room**, not the room: you see "waiting for
  someone to let you in" and nothing else — not the people, not the destination.
- **Outside the room there is one button, and it says Join the convoy.** The four only appear once you
  have been let in. Pressing Join sends the ask and **the button becomes Cancel request** —
  it does not offer Join again while a request is outstanding. Pressing that withdraws the
  ask and the row disappears from the pin phone's list too, because the ask is a flag on
  every message a phone outside the room sends rather than a single shout.
- **Help stays reachable from outside**: hold the connection word in the sheet header. That
  is where the pin field lives, so a new phone can still unlock itself without being in.
- **The request goes to everyone, and only the master sees it.** It appears at the top of
  the list as *"Priya wants to join"* with **Let in** and a cross. On a phone without the
  pin the same message arrives and draws nothing at all.
- **This is the only banner in the app.** Everything else that used to raise one — a relay
  that cannot be reached, a location that is blocked, a name that is not recognised — is
  said in place instead: on the connection state in the header, or on your own row.
- **Let in** adds them to the allowed list, which is broadcast and remembered, so they stay
  in from then on. **The cross** marks them out, and they are not asked about again.
- **The list is announced again whenever anyone speaks.** A single broadcast is not enough:
  it can go out before the approved phone is listening, which leaves it waiting for ever.
  Every phone that knows the list re-sends it on hearing from someone new, so an approved
  phone learns even when the master is not around.
- The phone with the pin is in the room by definition, and anyone else who unlocks with the
  pin joins it.

The cost of this is worth being clear about: **the master's phone has to be open** for
anyone new to get in. There is no server to hold a pending request, so a request made while
the master is away waits until they open the app. And a brand-new group has to start with
the phone that has the pin — nothing can approve it otherwise.

Everyone already in the room can still be removed by the master:

- **Help** is a blue button in the row at the foot of the sheet. It carries five short lines —
  zoom, checking the signal, setting the destination, following a car, inviting — then the
  map credit, the version, and at the very bottom a plain unlabelled field. That field is the
  pin. It is a faint line rather than a labelled input, so it advertises nothing.
- **The map credit lives in Help**, not over the map. Leaflet's own attribution strip is
  switched off, so nothing is drawn on top of the map at all; the OpenStreetMap credit is a
  line in Help with a link to the copyright page.
- **Typing the pin in that field** unlocks the master on that phone, and it stays unlocked —
  it is remembered, so it is asked once.
- **A master sees a cross on every other person, and that is the whole action.** Tapping it
  takes them off the group, off the list, off the map and off the roster, name and all — the
  cross is not the first of two steps, and there is no add-back control beside it. They are
  also struck off the allowed list and remembered as removed, so they cannot put themselves
  back. The removal is broadcast, so it happens on every phone and survives a restart.
  **A removal is not a life sentence:** the person can press **Join back** and ask again, and
  you can let them back in. Nothing says they were kicked out — the room simply goes away,
  the sheet says "not in the room", and the button offers to ask again.
  **The removal travels in the state push too**, not only in its one broadcast: a master who
  was briefly offline when they removed someone had nothing to send it with, and the push on
  reconnecting never carried it, so the removed phone never heard. That is why a removal
  could look like it had not happened.
  **A join request outlives the phone that sent it.** This is the one place the app uses a
broker feature rather than plain broadcast, and it matters: a request sent while no pin phone
was connected used to be lost outright. The ask is now published **retained** on a topic of
its own (`…/bus/ask/<id>`), which the broker keeps and hands to whoever subscribes next — so a
pin phone that opens an hour later still sees it, as long as it is under half an hour old.
Withdrawing, being let in, or being removed publishes an empty retained message to clear it,
so nothing accumulates on the broker.

**An ask made while the link is down is not lost either.** The ask is a piece of state on the
phone, not a single shout: it is written to storage, re-published on every tick and on every
reconnect until it is answered or withdrawn. So pressing Join while the relay is still
connecting, or closing the app and opening it again, both still result in the request going
out — the only thing that ends it is being let in or cancelling.

**A phone waiting to be let in hunts for the group.** If it is asking, connected, and hears
nothing from anybody for twenty seconds, it moves to the next relay and asks again — the group
can only be on one of them, and sitting on the wrong one is invisible. There are only a few
relays, so it walks the list.

**Help shows which relay you are on, and whether notifications are allowed.** Two phones on different relays can never see each
  other, and there is no way to tell from the map — so if someone is "lost network" while
  you are plainly online, compare that line on both phones.
  There is no other difference between a master phone and any other.

Two honest limits. **The pin is obfuscated, not secure**: what the code holds is a hash of it,
so the digits do not appear in the source, but a four-digit pin can be brute-forced instantly
and anyone who reads the code can find a way round it. It keeps honest people honest. And
**a removed person can still watch**: there is no server to cut them off, so removal means
every honest phone ignores them — it cannot stop them receiving. Both are consequences of
there being no server, which is the same reason the app is free and needs no sign-up.

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
  screen. This is the one place the two phones genuinely cannot be made to behave the same,
  and it is Apple's rule. There is nothing to carry across any more, since there is no code.
- **Installing is one tap on Android and two on an iPhone.** Android hands the app its own
  install prompt, which it fires from its own button. Safari has no such thing — Apple does not
  let a page trigger it — so the card points at the Share button instead. Note that on iOS the
  home-screen app keeps its own storage, separate from Safari, so it starts fresh: after
  installing, they simply open the app.
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

**What notifies, on every phone in the group:** someone joins, someone leaves, the
destination is set or cleared, and someone arrives. Plus one only the phones holding the pin
see: a request to join, so whichever pin phone is to hand can let them in. There can be more
than one pin phone, and each of them is asked.

**They are shown by the service worker, not the page.** Safari on iOS refuses a notification
made by the page itself, which is the usual reason an iPhone looks like it has no
notifications at all. `showNotification` works on both phones, so it is tried first and the
plain constructor is only the fallback. Nothing shares a tag either — a shared tag makes each
new notification replace the last, so you would only ever see one.

The vibration and the ping come with it **whenever the app is open**.

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
| **left** | They sent a goodbye | They told us |

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

Someone who goes quiet does not raise a banner. Their **circle turns grey** and their row
says why, in the words people actually use:

- **"Lost network · 20 min ago"** — nothing has been heard from them, which in practice
  means the signal went. It is an inference, and it is the honest one.
- **"Shut down app"** — they told us: the app was put away or closed, which it says on the
  way out.
- **"Location is blocked"** / **"waiting for your location · tap anywhere"** — on your own
  row, when it is your phone that has the problem.

Someone brought back from the roster shows as **Lost network** until they send something.
The app does not pretend they are live just because they were here yesterday.

## A refresh, and closing the browser

A force refresh keeps everything that matters, because it is all on the phone rather than in
the page: the device id (so you are still you, still in the room), your name, whether this
phone has the pin, who is in and who is out, the destination, your recent searches, and any
join request still waiting. GPS and the relay come back on their own. The people list is
emptied by the reload and refilled within a second — anyone not already known is answered at
once when you say hello, rather than leaving you looking at an empty map until their next tick.

Closing the browser window is simply the app being gone. No position, no messages, no
notifications; everyone else sees **Lost network · a few minutes** after ninety seconds. The
destination is untouched, because it lives on every phone, not on a server. Open the page again
and you are back in the room under the same id, with your name and the pin still set.

The one thing that does not survive is **iOS Safari deleting a website's storage after seven
days without a visit** — Apple's rule for sites not added to the home screen, and it takes the
device id with it. Come back after a week away and you are a new phone, so you will need
letting in again. Added to the home screen, storage is kept.

## Nobody is dropped

There is one room and no server holding it, so the app makes sure it never closes by
accident:

- **Nobody is dropped.** A phone that goes quiet stays on the list as out of contact. There
  is no timer quietly removing people, and no expiry on the room itself.
- **There is no Leave button, and nothing to leave.** Closing the tab or force-quitting
  sends the same "away" note as backgrounding does, so you look like a phone that went quiet
  rather than someone who walked out. Nobody can remove themselves or anyone else.
- **The roster is kept on the phone.** Reopening puts the whole group back on the list,
  marked out of contact until they reappear — so a phone that comes back after an hour
  rejoins a room that already knows who was in it.

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
stubbed Leaflet, MQTT, geolocation, notifications and network — 740 checks:

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
- `tests/room-test.js` — the roster behind the one room: that it is kept on the phone, that
  using the app keeps it current, that a phone quiet for an hour is still on it, that closing
  the app is not leaving, and that the whole group comes back when you reopen.
- `tests/install-test.js` — who gets offered the install and who does not, the browser's own
  prompt being fired from our button, dismissing it being remembered, the iOS instructions
  where there is no prompt to fire, installing not losing your place, and a link opened
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
- **The relay is public, and there is only one room.** Anyone who opens this app, or who
  subscribes to the same topic on the public broker, sees the same room. That is the price of
  having no code: there is nothing to guess because there is nothing to protect. Share the app
  only with people you would show your location to.
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
