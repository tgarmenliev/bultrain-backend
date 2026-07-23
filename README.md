# BulTrain backend

Express 5 API behind nginx, serving the BulTrain iOS app, the Android app and an
E-ink station display. Data lives in a single SQLite database (`better-sqlite3`,
WAL mode); schedules come from the national GTFS feed and live delays from its
GTFS-Realtime companion.

```bash
npm start        # node server.js
```

```bash
npm test         # scripts/ci-check.sh — native module, syntax, migrations, routes, unit tests
```

Configuration is entirely environment variables — copy `.env.example` to `.env`
and fill it in. Nothing secret is ever committed.

Background jobs are each behind a flag (`REALTIME`, `RT_HISTORY`,
`LIVE_ACTIVITY`) so code can be deployed and inspected on the server before it
starts doing work.

---

## Live Activity push updates

The iOS app shows a Live Activity for the journey in progress. While the app is
suspended or terminated it cannot refresh that card itself, so the server pushes
updates to it over APNs.

### How it works

The app registers its ActivityKit push token together with the journey context.
A worker ticks every 30 seconds, reads the realtime cache the GTFS-RT poller
already maintains — **it adds no polling of its own** — and pushes only when
something a passenger would actually notice has changed:

| Trigger | Priority |
|---|---|
| First push for a token | 5 |
| Phase change (`preDeparture` → `inTransit`) | 10 |
| Delay crosses the 2-minute threshold, in either direction | 10 |
| Delay jumps by 5 minutes or more | 10 |
| Delay appears or disappears (feed gained/lost the train) | 5 |
| Next stop changes | 5 |

Steady state sends nothing at all. `apns-priority: 10` is deliberately the
exception: it consumes the activity's update budget faster and Apple throttles
accordingly, so a train wobbling between 3 and 4 minutes late must not spend it.

Ten minutes after the predicted arrival the worker sends an `end` event with a
dismissal date, so the card disappears on its own even if the app never comes
back to the foreground. An hourly cleanup drops tokens whose journey ended more
than two hours ago.

### Modules

| File | Role |
|---|---|
| `database/migrations/007_live_activity_tokens.sql` | the table |
| `services/liveactivity/store.js` | the only module that touches it |
| `services/liveactivity/contentState.js` | builds the payload the Swift decoder reads |
| `services/liveactivity/apns.js` | HTTP/2 sender, cached JWT, persistent sessions |
| `services/liveactivity/worker.js` | change detection, scheduling, cleanup |
| `controllers/liveActivityController.js` | register / unregister / test-push / metrics |

### Three rules that fail silently

If any of these is wrong, APNs still returns `200`, the device drops the update,
and nothing is logged anywhere. They are covered by unit tests for that reason.

1. **Dates are seconds since the 2001 reference date**, sent as JSON *numbers*:
   `swiftSeconds = unixSeconds - 978307200`. Not ISO strings, not Unix epochs.
2. **Every non-optional Swift property is present on every push.** The
   synthesized `Decodable` throws on a missing key rather than defaulting, and
   one missing key discards the whole update.
3. **Unknown optionals are omitted, never sent as `null`.**

### Setup

Apple Developer portal, once:

1. **Keys → +**, enable **Apple Push Notifications service (APNs)**, register,
   and download the `.p8`. Apple allows that download **exactly once**.
2. Note the **Key ID** (10 characters, also in the filename) and your **Team ID**
   (10 characters, top right of the portal).
3. Confirm the app's bundle identifier has the **Push Notifications** capability.
   Live Activities need no separate entitlement, but the app target must have
   `NSSupportsLiveActivities` set in `Info.plist`.

On the server:

```bash
install -d -m 700 /root/secrets
install -m 600 AuthKey_XXXXXXXXXX.p8 /root/secrets/
```

Then in `.env`:

```
APNS_KEY_P8=/root/secrets/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_BUNDLE_ID=eu.bultrain.app
APNS_DEFAULT_ENV=sandbox
LIVE_ACTIVITY=on
```

