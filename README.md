# BulTrain backend

The API behind **BulTrain** — the iOS app, the Android app and an E-ink station
display. It turns Bulgaria's national GTFS schedule and its GTFS-Realtime feed
into clean endpoints for train info, live delays and positions, journey Live
Activities, a guide, and author-written travel articles — plus a web admin panel
to manage it all.

Express 5 (CommonJS) · Node 24 · a single SQLite database (`better-sqlite3`, WAL)
· pm2 fork mode behind nginx. **No ORM, and dependencies are kept few on
purpose** — auth hashing, APNs and JWTs all use Node built-ins.

```bash
npm start     # node server.js
npm test      # scripts/ci-check.sh — native module, syntax, migrations, route load, unit tests
```

Configuration is entirely environment variables: copy `.env.example` to `.env`
and fill it in. Nothing secret is ever committed.

---

## Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Data & schedules](#data--schedules)
- [Realtime: delays & positions](#realtime-delays--positions)
- [Live Activity push updates](#live-activity-push-updates)
- [Articles — the author portal](#articles--the-author-portal)
- [Admin panel & accounts](#admin-panel--accounts)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing & CI](#testing--ci)
- [Operations](#operations)

---

## Architecture at a glance

```
  iOS / Android / E-ink                     Admin panel (React, /admin)
        │  X-Bultrain-Api-Key                       │  admin_token cookie (JWT)
        ▼                                           ▼
  ┌───────────────────────────── Express (server.js) ─────────────────────────┐
  │  /api/*  (verifyMobileClient)          /api/admin/*  (verifyRole)          │
  │  live · train-info · schedule · stations · realtime · live-activity ·      │
  │  articles · guide                       login · articles · media · trains  │
  └───────────────┬───────────────────────────────┬──────────────────────────┘
                  │                                 │
        in-memory realtime cache            SQLite (bultrain.sqlite, WAL)
                  ▲                                 ▲
     GTFS-Realtime poller (30s/15s)      daily GTFS refresh → materialize
                  ▲                                 ▲
             NAP GTFS-RT feeds              NAP GTFS static feed
```

- **Clients** authenticate with an API key (`X-Bultrain-Api-Key`) **and** a
  `User-Agent` containing `BulTrainMobile` (the E-ink screen key is exempt from
  the UA check). See `middleware/verifyMobileClient.js`.
- **Background jobs** are each behind a flag (`REALTIME`, `RT_HISTORY`,
  `LIVE_ACTIVITY`) so code can be deployed and inspected before it starts working.
- **The admin panel** is a React/Vite app served from `admin-ui/dist` at `/admin`,
  protected by a JWT cookie with a role.

---

## Data & schedules

Schedules come from the **national GTFS static feed** (published on NAP). A daily
refresh (`scripts/gtfs-refresh.sh`) downloads and imports it, then materialises a
date-based serving model:

- `trip` — a train number resolves to one or more trips on a date, each with its
  own category (`ПВ/БВ/КПВ/МБВ/АВТ`). A single number can be a train leg **plus a
  replacement-bus leg** (route "A" = Автобус), presented as one journey.
- `trip_date` — which dates a trip runs (calendar-dates model).
- `trip_stop` — the ordered stops of a trip, with scheduled times and coordinates.
- `stations` — our canonical station list; `station_map` maps GTFS stop ids to it.

`stations.json` (repo root) is the **source of truth for coordinates** — the
refresh re-applies it onto the DB (`reconcile-coords.js`). Station names live in
both `stations` (DB) and `stations.json`; fix both, and use a migration for the
DB (see `migrations/008` for the pattern).

**`GET /api/train-info/:lang/:no/:date`** returns a train's full route. Where a
journey switches to a replacement bus, each stop carries `mode: "train" | "bus"`
(the mode of the leg departing that stop), so a train → bus → train journey reads
correctly. `trainType`, `stations[].{station,arrive,depart}` are unchanged; `mode`
is additive.

---

## Realtime: delays & positions

NAP publishes **two separate** GTFS-Realtime feeds with different coverage:
**TripUpdates** (delays + per-stop times, ~40 trains) and **VehiclePositions**
(GPS, ~60 trains). A single poller (`services/realtime/poller.js`, behind
`REALTIME=on`) fetches both every 30s / 15s and keeps an in-memory cache — it
never writes to SQLite.

**`GET /api/realtime/train/:trainNo`** (no language segment) merges the two
feeds. It returns `progressSource` to say what kind of data you got:

| `progressSource` | meaning |
|---|---|
| `"feed"` | full data: real delay + predicted per-stop times |
| `"position"` | GPS only — progress derived from geometry, **delay unknown** |
| `null` | running but no usable progress; show the map dot only |

404 means the train is in neither feed (not running / feed stale) → fall back to
the static timetable. Key rule for clients: `delayMinutes` is **nullable** and a
missing delay is *unknown*, never `0` — do not render it as "on time". For a
position-only train, progress and next stop are computed honestly from the live
GPS projected onto the route geometry (never from assuming on-time), and only
scheduled times are shown, labelled as such.

Other endpoints (same auth): `/api/realtime/vehicle/:trainNo`,
`/api/realtime/vehicles` (all positions), `/api/realtime/status` (poller health).

### Live map

**`GET /api/realtime/vehicles`** is self-sufficient for drawing and colouring the
map, so a refresh needs one request, not one per train. Every entry is a
*measured* VehiclePositions fix — nothing is interpolated or projected from
TripUpdates — and the response is
`{count, feedTimestamp, vehicles:[{trainNumber, lat, lon, bearing, positionTimestamp,
stopStatus, delayMinutes, hasLiveDelay, progressSource, trainType, originStationId,
destinationStationId, nextStationId, serviceDate}]}`. All new fields are additive and
nullable.

- `positionTimestamp` / `stopStatus` are the feed's own `VehiclePosition.timestamp`
  and `current_status`, or `null` when the entity has none — never the poll time
  or the feed header time. **Caveat:** NAP stamps every entity with the feed's
  generation time, so the per-vehicle timestamp equals the feed time and does not
  by itself prove a fix is fresh; a stationary train is told apart by
  `stopStatus: "STOPPED_AT"`.
- `delayMinutes` / `hasLiveDelay` / `progressSource` come from the same
  `summarize()` as `/train/:no`, for the vehicle's *own* run (a TripUpdate of
  another run of the same number is never borrowed). No TripUpdate ⇒ `null`/`false`.
- `trainType` is a language-independent code (`PASSENGER`, `SUBURBAN`, `FAST`,
  `EXPRESS`, `INTERNATIONAL`, `BUS`); origin/destination/next are station **ids**.
  `nextStationId` is the next stop the train *calls at* (timing points and
  `SKIPPED` stops excluded); the older `nextStation` string is unchanged.
- `serviceDate` is derived from the saved schedule (the feed publishes no
  `start_date`), `null` when it cannot be told.
- `ETag` + `Cache-Control: private, max-age=5`; `If-None-Match` → `304` while
  neither feed has ticked.
- In `/train/:no`, `position` gains the same two fields and each feed stop gains
  `callingPoint` (`true`/`false`, `null` if the trip is unknown).
- `previousStationId` is the last stop the train has already passed *and calls at*
  (`null` before it has left its origin) — the same `passed`/`callingPoint` that drive
  `stops` and `nextStationId`, in both `/vehicles` and `/train/:no`.
- `stoppedAtStationId` is the station of the feed's `stop_id`, only while
  `stopStatus` is `STOPPED_AT` (the fix measured a median 13 m from it); `null` in
  transit. (With IN_TRANSIT_TO the feed's stop is where it is heading, not exposed.)

**`GET /api/route-shape/:trainNo?date=YYYY-MM-DD`** returns the track geometry
from the GTFS `shapes.txt`: `{trainNumber, serviceDate, encoding:"polyline6", shape,
totalMeters, stops:[{stationId, distanceMeters}], distanceSource}`. The shape is
simplified (Douglas–Peucker, 10 m); stop distances are projected monotonically onto
it (`distanceSource:"computed"` — the feed has no `shape_dist_traveled` on
stop_times). `404` means no shape for that train/date (also for a replacement-bus
leg): the client draws straight lines. `ETag` + `Cache-Control: private, max-age=3600`.

**`GET /api/route-shapes?date=YYYY-MM-DD`** is the same data for a whole service day
in one download, so a tap on the map is local (date defaults to today in Sofia;
yesterday is valid for overnight trains): `{version, serviceDate, shapes:{<shapeId>:
{encoding:"polyline6", shape, totalMeters}}, trains:{<trainNo>:{shapeId,
stops:[{stationId, distanceMeters}]}}}`. Trains on one route share one shape. It is
built by the same `prepareShape()` / `placeOn()` as the per-train endpoint, for the
same trip choice, so for any train the two agree exactly (`test/route-shape-bundle.test.js`
compares every train). Trains without a shape, and bus legs, are absent — treat that
like the per-train 404. `ETag` = `version` (a hash of the content, so it only moves when
the content does) → `304`; gzip; `Cache-Control: private, max-age=3600`.
`GET /api/route-shapes/version?date=` returns `{version, serviceDate}` without the
download. A day is built once per GTFS import (and at most hourly), in slices that hand
the event loop back — never per request. 404 when no train has a shape that day.

### Public network snapshot (website)

**`GET /api/network`** and **`GET /api/network/radar`** are the data behind the
website's "living network". They are **public** (no API key — a key in a web page
is not a secret), read-only, rate-limited per IP, and answer CORS only for the
website (`https://bultrain.eu`, `https://www.bultrain.eu`, anything in
`SITE_ORIGINS`) and localhost dev ports. Mounted before the global CORS in
`server.js` because that one rejects unknown origins with an error.

Visitors never trigger work. `services/network/snapshot.js` rebuilds both files
**once a minute** from the in-memory realtime cache (a few ms; the feeds tick every
30–60 s, so building more often would only restate the same data), serialises and
gzips them once, and every request is a buffer write. The only outbound cost is
the Sofia/Plovdiv departure boards, scraped from БДЖ **every 5 minutes** by
`services/network/boards.js` (`NETWORK_BOARDS=off` disables it). Starts with
`REALTIME=on`; `503 + Retry-After` until the first build.

`Cache-Control: public, max-age=N` where N is the seconds until the next build
(5–60), so a cache never holds a copy past the point a newer one exists; plus
`ETag`/`304`, `Vary: Origin, Accept-Encoding`, gzip.

`/api/network` → `{generatedAt, realtime:{available, feedUpdatedAt, positionsUpdatedAt},
summary:{running, withRealtime, onTimePercent, avgDelayMin, maxDelay}, boards:{sofia,plovdiv:{name,
trains,fetchedAt}}}`. `/api/network/radar` → `{generatedAt, realtime, count, trains:[{type, trainNum,
from, to, fromId, toId, delayMin, progress, lat, lon}]}`.

Honesty rules (pinned by `test/network.test.js`): `realtime.available` is false when
the trip feed is stale, and then `onTimePercent`, `avgDelayMin`, `maxDelay` are `null`
(`withRealtime` 0) — never estimated; the figures count only trains that have a
TripUpdate delay; "on time" = under 5 min late; early arrivals count as 0 in the
average; `maxDelay` is `null` when nobody is late; `running` is the saved schedule's
answer (first departure → last arrival, overnight runs included, replacement buses
excluded) plus trains the realtime feeds themselves put on the road; `lat`/`lon` are
measured fixes (`null` without one), `progress` is the measured position along the
route (`null` if it cannot be placed, never schedule-projected), `delayMin` is `null`
when unknown. A board whose scrape has been failing for over 15 minutes is
`trains: null`, not stale departures.

A quiet `RT_HISTORY=on` job accumulates observed delays for future statistics.

---

## Live Activity push updates

The iOS app shows a Live Activity for the journey in progress. While the app is
suspended or terminated it can't refresh that card itself, so the server pushes
updates over APNs. Behind `LIVE_ACTIVITY=on`; needs `REALTIME=on` for data.

The worker ticks every 30s, reads the realtime cache the poller already maintains
(**it adds no polling of its own**), and pushes only when something a passenger
would notice changed — phase, next stop, or delay crossing a 2-minute threshold
in either direction. `apns-priority` is 5 by default; 10 only for phase changes
and threshold/large-jump delay changes (priority 10 spends the activity's update
budget faster and Apple throttles it).

### Three rules that fail SILENTLY

If any is wrong, APNs returns `200`, the device drops the update, and nothing is
logged. Covered by unit tests for exactly that reason.

1. **Dates are seconds since the 2001 reference date**, sent as JSON *numbers*:
   `swiftSeconds = unixSeconds - 978307200`. Not ISO, not Unix epoch.
2. **Every non-optional Swift property is present on every push** — the
   synthesized decoder throws on a missing key, discarding the whole update.
3. **Unknown optionals are omitted, never sent as `null`.**

### APNs setup

Apple Developer portal, once: create an **APNs Auth Key** (`.p8`, downloadable
only once), note the **Key ID** and **Team ID**, confirm the bundle id has the
**Push Notifications** capability and `NSSupportsLiveActivities` in `Info.plist`.

On the server, keep the key outside the repo (`*.p8` and `secrets/` are
gitignored — a leaked key must be revoked in the portal, it doesn't expire):

```bash
install -d -m 700 /root/secrets
install -m 600 AuthKey_XXXXXXXXXX.p8 /root/secrets/
```

Then set `APNS_KEY_P8` (path), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`,
`APNS_DEFAULT_ENV` and `LIVE_ACTIVITY=on` (see `.env.example`), and
`pm2 restart bultrain --update-env`.

**Sandbox vs production:** a token from one host is rejected by the other
(`400 BadDeviceToken`). Xcode builds are `sandbox`; TestFlight / App Store are
`production`. The app declares its own environment when it registers, so one
server pushes to both at once.

### Endpoints & testing

```
POST /api/live-activity/register     20/min per client
POST /api/live-activity/unregister   idempotent
POST /api/live-activity/test-push    404 unless ENABLE_LIVE_ACTIVITY_TEST_PUSH=on
GET  /api/live-activity/metrics
```

Register / unregister are pure DB work — a bad key or an Apple outage never stops
a device from registering or trap it in an activity. Set
`ENABLE_LIVE_ACTIVITY_TEST_PUSH=on` to push a hand-written content-state at a
device while wiring up. Tokens are masked in every log line.

---

## Articles — the author portal

Author-written **"travel ideas"** (day trips by train) that the app pulls from
the server. Built on the same tables as the guide (`handbook_topics` +
`handbook_content`), with `category = 'travel_idea'`, so the app renders them with
the block engine it already has.

### Content model — blocks

An article is a title + cover + metadata + an ordered list of **blocks**. Each
block is one of six types: `heading · paragraph · image · quote · tip · route`.
This is deliberate over free-form HTML — the app renders blocks natively and
identically on iOS/Android, and the author styles by choosing block types, not
raw markup. Metadata (`region`, `season`, `duration_min`, `related_train`,
`featured`, `language`) powers filters and a "see this train" deep link.

### Editor

In the admin panel under **Идеи за пътуване**: a list plus a full editor with a
block builder (add / reorder / delete), cover and per-block image upload, the
metadata fields, a **live app-style preview**, and save-draft / publish /
unpublish / preview-link. Images upload to `POST /api/admin/media` (author or
admin) and are stored in `guide/images/` (served at `/guide/images/`); the
server generates the filename from the MIME type, so nothing client-controlled
reaches disk. JPEG/PNG/WebP, 6 MB max.

### Admin CRUD (author or admin)

```
GET/POST      /api/admin/articles                list / create (draft)
GET/PUT/DELETE /api/admin/articles/:id           read (with blocks) / update / delete
POST          /api/admin/articles/:id/publish    ·/unpublish
POST          /api/admin/articles/:id/preview-token   short-lived token for app preview
```

### App-facing (published only)

```
GET /api/articles?category=travel_idea&limit=&offset=
GET /api/articles/:id
```

Read-only, behind `verifyMobileClient`. The detail uses the guide's envelope
(`{ title, subtitle, image, content:[{ type, text, image? }] }`) with `type` per
block and metadata on top. A **draft** is 404 to the app unless a valid
`?preview=<token>` (minted by the author) is supplied — so an unpublished idea
can be viewed in the real app before publishing.

---

## Admin panel & accounts

The React panel (`admin-ui/`, served at `/admin`) is JWT-cookie protected. Two
roles:

- **admin** — everything (trains, schedules, guide, exceptions, articles). Logs
  in with the main `ADMIN_PASSWORD` (username left blank), or as a table account.
- **author** — only the articles section. Logs in with a username + password.

Accounts live in the `users` table (passwords hashed with the built-in
`crypto.scrypt`). Create one on the server:

```bash
node scripts/create-user.js <username> author   # prompts for a hidden password
```

Roles are enforced by `middleware/verifyRole(...roles)`; `verifyAdmin` is
`verifyRole('admin')`. A legacy token with no role counts as admin, so existing
sessions keep working. `GET /api/admin/me` reports the caller's role (used by the
panel to scope its UI without hitting an admin-only endpoint).

> **Rotating the mobile API keys:** `IOS_API_KEY` / `ANDROID_API_KEY` accept a
> comma-separated list, so a new key can run alongside the old one. **Keep the old
> key until old app versions retire** — dropping it 401s every un-updated install.

---

## Configuration

All via `.env` (see `.env.example` for the full annotated list). Highlights:

| var | purpose |
|---|---|
| `PORT` | Express port (nginx proxies to it) |
| `IOS_API_KEY` / `ANDROID_API_KEY` / `SCREEN_API_KEY` | client keys (comma-separated lists) |
| `ADMIN_PASSWORD` / `JWT_SECRET` | admin bootstrap login + cookie signing |
| `SCHEDULE_SOURCE` | `gtfs` (date-based) or `legacy` |
| `REALTIME` / `RT_HISTORY` / `LIVE_ACTIVITY` | background-job flags |
| `APNS_*` | Live Activity push credentials |

---

## Deployment

Releases are a plain `git pull` on the server, then a migration if the schema
changed, then a pm2 restart if code changed:

```bash
bash /root/bultrain-app/scripts/backup.sh                 # snapshot the DB first
git -C /root/bultrain-app pull origin main
node /root/bultrain-app/database/migrate.js /root/bultrain-app/bultrain.sqlite
pm2 restart bultrain --update-env
```

- `--update-env` is **not optional** — without it pm2 reuses the old environment.
  If a value still looks stale after a restart, pm2 has cached it: `pm2 delete
  bultrain && pm2 start server.js --name bultrain && pm2 save`.
- The migration runner is idempotent (applied migrations are skipped); a
  schema-only change needs no restart, a code change does.
- **The admin panel** ships as committed `admin-ui/dist` (no secrets — the same
  bundle already served publicly). After changing `admin-ui/src`, rebuild and
  commit it: `cd admin-ui && npm run build`, then commit `admin-ui/dist`.

---

## Testing & CI

`npm test` runs `scripts/ci-check.sh`, six fast, fixture-free checks: the native
module loads (the thing the Node 24 upgrade once broke), every source file parses,
migrations apply from empty, `station-aliases.json` is valid, every route module
loads, and the unit tests (`node --test test/*.test.js`). The same script runs in
GitHub Actions on every push.

Tests favour the surfaces where a mistake is **invisible** — the 2001-epoch date
conversion, the realtime feed-merge and delay-zero handling, GPS progress
geometry, the article/auth logic. They run against throwaway databases via
`BULTRAIN_DB`, so they need no fixtures and never touch dev data.

---

## Operations

- **Backups:** `scripts/backup.sh` (daily via systemd timer) gzips the DB and
  rotates old copies. Set `BULTRAIN_BACKUP_REMOTE` to push them off the box.
- **Migrations:** forward-only `.sql` files in `database/migrations/`, each in a
  transaction, recorded in `schema_version`. Additive and idempotent-friendly.
- **Logs:** `pm2 logs bultrain`; subsystem lines are prefixed (`[rt]`, `[la]`).
- **The realtime cache is memory-only** — a restart clears it; the poller refills
  it within a tick. Nothing is lost.
