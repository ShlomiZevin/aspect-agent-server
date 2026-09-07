-- Migration 048: record WHO started a trigger run.
--
-- `match_reason` was doing two jobs. It carries the arithmetic — "quiet
-- for 5 minutes" — and it had also become the marker for "a person
-- pressed this", because the single-trigger Run wrote the literal string
-- "run by hand from the builder" into it and the UI decided the question
-- by prefix-matching that string.
--
-- Two consequences, both real. The agent-wide Run wanted to keep the
-- genuine reason, so it could not set the marker, and every run it
-- started was reported as the clock's work. And the whole distinction
-- rested on a display sentence: rename it and the labels silently go
-- wrong, with nothing failing.
--
-- One nullable column instead. `match_reason` goes back to meaning only
-- "why it matched", and "who started it" becomes a fact you can filter
-- and count rather than a string to sniff. Existing rows have no source
-- and are treated as the clock's, which is what they almost all are —
-- so there is nothing to backfill.

ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS source text;

-- The admin feed's likeliest question: "show me what a person set off."
CREATE INDEX IF NOT EXISTS idx_trigger_events_source
  ON trigger_events (agent_id, source, matched_at DESC);