```bash
pm2 restart bultrain --update-env
```

`--update-env` is not optional: without it pm2 reuses the old environment and
the new variables are silently ignored.

The `.p8` is never committed — `*.p8` and `secrets/` are in `.gitignore`, and a
leaked key must be revoked in the portal because it does not expire on its own.

### Sandbox vs production

APNs has two hosts, and a token from one is meaningless to the other —
the wrong host returns `400 BadDeviceToken`.

| Build | Host |
|---|---|
| Run from Xcode on a device | `api.sandbox.push.apple.com` |
| TestFlight, App Store | `api.push.apple.com` |

The same key and Team ID work for both. The app declares its own environment
when it registers (`"sandbox"` or `"production"`), which is why a TestFlight
build and a debug build can be pushed to from one server at the same time.
`APNS_DEFAULT_ENV` is only the fallback.

### Endpoints

All are behind the mobile API key (`X-Bultrain-Api-Key` plus a
`BulTrainMobile` User-Agent).

```
POST /api/live-activity/register     20/min per client
POST /api/live-activity/unregister   idempotent
POST /api/live-activity/test-push    404 unless ENABLE_LIVE_ACTIVITY_TEST_PUSH=on
GET  /api/live-activity/metrics
```

Neither `register` nor `unregister` talks to APNs. A misconfigured key or an
Apple outage must never stop a device from registering, or trap it in an
activity it cannot end.

### Testing against a real device

Register the token the app printed:

```bash
curl -s -X POST https://api.bultrain.eu/api/live-activity/register -H 'Content-Type: application/json' -H 'User-Agent: BulTrainMobile' -H "X-Bultrain-Api-Key: $IOS_API_KEY" -d '{"token":"<64 hex chars>","environment":"sandbox","journeyId":"test-1","trainNumber":"2612","boardingStation":"София","destinationStation":"Пловдив","directionStation":"Бургас","scheduledDeparture":"2026-07-23T14:30:00Z","scheduledArrival":"2026-07-23T16:45:00Z","currentLegIndex":0}'
```

Set `ENABLE_LIVE_ACTIVITY_TEST_PUSH=on`, restart, and push a hand-written state
straight at the device. The two `Date` fields below are 2001-epoch seconds:

```bash
curl -s -X POST https://api.bultrain.eu/api/live-activity/test-push -H 'Content-Type: application/json' -H 'User-Agent: BulTrainMobile' -H "X-Bultrain-Api-Key: $IOS_API_KEY" -d '{"token":"<64 hex chars>","environment":"sandbox","contentState":{"progressPercentage":0.42,"isDelayed":true,"delayMinutes":7,"lastUpdated":775000000,"phase":"inTransit","directionStation":"Бургас","currentLegIndex":0,"isNextTransportBus":false,"isCurrentTransportBus":false,"predictedArrival":775004500}}'
```

`{"outcome":"ok"}` means Apple accepted it. If the card does not change, the
payload decoded badly on the device — check the three rules above first.

Check what the worker is doing:

```bash
curl -s https://api.bultrain.eu/api/live-activity/metrics -H 'User-Agent: BulTrainMobile' -H "X-Bultrain-Api-Key: $IOS_API_KEY"
```

```bash
pm2 logs bultrain --lines 100 | grep '\[la\]'
```

Tokens are masked in every log line — never paste a full one into an issue.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `400 BadDeviceToken` | token registered against the wrong environment |
| `403 InvalidProviderToken` | wrong Key ID, Team ID, or a `.p8` that has been revoked |
| `403 ExpiredProviderToken` | clock skew on the server — the JWT is refreshed every 50 min |
| `410 Unregistered` | activity ended; the worker deletes the row itself |
| `429 TooManyRequests` | too many pushes for one token — check what keeps changing |
| Accepted, but nothing on screen | decode failure: 2001-epoch dates, a missing key, or a `null` optional |
