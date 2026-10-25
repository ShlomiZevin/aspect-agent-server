-- Error center (task #903, step 1): one row per error that happened while an
-- agent handled a conversation — a failed turn first; add-ons, model calls,
-- offline add-ons, triggers and simulations join in later steps.
--
-- Repeats of the same problem share a `fingerprint` and are grouped at read
-- time (count, first seen, last seen). Rows older than a month are pruned by
-- the recording service itself (builder/services/errorCenter.js).
--
-- Nothing secret is stored: `message` is scrubbed of keys and capped, and
-- `detail` holds technical facts (error code, HTTP status, a short stack) —
-- never prompts. The add-on run / message ids link to where the full story is.
CREATE TABLE IF NOT EXISTS error_events (
  id               SERIAL PRIMARY KEY,
  agent_slug       VARCHAR(100),               -- null = not tied to one agent (server catch-all)
  conversation_id  INTEGER,
  message_id       INTEGER,                    -- the assistant message of the failed turn, when known
  addon_run_id     VARCHAR(64),                -- later steps: the add-on run that failed
  source           VARCHAR(20),                -- builder | customer | simulation | null
  area             VARCHAR(40)  NOT NULL,      -- turn | addon | model | offline | trigger | profiler | live-brain | simulation | server
  kind             VARCHAR(40)  NOT NULL,      -- model_rate_limit | model_timeout | model_refusal | model_bad_answer | model_other | database | code | external | server_unavailable | user_input
  code             VARCHAR(60),                -- e.g. runtime_failed
  message          TEXT         NOT NULL,
  detail           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  fingerprint      VARCHAR(40)  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_events_agent_time_idx ON error_events (agent_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS error_events_fingerprint_idx ON error_events (agent_slug, fingerprint);
CREATE INDEX IF NOT EXISTS error_events_created_idx ON error_events (created_at);
