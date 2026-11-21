# Moving Convoy onto Supabase

The app works without a server today: the phones carry everything and public MQTT relays
connect them. Supabase changes that deliberately — it buys four things the relay-only
version cannot have.

| What it fixes | How |
|---|---|
| The pin holder has to be online | Membership is a row, so an admin can approve someone while their own phone is shut |
| A wiped phone loses everything | The roster and who is allowed in live in Postgres, not in one phone's storage |
| Public brokers flake | One channel you control |
| A backgrounded app goes quiet | Web Push reaches a phone with the app closed |
| The pin is obfuscation | It becomes a database check; the plaintext never reaches a client |

**The transport is switchable per phone**, from Help → *Transport*. That is deliberate: try
both on a real trip before committing.

---

## What the free tier actually gives you

Checked November 2026.

| | Free |
|---|---|
| Database | 500 MB, shared CPU, 500 MB RAM |
| Realtime | **200 concurrent connections**, 2 million messages/month, 100 msg/sec |
| Edge Function invocations | 500,000/month |
| Egress | 5 GB |
| Active projects | 2 (paused projects don't count) |
| **Pausing** | **After ~1 week of low activity** |

For a convoy of ten phones this is roomy: ten connections out of two hundred, and a weekend
trip is roughly ten thousand messages out of two million.

**The pausing is the one real trap.** A convoy app is used at weekends, which is exactly the
pattern that gets paused — and a paused project means the first launch of your trip fails
until you resume it from the dashboard. Two things make this a non-issue:

1. `.github/workflows/keepalive.yml` in this repo runs one cheap query a day. A few requests
   a day is enough to keep a free project awake. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   as repository secrets and it works.
2. If it does pause, it is restorable for up to a year, with the data intact.

If it ever matters enough to stop thinking about, Pro is $25/month and paid projects never
pause.

---

## Setting it up

1. **Create a project** at supabase.com — the free plan is enough.
2. **Run the migrations**, in order, in the SQL editor:
   - `supabase/migrations/0001_init.sql` — tables, row-level security, the pin
   - `supabase/migrations/0002_asks.sql` — retained join requests
   - `supabase/migrations/0003_push.sql` — push subscriptions and events
3. **Turn on anonymous sign-ins**: Authentication → Providers → Anonymous.
   This is what gives every phone a real `auth.uid()` with no sign-up screen, and it is what
   row-level security keys on.
4. **Set the pin.** `claim_admin()` compares a SHA-256 of what the phone sends against
   `pin_hash()`. Change the hash in `0001_init.sql` (or with
   `select encode(digest('your pin', 'sha256'), 'hex')`) and re-run that one function.
5. **Fill in `config.js`** with the project URL and the **anon** key. That key is public by
   design — row-level security is the boundary. The `service_role` key must never go there.
6. **Push (optional).** `npx web-push generate-vapid-keys`, put the public key in
   `config.js` as `vapidPublicKey`, and the private key in the function's secrets:
   ```
   supabase functions deploy push --no-verify-jwt
   supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:you@example.com
   ```
   Then schedule it every minute.
7. **Switch a phone over**: open Help, tap *Transport*. It remembers the choice.

---

## How the pieces map

| Before | Now |
|---|---|
| `mqtt.connect` to four relays | `supabase.channel('convoy')` — broadcast for positions, postgres changes for membership and the destination |
| Retained ask topic per phone | A row in `asks` — survives a broker restart and a week of nobody being online |
| `convoy.record` in localStorage | `members` — the roster, who is allowed, who is removed, who is admin |
| Destination broadcast | A row in `convoy`, so a phone that was closed catches up |
| Pin hash in the client | `claim_admin(pin)` — compared in the database, never shipped |
| Nothing reaches a closed app | Web Push via the `push` Edge Function |

The app's own device id is still the key in `members.id`. That matters: the same phone is the
same person whether it is on the relays or on Supabase, so switching does not look like a
stranger arriving.

---

## The whole scenario set, run on Supabase

`CONVOY_NET=supabase` makes the harness boot every phone onto the Supabase driver instead of
the relays — a shared in-memory stand-in with real tables, broadcasts between apps, and the
admin guard enforced the way the database trigger enforces it. `npm run test:supabase` runs
the lot.

Thirteen suites, **1122 checks**, all passing on Supabase:

| Suite | On Supabase |
|---|---|
| app / roster / install | 74 / 34 / 47 |
| presence | 101 (11 relay-specific checks skipped) |
| route / map | 155 / 77 |
| features / pwa | 205 / 162 |
| scenario / sim / rejoin | 83 / 44 / 46 |
| heartbeat / supabase | 65 / 29 |

**fleet-test does not finish** on Supabase inside the sandbox's 300-second limit: ten phones
means ten anonymous sign-ins, and every membership write notifies every phone, so the suite
that boots ten apps repeatedly is simply too slow under the stand-in. Its coverage — a
ten-phone convoy through a whole journey — is what `sim-test` does, and that passes 44/44.
Treat fleet as unverified on Supabase until it can be given more time.

Eleven checks are **skipped, not passed**, on Supabase because they test the relay machinery
itself: MQTT reason codes, moving between relays, a flapping relay, a missing relay library,
client ids, retry pacing. None of that exists with one project, and pretending otherwise
would inflate the count.

## Two real bugs this found

- **A phone that took the pin on while connected was never shown the requests already
  waiting.** On the relays, re-subscribing makes the broker re-send what it holds; on
  Supabase the asks are rows read only when the channel opens, so nothing refreshed them.
  Found by `fleet-test` on Supabase, fixed with a `refreshAsks()` on the driver.
- **Closing the search within 60 ms of opening it re-opened it**, because the delayed focus
  re-triggered the field's own focus handler. A pre-existing flake, caught while re-running
  `route-test` on the new transport.

## What is still not tested

- The SQL itself has never been run against a real Postgres. Read it before you run it.
- The Edge Function has never been deployed or invoked.
- Web Push has never delivered a real notification.
- The real Realtime payload shape, and real RLS enforcement.

Treat those as unverified until your first real trip. If something fails, the transport
switch in Help puts every phone back on the relays in two taps.

**Not tested, because this sandbox cannot reach supabase.co and has no project:**
- The SQL itself has never been run against a real Postgres. Read it before you run it.
- The Edge Function has never been deployed or invoked.
- Web Push has never delivered a real notification.
- The exact Realtime channel payload shape.

Treat those four as unverified until your first real trip. If something fails, the transport
switch means you can put every phone back on the relays in two taps.
