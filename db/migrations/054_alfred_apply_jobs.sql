-- 054_alfred_apply_jobs — Alfred Apply as a tracked job.
--
-- Apply used to be one blocking POST: the browser held a connection for
-- 30-90s while each target was generated, which produced "Failed to fetch"
-- when the connection dropped and left no record that the work had in fact
-- succeeded server-side. The job row is both the polling target AND the
-- forensic log — `steps` carries one entry per target with its duration,
-- token counts and stop_reason, which is the only way to tell a normal
-- finish from a cap-truncated one.
--
-- Strictly additive. Platform DB.

CREATE TABLE IF NOT EXISTS alfred_apply_jobs (
  id             VARCHAR(64)  PRIMARY KEY,
  chat_id        INTEGER      NOT NULL,
  agent_slug     VARCHAR(100),
  owner_user_id  VARCHAR(64),

  -- running | done | failed | cancelled
  status         VARCHAR(20)  NOT NULL,

  -- What was asked. Kept verbatim: reconstructing "what was she trying to
  -- do" from a failed apply is otherwise impossible weeks later.
  description    TEXT,
  reason         TEXT,
  targets        JSONB        NOT NULL,
  -- The client's visible working copies at the moment Apply was pressed.
  -- Load-bearing: the POST returns immediately now, so generation must run
  -- against this snapshot rather than whatever is on screen later.
  working_bodies JSONB,

  -- One entry per target x phase: { target, phase, status, durationMs,
  -- model, inputTokens, outputTokens, stopReason, error }.
  steps          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Which Cloud Run instance ran it (max-instances 3) — the handle for
  -- correlating against Cloud Run logs.
  instance_id    VARCHAR(64),

  -- Outcome. `result` matches the old synchronous response body exactly.
  result         JSONB,
  error          TEXT,
  failed_target  JSONB,

  started_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMP,
  duration_ms    INTEGER,
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  -- Doubles as the heartbeat: a `running` row whose updated_at has gone
  -- stale belongs to an instance that died mid-apply.
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alfred_apply_jobs_chat_idx
  ON alfred_apply_jobs (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS alfred_apply_jobs_stale_idx
  ON alfred_apply_jobs (status, updated_at);
