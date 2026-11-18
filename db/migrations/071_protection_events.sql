-- Data protection blocks (task #986). One row = one customer message that
-- was stopped because a code detector found sensitive personal data in it
-- (Israeli ID, credit card, IBAN, …) — in the browser before sending
-- (side 'client') or on the server for any channel (side 'server').
--
-- NEVER the sensitive value, a hash of it, or any text of the message:
-- only which detectors fired, where and when. (A hash of a 9-digit ID is
-- brute-forced in seconds, so it is no protection.)
--
-- "Blocked by mistake" (the customer's one tap) stamps
-- `mistake_reported_at` on the same row — the per-agent report shows the
-- blocks and the mistake rate so the detectors can be tuned.
--
-- `agent_slug`, like error_events: the MCP and Admin read by slug.
-- `conversation_id` is NULL for a block in the browser before the first
-- message created a conversation. `surface` = 'live' (customer chat /
-- embed), 'builder' (Builder test chat), 'simulation', 'api' (anything
-- else that posts messages).
--
-- Safe to run twice: IF NOT EXISTS everywhere.
CREATE TABLE IF NOT EXISTS protection_events (
  id                   SERIAL PRIMARY KEY,
  agent_slug           VARCHAR(100) NOT NULL,
  conversation_id      INTEGER,
  side                 VARCHAR(10)  NOT NULL,
  surface              VARCHAR(20)  NOT NULL,
  detectors            TEXT[]       NOT NULL,
  lang                 VARCHAR(5),
  mistake_reported_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT protection_events_side_ok    CHECK (side IN ('client', 'server')),
  CONSTRAINT protection_events_surface_ok CHECK (surface IN ('live', 'builder', 'simulation', 'api')),
  CONSTRAINT protection_events_detectors_ok CHECK (cardinality(detectors) > 0)
);

CREATE INDEX IF NOT EXISTS protection_events_agent_time_idx
  ON protection_events (agent_slug, created_at);
CREATE INDEX IF NOT EXISTS protection_events_conversation_idx
  ON protection_events (conversation_id) WHERE conversation_id IS NOT NULL;
