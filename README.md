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
