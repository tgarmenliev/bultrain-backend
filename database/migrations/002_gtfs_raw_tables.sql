-- 002_gtfs_raw_tables.sql
--
-- Raw staging tables — a faithful 1:1 mirror of the GTFS static feed. The
-- importer truncates and reloads these inside a transaction on each feed
-- refresh. Nothing here touches the serving tables (stations, trains,
-- schedules); the crosswalk and materialisation happen in later steps, behind
-- the diff-report gate. Values are stored close to the CSV: TEXT by default,
-- with the numeric columns we actually compute on typed.

CREATE TABLE IF NOT EXISTS gtfs_agency (
    agency_id       TEXT,
    agency_name     TEXT,
    agency_url      TEXT,
    agency_timezone TEXT,
    agency_lang     TEXT,
    agency_phone    TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id             TEXT PRIMARY KEY,
    stop_code           TEXT,
    stop_name           TEXT,
    stop_desc           TEXT,
    stop_lat            REAL,
    stop_lon            REAL,
    zone_id             TEXT,
    stop_url            TEXT,
    location_type       TEXT,
    parent_station      TEXT,
    stop_timezone       TEXT,
    wheelchair_boarding  TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_routes (
    route_id         TEXT PRIMARY KEY,
    agency_id        TEXT,
    route_short_name TEXT,
    route_long_name  TEXT,
    route_desc       TEXT,
    route_type       TEXT,
    route_url        TEXT,
    route_color      TEXT,
    route_text_color TEXT,
    route_sort_order TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
    route_id             TEXT,
    service_id           TEXT,
    trip_id              TEXT PRIMARY KEY,
    trip_headsign        TEXT,
    trip_short_name      TEXT,   -- the train number
    direction_id         TEXT,
    block_id             TEXT,
    shape_id             TEXT,
    wheelchair_accessible TEXT,
    bikes_allowed        TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
    trip_id            TEXT NOT NULL,
    arrival_time       TEXT,   -- HH:MM:SS, may exceed 24:00:00
    departure_time     TEXT,
    stop_id            TEXT NOT NULL,
    stop_sequence      INTEGER NOT NULL,
    stop_headsign      TEXT,
    pickup_type        TEXT,
    drop_off_type      TEXT,
    shape_dist_traveled TEXT,
    timepoint          TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
    service_id     TEXT NOT NULL,
    date           TEXT NOT NULL,   -- YYYYMMDD
    exception_type INTEGER NOT NULL -- 1 = service added, 2 = removed
);

CREATE TABLE IF NOT EXISTS gtfs_shapes (
    shape_id            TEXT NOT NULL,
    shape_pt_lat        REAL,
    shape_pt_lon        REAL,
    shape_pt_sequence   INTEGER NOT NULL,
    shape_dist_traveled TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_feed_info (
    feed_publisher_name TEXT,
    feed_publisher_url  TEXT,
    feed_lang           TEXT,
    feed_start_date     TEXT,
    feed_end_date       TEXT,
    feed_version        TEXT,
    feed_contact_url    TEXT
);

-- Which feed is currently loaded in the raw tables (one row per import).
CREATE TABLE IF NOT EXISTS gtfs_import (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id      TEXT,      -- NAP file-record id used for the download
    filename     TEXT,
    checksum     TEXT,      -- sha256 of the downloaded zip
    feed_version TEXT,
    feed_start   TEXT,
    feed_end     TEXT,
    imported_at  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'ok'
);

-- Indexes for the joins the crosswalk, diff and (later) materialisation do.
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_trip ON gtfs_stop_times(trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times(stop_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_service   ON gtfs_trips(service_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_shortname ON gtfs_trips(trip_short_name);
CREATE INDEX IF NOT EXISTS idx_gtfs_caldates_service ON gtfs_calendar_dates(service_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_caldates_date    ON gtfs_calendar_dates(date);
CREATE INDEX IF NOT EXISTS idx_gtfs_shapes_shape     ON gtfs_shapes(shape_id, shape_pt_sequence);
