-- 004_date_based_serving.sql
--
-- The date-based serving model that replaces the day-of-week tables
-- (train_validity + schedules + schedule_exceptions). Mirrors GTFS: a train
-- number resolves to one or more trips active on a given date, each trip
-- carrying its own category — so a single number can be a train leg plus a
-- replacement-bus leg (route "A" = Автобус), presented as one journey.
--
-- The old tables are left in place; serving cuts over behind a flag only after
-- shadow comparison. Materialised by services/gtfs/materialize.js.

CREATE TABLE IF NOT EXISTS trip (
    trip_id       TEXT PRIMARY KEY,   -- GTFS trip_id
    train_number  TEXT NOT NULL,      -- GTFS trip_short_name
    category      TEXT NOT NULL,      -- our category: ПВ/БВ/КПВ/МБВ/АВТ (bus)
    service_start TEXT,               -- YYYY-MM-DD (informational)
    service_end   TEXT
);

CREATE TABLE IF NOT EXISTS trip_date (
    trip_id TEXT NOT NULL REFERENCES trip(trip_id) ON DELETE CASCADE,
    date    TEXT NOT NULL             -- YYYY-MM-DD the trip runs
);

CREATE TABLE IF NOT EXISTS trip_stop (
    trip_id    TEXT NOT NULL REFERENCES trip(trip_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    station_id INTEGER REFERENCES stations(id),  -- NULL only if stop unmapped
    arrive     TEXT,                  -- HH:MM (24h; after-midnight wrapped)
    depart     TEXT
);

CREATE INDEX IF NOT EXISTS idx_trip_train      ON trip(train_number);
CREATE INDEX IF NOT EXISTS idx_trip_date_date  ON trip_date(date);
CREATE INDEX IF NOT EXISTS idx_trip_date_trip  ON trip_date(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_stop_trip  ON trip_stop(trip_id, seq);
CREATE INDEX IF NOT EXISTS idx_trip_stop_stn   ON trip_stop(station_id);
