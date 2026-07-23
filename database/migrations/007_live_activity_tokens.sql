-- 007_live_activity_tokens.sql
--
-- Push tokens for iOS Live Activities, so the server can keep a journey card
-- current over APNs while the app is suspended or terminated.
--
-- SQLite notes (the spec was written against Postgres):
--   * timestamptz  → TEXT holding ISO-8601 in UTC ("2026-07-23T13:44:00.000Z").
--     Normalising to UTC on write keeps plain string comparison correct, which
--     is what the worker and the cleanup job rely on.
--   * boolean      → INTEGER 0/1, the SQLite convention better-sqlite3 expects.
--
-- One row per push token. A single activity may produce several tokens over its
-- life (iOS rotates them) and a multi-leg journey re-registers with fresh
-- context at each transfer, so writes are upserts keyed on the token.

CREATE TABLE IF NOT EXISTS live_activity_tokens (
    token                     TEXT PRIMARY KEY,       -- 64 hex chars
    environment               TEXT NOT NULL,          -- 'sandbox' | 'production'
    journey_id                TEXT,
    train_number              TEXT NOT NULL,          -- bare numeric, e.g. "8611"
    boarding_station          TEXT NOT NULL,          -- Bulgarian name
    destination_station       TEXT NOT NULL,          -- Bulgarian name
    direction_station         TEXT,                   -- the train's own terminus
    scheduled_departure       TEXT NOT NULL,          -- ISO-8601 UTC
    scheduled_arrival         TEXT NOT NULL,          -- ISO-8601 UTC
    current_leg_index         INTEGER NOT NULL DEFAULT 0,
    is_current_bus            INTEGER NOT NULL DEFAULT 0,
    next_transport_number     TEXT,
    next_transport_departure  TEXT,                   -- ISO-8601 UTC
    is_next_transport_bus     INTEGER NOT NULL DEFAULT 0,

    -- Change-detection bookkeeping, written after each successful push.
    last_pushed_at            TEXT,                   -- ISO-8601 UTC
    last_delay_min            INTEGER,
    last_next_stop            TEXT,
    last_content_hash         TEXT,
    last_phase                TEXT,

    created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The worker groups work by train; the cleanup job scans by arrival time.
CREATE INDEX IF NOT EXISTS idx_la_tokens_train   ON live_activity_tokens(train_number);
CREATE INDEX IF NOT EXISTS idx_la_tokens_arrival ON live_activity_tokens(scheduled_arrival);
-- Enforcing the per-journey token cap needs a lookup by journey.
CREATE INDEX IF NOT EXISTS idx_la_tokens_journey ON live_activity_tokens(journey_id);
