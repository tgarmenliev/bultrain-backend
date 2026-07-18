-- 005_new_stations.sql
--
-- Stations present in the GTFS feed but missing from our list, confirmed by the
-- user. New non-colliding ids (existing max was 1003); ids are frozen from here
-- on, like every other station id. Coordinates come from the GTFS feed.
--
-- Тракия (Шумен) is the important one: we had a single "Тракия" (id 110, the
-- Plovdiv station), but BDZ also runs a "Тракия (Шумен)" ~217km away in the
-- north-east. Both GTFS stops were collapsing onto id 110, which corrupted
-- routing. This gives the Шумen station its own id; the alias file points GTFS
-- stop 240358 at it.
--
-- NOTE for the app: these stations must also be added to the app's bundled
-- station list (for the alarm) in a client update.

INSERT OR IGNORE INTO stations (id, name, english_name, lat, lon) VALUES
    (1004, 'Тракия (Шумен)',   'Trakiya (Shumen)', 43.27862467, 26.95867508),
    (1005, 'Цариброд',         'Tsaribrod',        43.011129,   22.764883),
    (1006, 'Капитан Андреево', 'Kapitan Andreevo', 41.716669,   26.321096);
