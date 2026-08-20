-- 012_train_number_display.sql
--
-- Two different train numbers, for two different jobs.
--
-- train_number stays the BARE number ("3637") because that is what the
-- GTFS-Realtime feed is matched on — decorating it would break every lookup.
--
-- train_number_display carries the form a passenger reads ("БВ 3637", "ПВ
-- 30114", "АВТ 30111") and is what goes into the Live Activity attributes, so
-- the card names the train the way the rest of the app does.
--
-- Nullable: an older client that does not send it falls back to the bare
-- number, which is worse-looking but still correct.

ALTER TABLE armed_journeys ADD COLUMN train_number_display TEXT;
