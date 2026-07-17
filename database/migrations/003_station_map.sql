-- 003_station_map.sql
--
-- Crosswalk from GTFS stop_id to our existing station.id. Many-to-one: several
-- GTFS stops (platforms/points) can map to one of our stations. Populated by
-- services/gtfs/build-crosswalk.js from name + coordinate matching.
--
-- station_id is NULLABLE: the ~5 genuinely new stops (border/freight/resort)
-- have no counterpart yet and are flagged for a decision at materialisation.
-- We NEVER renumber station.id — users have saved alarms/favourites keyed to it.

CREATE TABLE IF NOT EXISTS station_map (
    gtfs_stop_id   TEXT PRIMARY KEY,
    station_id     INTEGER REFERENCES stations(id),
    gtfs_stop_name TEXT,
    station_name   TEXT,
    method         TEXT,     -- 'name+coord' | 'name' | 'coord' | 'none'
    confidence     TEXT,     -- 'high' | 'medium' | 'none'
    coord_dist_km  REAL,
    reviewed       INTEGER NOT NULL DEFAULT 0  -- 1 once a human confirms it
);

CREATE INDEX IF NOT EXISTS idx_station_map_station ON station_map(station_id);
CREATE INDEX IF NOT EXISTS idx_station_map_conf    ON station_map(confidence);
