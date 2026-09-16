-- Otto → Intelligence integration: custom screens as a first-class product
-- surface (tasks/pending/otto-intelligence-integration.md §03).
--
-- All three tables live in the PLATFORM DB (agents_platform_db), never a
-- dataset schema — dataset schemas are dropped and rebuilt behind an atomic
-- swap on every import, and anything a user built there would silently
-- vanish. The plan + spec are the durable source of truth; rendered data is
-- a cache and is not stored here at all.

-- One row per client-built screen. Replaces the v1 provider_config blob
-- (`otto_apps_<dataset>` keys), which held demo-data screens in the obsolete
-- generated-HTML format and is discarded, not migrated (task §12 Q3).
CREATE TABLE IF NOT EXISTS custom_modules (
  id           TEXT PRIMARY KEY,                  -- 'cm-<random>'
  dataset_id   TEXT NOT NULL,                     -- client scoping: visible only inside its client
  title        JSONB NOT NULL,                    -- {en, he} — every generated label is bilingual
  summary      JSONB,                             -- {en, he}
  icon         TEXT,
  plan         JSONB NOT NULL,                    -- SOURCE of truth: the approved structured plan
  screen_spec  JSONB,                             -- ARTIFACT: validated block spec; null until first build
  conversation JSONB NOT NULL DEFAULT '[]',       -- chat transcript, so drafts reopen mid-thought
  -- draft: being talked into existence; ready: built, reviewable, still a draft tile;
  -- active: published to Apps; archived: soft-removed published app.
  -- CHECKed because status gates what a client sees — a typo must fail at
  -- write time, not park a screen in a state no query matches.
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'ready', 'active', 'archived')),
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_modules_dataset_idx
  ON custom_modules (dataset_id);

-- Build runs for one screen — the polled job the builder page and the global
-- nav pill read (the module_runs / insights-jobs pattern: progress is stored
-- as a stage string and the percentage is computed, monotonic by
-- construction; never animated against a guessed duration).
CREATE TABLE IF NOT EXISTS custom_module_builds (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  screen_id      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'succeeded', 'failed')),
  -- reading_plan | querying_data | composing_screen | validating_totals
  progress_stage TEXT,
  report         JSONB,                           -- per-stage log + probe results
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS custom_module_builds_screen_idx
  ON custom_module_builds (dataset_id, screen_id, started_at DESC);

-- One running build per screen at a time — enforced by the index, not by a
-- check-then-insert (the module_runs race lesson, migration 045).
CREATE UNIQUE INDEX IF NOT EXISTS custom_module_builds_one_running
  ON custom_module_builds (dataset_id, screen_id)
  WHERE status = 'running';

-- Generic document store for data users will type INTO custom screens
-- (notes, statuses, adjustments — shapes we cannot predict). Ships now so
-- the first editable-column request is an API call away, not a migration
-- away; no v1 block writes to it yet. The server enforces the
-- (dataset, module) scope on every call — one client's screen physically
-- cannot touch another's rows.
CREATE TABLE IF NOT EXISTS custom_module_data (
  dataset_id  TEXT NOT NULL,
  module_id   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, module_id, collection, doc_id)
);
