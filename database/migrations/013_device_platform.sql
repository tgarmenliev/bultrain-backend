-- 013_device_platform.sql
--
-- Android parity for server-driven journey tracking. The watcher's brain
-- (armedLogic.js — when to trigger, when a delay is worth an alert, when to
-- stop an abandoned journey) is platform-agnostic already; only the delivery
-- layer differs, so all this needs is a way to tell the two apart.
--
-- Every existing row is an iOS registration, hence the default: no backfill,
-- and the iOS path keeps behaving exactly as before.
--
-- `environment` ('sandbox'|'production') is an APNs concept — which of Apple's
-- two hosts a token belongs to. FCM has no equivalent split, so Android rows
-- carry 'n/a'. The column stays NOT NULL rather than being relaxed, because
-- every iOS row genuinely needs it and a nullable column invites forgetting it.

ALTER TABLE device_tokens ADD COLUMN platform TEXT NOT NULL DEFAULT 'ios';

CREATE INDEX IF NOT EXISTS idx_device_tokens_platform ON device_tokens(install_id, platform);
