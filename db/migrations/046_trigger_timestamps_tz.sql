-- Migration 046: make every timestamp the trigger engine compares
-- against timezone-aware.
--
-- ── The bug this fixes ─────────────────────────────────────────────
--
-- Migrations 044 and 045 declared their columns as `timestamp` (no time
-- zone), matching the older tables around them. That is fine while the
-- values only ever move between SQL expressions. It is NOT fine the
-- moment a JavaScript Date is compared against one, which is exactly
-- what a trigger sweep does on every tick.
--
-- The database runs in UTC; the Node process runs in Israel time (+03).
-- A naive column therefore holds UTC wall-clock, while node-postgres
-- serialises a JS Date to LOCAL wall-clock with an offset that
-- Postgres then discards when the target type is `timestamp`. The two
-- sides end up three hours apart, in opposite directions on read and
-- write. Measured on this database:
--
--   SELECT now()::timestamp > $1::timestamp   with $1 = one hour ago
--   → false
--
-- "One hour ago is not in the past." Every clause the Silence trigger
-- evaluates is a comparison of exactly that shape, so the symptom was a
-- trigger that matched nobody, ever, with no error anywhere — the
-- failure mode that is hardest to notice and worst to ship.
--
-- `timestamptz` round-trips through node-postgres exactly (verified: 0
-- minutes skew, and both the past and future comparisons correct), so
-- the columns the engine reads become timezone-aware.
--
-- ── What is NOT converted ──────────────────────────────────────────
--
-- `messages.created_at` and every other pre-existing naive column stay
-- as they are. Converting them would touch the whole platform for one
-- feature's benefit. Instead, the two places the trigger engine reads
-- `messages.created_at` wrap it explicitly as `AT TIME ZONE 'UTC'`,
-- which is correct because those naive values ARE UTC wall-clock.
--
-- The existing values need no shifting: they were written by `now()`
-- under a UTC database, so reinterpreting them as UTC is exactly right.
-- `USING col AT TIME ZONE 'UTC'` states that explicitly rather than
-- leaning on the session's TimeZone setting being UTC at migration
-- time.

ALTER TABLE conversations
  ALTER COLUMN last_message_at      TYPE timestamptz USING last_message_at      AT TIME ZONE 'UTC',
  ALTER COLUMN last_user_message_at TYPE timestamptz USING last_user_message_at AT TIME ZONE 'UTC';

ALTER TABLE trigger_events
  ALTER COLUMN matched_at TYPE timestamptz USING matched_at AT TIME ZONE 'UTC',
  ALTER COLUMN started_at TYPE timestamptz USING started_at AT TIME ZONE 'UTC',
  ALTER COLUMN ended_at   TYPE timestamptz USING ended_at   AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';

ALTER TABLE trigger_status
  ALTER COLUMN last_evaluated_at TYPE timestamptz USING last_evaluated_at AT TIME ZONE 'UTC',
  ALTER COLUMN last_fired_at     TYPE timestamptz USING last_fired_at     AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at        TYPE timestamptz USING updated_at        AT TIME ZONE 'UTC';

-- The stamping trigger now writes into timestamptz columns while
-- `NEW.created_at` is still naive. The cast is spelled out rather than
-- left to the session's TimeZone: a session connected with a non-UTC
-- TimeZone would otherwise silently offset every stamp it wrote, which
-- is the same class of bug this migration exists to remove.
CREATE OR REPLACE FUNCTION conversations_touch_activity() RETURNS trigger AS $$
DECLARE
  stamp timestamptz := NEW.created_at AT TIME ZONE 'UTC';
BEGIN
  UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, stamp), stamp),
         last_user_message_at = CASE
           WHEN NEW.role = 'user'
             THEN GREATEST(COALESCE(last_user_message_at, stamp), stamp)
           ELSE last_user_message_at
         END
   WHERE id = NEW.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
