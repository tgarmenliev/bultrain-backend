-- 014_token_train_display.sql
--
-- The Live Activity content-state now carries per-LEG fields, because the
-- attributes are immutable and describe the whole journey: on a trip with a
-- transfer the card showed the first train and the final station the whole way.
--
-- One of those fields is the transport number in display form ("БВ 8611"), and
-- the update-token rows had nowhere to keep it — armed_journeys gained the same
-- column in migration 012, but a card registered through /register did not.
--
-- Nullable: when the client sends no display form the server composes one from
-- the train's GTFS category instead, and falls back to the bare number.

ALTER TABLE live_activity_tokens ADD COLUMN train_number_display TEXT;
