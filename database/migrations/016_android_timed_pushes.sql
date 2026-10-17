-- 016_android_timed_pushes.sql
--
-- Android's own exact alarms are held back by the phone (Doze/vendor battery managers) and
-- run 15-18 minutes late, while FCM high-priority pushes arrive within seconds. The two
-- moments that matter most are therefore pushed from here:
--
--   * departure_reminder   at (scheduled departure - 30 min)  — "time to set off"
--   * start_tracking again at (arrival - 40 min)              — the approach to the stop
--
-- Each must go out once (the approach again only if the arrival moves by more than 10 min), so
-- what was sent is remembered per leg. /arm re-arms a leg on every app start; the bookkeeping
-- survives that as long as the leg's times are unchanged (see armedStore.arm).

ALTER TABLE armed_journeys ADD COLUMN reminder_sent_at     TEXT;     -- ISO UTC, departure_reminder
ALTER TABLE armed_journeys ADD COLUMN approach_sent_at     TEXT;     -- ISO UTC, last approach start_tracking
ALTER TABLE armed_journeys ADD COLUMN approach_arrival     INTEGER;  -- unix s of the arrival that push was based on
ALTER TABLE armed_journeys ADD COLUMN approach_count       INTEGER NOT NULL DEFAULT 0;
