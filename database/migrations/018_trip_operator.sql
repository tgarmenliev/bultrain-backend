-- 018_trip_operator.sql
--
-- Who runs a trip. From 2026-12-13 a second passenger operator, "Ивкони Експрес", runs part of
-- the network next to БДЖ (the feed has both in one dataset: agency_id BDZ / IVKONI). The same train
-- NUMBER can change hands on that date, so this is a property of the TRIP, which is date-bound.
--
-- Filled by materialize.js from the route's agency_id; NULL when the feed does not say (and nothing
-- is then claimed about the operator).

ALTER TABLE trip ADD COLUMN operator TEXT;   -- the feed's agency_id: 'BDZ', 'IVKONI', …
