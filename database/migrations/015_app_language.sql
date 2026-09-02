-- 015_app_language.sql
--
-- Real incident: delay-alert push text is composed server-side (armedLogic.js
-- alertText()) entirely in Bulgarian, with no way for the client to say what
-- language it's in — an English-language app + English Live Activity card
-- still got a Bulgarian delay notification, because /arm and /register never
-- had anywhere to carry that.
--
-- The client already has this exact value: JourneyAttributes.appLanguage was
-- defined for the widget extension (a separate process that can't see the
-- host app's per-app language override) but was never actually sent to the
-- server — armedWatcher.js's own comment admits it: "appLanguage is optional
-- — omitted rather than guessed." Now it isn't guessed anymore.
--
-- Nullable, no backfill: NULL means "not told" and is treated as Bulgarian
-- everywhere, which is exactly today's behaviour for every existing row.

ALTER TABLE armed_journeys       ADD COLUMN app_language TEXT;
ALTER TABLE live_activity_tokens ADD COLUMN app_language TEXT;
