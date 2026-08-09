-- Postgres-backed storage for generated Aspect Intelligence insights.
-- Replaces insights/data/generated-insights.json, a local file that lived in
-- the deploy build context and got baked into every Docker image (see
-- .dockerignore fix, same commit) — every deploy was silently resetting
-- live production insights back to whatever stale snapshot happened to be
-- on the deploying machine's disk. One row per insight in the main platform
-- DB, keyed by (dataset_id, user_id, insight_id). The full insight object is
-- stored as one JSONB blob (`data`) — investigation.service.js already
-- treats an insight as one atomic JS object everywhere, so this keeps that
-- shape intact. `tracked`, `tracked_order`, and `created_at` are ALSO
-- promoted to real columns purely so listing/sorting/filtering doesn't need
-- to parse every row's JSONB in JS.

CREATE TABLE IF NOT EXISTS intelligence_insights (
  id BIGSERIAL PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  insight_id TEXT NOT NULL,
  data JSONB NOT NULL,
  tracked BOOLEAN NOT NULL DEFAULT FALSE,
  tracked_order BIGINT,
  created_at BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, user_id, insight_id)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_insights_dataset_user ON intelligence_insights (dataset_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_insights_dataset ON intelligence_insights (dataset_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_insights_dataset_tracked ON intelligence_insights (dataset_id, tracked) WHERE tracked = true;
