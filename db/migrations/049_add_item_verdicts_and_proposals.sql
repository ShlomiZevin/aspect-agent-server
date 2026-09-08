-- Procurement Groups + Smart Tune (spec: "Procurement Groups", sections 3.2/3.4).
-- Platform DB. STRICTLY ADDITIVE: three new tables, nothing existing altered.
--
-- replenishment_item_verdicts — the buyer's group assignments. Platform DB so
-- they survive every dataset-schema swap (same rule as supplier_settings).
-- assigned_group NULL is not stored: a row EXISTS only while a buyer override
-- is in force; deleting the row is how an item goes back to following the
-- computed suggestion.
CREATE TABLE IF NOT EXISTS replenishment_item_verdicts (
  id                    BIGSERIAL PRIMARY KEY,
  dataset_id            TEXT        NOT NULL,
  sku                   TEXT        NOT NULL,
  assigned_group        TEXT        NOT NULL
    CHECK (assigned_group IN ('order_now', 'suspicious', 'out_of_season', 'fading', 'new')),
  suggested_at_verdict  TEXT,
  note                  TEXT,
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_item_verdicts_dataset
  ON replenishment_item_verdicts (dataset_id);

-- module_chat_proposals — Smart Tune's previewed change sets. Framework-level
-- (any module scope can use it). The SKU snapshot is what execution acts on:
-- the buyer confirms the set they SAW (decision D5).
CREATE TABLE IF NOT EXISTS module_chat_proposals (
  id              BIGSERIAL PRIMARY KEY,
  dataset_id      TEXT        NOT NULL,
  module_id       TEXT        NOT NULL,
  scope_id        TEXT        NOT NULL,
  filter          JSONB       NOT NULL,
  interpreted     TEXT        NOT NULL,
  target          JSONB       NOT NULL,
  sku_snapshot    JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'executed', 'expired', 'cancelled')),
  conversation_id TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_proposals_dataset
  ON module_chat_proposals (dataset_id, module_id, status);

-- module_bulk_operations — the executed changes, with the prior per-SKU state
-- recorded so every bulk operation is one-click revertible (decision D5).
-- proposal_id is NOT a foreign key: operation history should outlive proposal
-- pruning rather than cascade away with it (same reasoning as module_outbox).
CREATE TABLE IF NOT EXISTS module_bulk_operations (
  id           BIGSERIAL PRIMARY KEY,
  proposal_id  BIGINT,
  dataset_id   TEXT        NOT NULL,
  module_id    TEXT        NOT NULL,
  prior_state  JSONB       NOT NULL,
  applied      INTEGER     NOT NULL DEFAULT 0,
  skipped      INTEGER     NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'executed'
    CHECK (status IN ('executed', 'reverted')),
  executed_by  TEXT,
  executed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bulk_operations_dataset
  ON module_bulk_operations (dataset_id, module_id);
