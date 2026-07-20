-- 006_delay_history.sql
--
-- Quiet, cheap accumulation of observed delays for future statistics
-- ("at YOUR station this train is usually N min late on Fridays"). NOT a
-- recording of every poll — exactly ONE row per (train, station, service date),
-- carrying the last observed delay before the train passed that stop. The
-- poller buffers the running value in memory and flushes here periodically, so
-- writes stay bounded (~a couple thousand rows a day).
--
-- Delay is per STOP, deliberately: a train can be on time at an early station
-- and late at the terminus; only per-stop history can tell the truth for the
-- station a given passenger actually uses.

CREATE TABLE IF NOT EXISTS delay_history (
    train_number  TEXT    NOT NULL,
    station_id    INTEGER NOT NULL REFERENCES stations(id),
    date          TEXT    NOT NULL,   -- YYYY-MM-DD service date
    delay_seconds INTEGER NOT NULL,   -- observed arrival delay (departure at origin)
    PRIMARY KEY (train_number, station_id, date)
);

-- Fast "history for this train at this station" lookups for the stats query.
CREATE INDEX IF NOT EXISTS idx_delay_history_lookup ON delay_history(train_number, station_id);
