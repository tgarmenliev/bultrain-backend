-- 008_fix_station_names.sql
--
-- Targeted station fixes, confirmed by the user. These edits mirror the same
-- changes made in stations.json, which is the source of truth for coordinates
-- (the daily refresh's reconcile-coords.js re-applies stations.json coords onto
-- this table). This migration makes the DB correct IMMEDIATELY rather than
-- waiting for the next refresh — and it is the ONLY thing that fixes
-- english_name, which no refresh step syncs.
--
--   * id 133 "Варна - Спирка" and id 31 "Перник Разпределит." had each inherited
--     the coordinates of the big station beside them (Варна id 4 / Перник id 7).
--     Corrected to their own locations. Names are intentionally left untouched.
--   * id 515 "Дебели Лаг" had a Cyrillic "г" ending its english_name; the rest
--     of the row is unchanged.
--
-- UPDATE-by-id is idempotent and safe: a no-op if the row is missing, and it
-- sets the correct value regardless of what is currently stored.

UPDATE stations SET lat = 43.209106, lon = 27.886526 WHERE id = 133;
UPDATE stations SET lat = 42.604833, lon = 23.061442 WHERE id = 31;
UPDATE stations SET english_name = 'Debeli Lag'       WHERE id = 515;
