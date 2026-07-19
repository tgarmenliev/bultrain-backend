-- 005_new_stations.sql
--
-- Stations present in the GTFS feed but genuinely missing from our list,
-- confirmed by the user. New non-colliding ids (existing max was 1003); ids are
-- frozen from here on, like every other station id. Coordinates from GTFS.
--
-- NOTE: Тракия (Шумен) is NOT added here — it already existed as id 352. The
-- Plovdiv Тракия (110) and the Шумен Тракия (352) were both collapsing onto 110
-- because GTFS names both stops just "Тракия"; the alias file now points GTFS
-- stop 240358 at the existing 352. (An earlier version wrongly added a duplicate
-- id 1004 for it — removed.)
--
-- NOTE for the app: these stations must also be added to the app's bundled
-- station list (for the alarm) in a client update.

INSERT OR IGNORE INTO stations (id, name, english_name, lat, lon) VALUES
    (1005, 'Цариброд',         'Tsaribrod',        43.011129, 22.764883),
    (1006, 'Капитан Андреево', 'Kapitan Andreevo', 41.716669, 26.321096);
