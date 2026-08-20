-- 011_last_progress.sql
--
-- Remember the progress fraction we last pushed, so the change-detection
-- predicate can treat "the bar moved visibly" as a reason to push.
--
-- Without this, a train between two distant stops produced no push at all: the
-- phase is unchanged, the delay is unchanged and the next stop is unchanged, so
-- the bar sat still for the whole leg even though the train was moving. The
-- alternative — a fixed timer — would push just as often for a train standing at
-- a platform, which is exactly what the design set out to avoid.
--
-- NULL means "never pushed with a known progress", which the predicate reads as
-- "no basis for comparison" rather than "zero".

ALTER TABLE live_activity_tokens ADD COLUMN last_progress REAL;
