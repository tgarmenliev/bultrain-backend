-- 010_armed_journeys.sql
--
-- Server-driven journey tracking: starting the Live Activity without the phone
-- being awake (push-to-start), delay alerts before the card exists, and the
-- automatic silent stop for a journey that was armed but never actually taken.
--
-- Three token kinds are now in play and they are NOT interchangeable:
--   * the Live Activity UPDATE token  — live_activity_tokens (migration 007),
--     issued per activity, only after the card already exists;
--   * the PUSH-TO-START token         — per app install, exists before any
--     journey, used to create a card from nothing;
--   * the plain APNs ALERT token      — per app install, for ordinary
--     notifications (the delay alert), which is not a Live Activity push at all.
--
-- The last two are stored here, keyed by a stable install id rather than by the
-- token itself, because tokens rotate: an armed journey references the INSTALL,
-- and the current token for the right kind is looked up at send time.

-- ── Device tokens, per install ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
    token       TEXT PRIMARY KEY,
    install_id  TEXT NOT NULL,               -- stable per app install
    kind        TEXT NOT NULL,               -- 'push_to_start' | 'alert'
    environment TEXT NOT NULL,               -- 'sandbox' | 'production'
    created_at  TEXT,
    updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_install ON device_tokens(install_id, kind);

-- ── Armed journeys ───────────────────────────────────────────────────────────
-- One row per leg the user asked us to watch. Carries everything needed to build
-- the content-state for the start push, so no client round-trip is required when
-- the moment comes.
CREATE TABLE IF NOT EXISTS armed_journeys (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id               TEXT    NOT NULL,
    journey_id               TEXT    NOT NULL,
    leg_index                INTEGER NOT NULL DEFAULT 0,

    train_number             TEXT    NOT NULL,
    boarding_station         TEXT    NOT NULL,
    destination_station      TEXT    NOT NULL,
    direction_station        TEXT,
    scheduled_departure      TEXT    NOT NULL,   -- ISO-8601 UTC
    scheduled_arrival        TEXT    NOT NULL,
    is_current_bus           INTEGER NOT NULL DEFAULT 0,
    next_transport_number    TEXT,
    next_transport_departure TEXT,
    is_next_transport_bus    INTEGER NOT NULL DEFAULT 0,

    -- Lifecycle: armed → started (card pushed) → arrived (client geofence)
    --            or → stopped (deadline passed / user disarmed / start refused)
    state          TEXT NOT NULL DEFAULT 'armed',
    started_at     TEXT,
    arrived_at     TEXT,
    stopped_at     TEXT,
    stopped_reason TEXT,

    -- Task 2 bookkeeping: what delay we last told the user about.
    last_delay_min  INTEGER,
    last_alert_at   TEXT,
    alerts_sent     INTEGER NOT NULL DEFAULT 0,

    -- Scheduler hint; the tick selects rows whose moment has come.
    next_action_at TEXT,

    created_at TEXT,
    updated_at TEXT
);

-- One armed row per leg of a journey per install; re-arming updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_armed_unique
    ON armed_journeys(install_id, journey_id, leg_index);
CREATE INDEX IF NOT EXISTS idx_armed_state_action ON armed_journeys(state, next_action_at);
CREATE INDEX IF NOT EXISTS idx_armed_train        ON armed_journeys(train_number);

-- ── Push-to-start budget guard ───────────────────────────────────────────────
-- Apple enforces a fixed on-device push-to-start budget (~10 in a short window,
-- not increasable, not covered by NSSupportsLiveActivitiesFrequentUpdates) and
-- does not publish the window. Exceeding it makes the device silently ignore
-- starts for up to 24 hours, with APNs still returning 200 — invisible to us.
--
-- So we keep our own, deliberately stricter counter per install and refuse to
-- send beyond it. A runaway bug then costs one missing card instead of a device
-- that cannot start cards until tomorrow.
CREATE TABLE IF NOT EXISTS push_start_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id TEXT NOT NULL,
    sent_at    TEXT NOT NULL,
    journey_id TEXT,
    outcome    TEXT             -- 'ok' | 'refused-budget' | apns error class
);

CREATE INDEX IF NOT EXISTS idx_push_start_log_install ON push_start_log(install_id, sent_at);
