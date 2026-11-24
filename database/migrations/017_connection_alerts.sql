-- 017_connection_alerts.sql
--
-- The connection between two legs gets its own alert (see armedLogic.evaluateConnectionRisk):
-- "tight", "you will probably miss it", "it holds again". What was said is remembered on the
-- ARRIVING leg's row, so it is not repeated and a worse state is told once. Like the Android
-- reminders, it survives /arm re-arming a leg whose times are unchanged (see armedStore.arm).

ALTER TABLE armed_journeys ADD COLUMN conn_band        TEXT;                      -- last band told: fine | tight | departsBeforeArrival
ALTER TABLE armed_journeys ADD COLUMN conn_alert_at    TEXT;                      -- ISO UTC of the last connection alert
ALTER TABLE armed_journeys ADD COLUMN conn_alerts_sent INTEGER NOT NULL DEFAULT 0;
