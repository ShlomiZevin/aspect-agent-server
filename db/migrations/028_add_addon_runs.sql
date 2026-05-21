-- Migration: Add addon_runs table (Builder V2 — P2)
-- Description: One row per addon execution. run_data JSONB stores
--              the same payload shape as the SSE `addon.output`
--              event so the historical view rehydrates identically.

CREATE TABLE IF NOT EXISTS addon_runs (
  id               VARCHAR(64) PRIMARY KEY,
  conversation_id  INTEGER NOT NULL,
  message_id       INTEGER,
  instance_id      VARCHAR(64) NOT NULL,
  plugin_id        VARCHAR(100) NOT NULL,
  status           VARCHAR(20) NOT NULL,
  started_at       TIMESTAMP NOT NULL,
  ended_at         TIMESTAMP,
  duration_ms      INTEGER,
  run_data         JSONB NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS addon_runs_conversation_idx
  ON addon_runs (conversation_id);

CREATE INDEX IF NOT EXISTS addon_runs_message_idx
  ON addon_runs (message_id);
