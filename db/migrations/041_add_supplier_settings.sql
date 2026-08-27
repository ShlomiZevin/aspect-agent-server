-- Per-supplier replenishment settings — owned by the Smart Replenishment
-- module, stored in the PLATFORM DB.
--
-- WHY IT IS HERE AND NOT IN THE DATASET SCHEMA: this is the one thing in the
-- whole feature that a human types. Dataset schemas (zolstock, zer4u, …) are
-- dropped and rebuilt behind an atomic swap on every import, so a lead time
-- entered by a buyer would silently vanish on the next reload — and nobody
-- would notice until the recommendations quietly went back to the 90-day
-- default. C3's verification is exactly this: set a lead time, run a full
-- reload, confirm it survived.
--
-- Namespaced by dataset_id like every other module table, so one platform DB
-- serves every client without the rows ever meeting.

CREATE TABLE IF NOT EXISTS supplier_settings (
  id              BIGSERIAL PRIMARY KEY,
  dataset_id      TEXT        NOT NULL,
  -- The supplier as the DATA names it. mv_suppliers builds its list from the
  -- catalogue, so this key is whatever that view reports — never a name a
  -- human typed, which would drift the moment the client renames anything.
  supplier_key    TEXT        NOT NULL,
  supplier_label  TEXT,
  -- All nullable ON PURPOSE: a NULL means "not set for this supplier", which
  -- resolves to the dataset default and is REPORTED as inherited. A zero or a
  -- copied-down default would be indistinguishable from a real choice, and
  -- the buyer must always be able to tell a number they gave us from one we
  -- assumed.
  lead_time_days  INTEGER,
  review_days     INTEGER,
  safety_days     INTEGER,
  min_order_units INTEGER,
  notes           TEXT,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, supplier_key),
  CONSTRAINT supplier_settings_sane CHECK (
    (lead_time_days  IS NULL OR lead_time_days  BETWEEN 0 AND 3650) AND
    (review_days     IS NULL OR review_days     BETWEEN 0 AND 3650) AND
    (safety_days     IS NULL OR safety_days     BETWEEN 0 AND 3650) AND
    (min_order_units IS NULL OR min_order_units >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_settings_dataset ON supplier_settings (dataset_id);
