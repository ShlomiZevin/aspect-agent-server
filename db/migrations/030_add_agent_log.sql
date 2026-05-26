-- Migration: agent_log table
-- Description: Journal of body mutations (Alfred applies + manual
--              "Validate & Log" entries). Each row captures who/what/
--              when/why for one entity body change (agent or crew).
--
-- See BUILDER_V2_ALFRED.md (decisions 41 + 56). Rows are append-only;
-- diffs are computed at read time from body_before vs body_after.
--
-- apply_group_id groups multiple rows from a single Apply that
-- touched several bodies (e.g. agent + crew). Null for solo entries.

-- what_changed: free-text description of WHAT changed. For Alfred
-- applies this is the consolidator's plan; for manual logs it's the
-- user's claim about what they edited (after LLM diff validation).
--
-- entity_name: snapshot of the entity's name at log time so the row
-- reads on its own — names can be renamed later, and joining to the
-- live row would show the wrong name historically.

CREATE TABLE IF NOT EXISTS agent_log (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  agent_name      VARCHAR(200) NOT NULL,
  actor           VARCHAR(20) NOT NULL,
  reason          TEXT NOT NULL,
  what_changed    TEXT NOT NULL DEFAULT '',
  body_before     JSONB NOT NULL,
  body_after      JSONB NOT NULL,
  entity          VARCHAR(20) NOT NULL,
  entity_id       VARCHAR(64) NOT NULL,
  entity_name     VARCHAR(200) NOT NULL DEFAULT '',
  source_chat_id  INTEGER,
  source_msg_id   INTEGER,
  apply_group_id  VARCHAR(64),
  applied_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_by      VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_log_agent_id_idx
  ON agent_log (agent_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS agent_log_apply_group_idx
  ON agent_log (apply_group_id);
