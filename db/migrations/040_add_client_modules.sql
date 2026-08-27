-- Aspect Modules framework — platform-DB state.
-- See tasks/pending/aspect-modules.md section 02.
--
-- THREE tables, all in the PLATFORM DB (agents_platform_db), never in a
-- dataset schema. That is guardrail #1 of the plan and the reason these are
-- here at all: dataset schemas (zolstock, zer4u, ...) are dropped and
-- rebuilt behind an atomic swap on every import, so anything a user typed
-- there would silently vanish on the next reload. The generated views a
-- module builds DO live in the dataset schema — they are disposable and are
-- re-rendered from `binding` on every reload. The binding and the settings
-- are the durable state, and they live here.

-- ── client_modules — one row per (dataset, module) ───────────────────────
--
-- Two INDEPENDENT switches, and the distinction is load-bearing:
--   * `status`  is owned by the init pipeline (not_initialized -> initializing
--     -> ready | failed, and degraded when a nightly build fails)
--   * `enabled` is the human on/off button
-- A module's surfaces (client screen, chat tool, manifest fragment) activate
-- ONLY when `enabled AND status = 'ready'`. A module can legitimately be
-- ready-but-off, or on-but-not-yet-initialized.
--
-- The status CHECK is deliberate: this column gates whether generated
-- recommendations reach a client, so a typo'd value must fail loudly at
-- write time rather than silently parking the module in a state that
-- `= 'ready'` never matches. Cost accepted: adding a sixth status later
-- needs a migration.

CREATE TABLE IF NOT EXISTS client_modules (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  status         TEXT NOT NULL DEFAULT 'not_initialized',
  settings       JSONB NOT NULL DEFAULT '{}',
  binding        JSONB,
  init_model     TEXT,
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, module_id),
  CONSTRAINT client_modules_status_known CHECK (
    status IN ('not_initialized', 'initializing', 'ready', 'failed', 'degraded')
  )
);

CREATE INDEX IF NOT EXISTS idx_client_modules_dataset ON client_modules (dataset_id);

-- Partial index for the hot runtime question asked on every request that
-- might surface a module: "which modules are actually live for this
-- dataset". Everything else is admin-path and rare.
CREATE INDEX IF NOT EXISTS idx_client_modules_live
  ON client_modules (dataset_id, module_id)
  WHERE enabled = true AND status = 'ready';

-- ── module_runs — one row per init / nightly / verify run ────────────────
--
-- `progress_stage` is what the admin tab's progress bar reads. It is polled,
-- never animated against a guessed duration — the insights-jobs lesson: a
-- bar animated to a hardcoded 8s froze at 96% because real runs take
-- 30-100s. `rounds` holds the per-round verification results so a FAILED run
-- can tell the reviewer which probe failed, with which numbers, every round
-- (plan section 03).

CREATE TABLE IF NOT EXISTS module_runs (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  progress_stage TEXT,
  rounds         JSONB,
  report         JSONB,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT module_runs_kind_known   CHECK (kind IN ('init', 'nightly', 'verify')),
  CONSTRAINT module_runs_status_known CHECK (status IN ('running', 'succeeded', 'failed'))
);

-- "Show me this module's last run" is the admin tab's default read.
CREATE INDEX IF NOT EXISTS idx_module_runs_latest
  ON module_runs (dataset_id, module_id, started_at DESC);

-- Finding a stuck run (a worker died mid-init) without scanning history.
CREATE INDEX IF NOT EXISTS idx_module_runs_running
  ON module_runs (dataset_id, module_id)
  WHERE status = 'running';

-- ── module_outbox — mocked notification delivery ─────────────────────────
--
-- Decision D5: the notification INTERFACE is real (settings, events,
-- provider contract) but delivery is mocked — the default 'outbox' provider
-- writes here instead of sending, and the admin tab renders these rows in
-- the run report. Swapping in a real email provider later is a provider
-- change, not a rebuild.
--
-- `provider` records WHICH provider handled the entry, so that once a real
-- one exists the mocked backlog is still distinguishable from genuinely
-- delivered mail. `run_id` links an entry to the run that emitted it so the
-- run report can show its own notifications; it is intentionally NOT a
-- foreign key — outbox history should outlive run pruning rather than
-- cascade away with it.

CREATE TABLE IF NOT EXISTS module_outbox (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  run_id         BIGINT,
  event          TEXT NOT NULL,
  recipients     JSONB NOT NULL DEFAULT '[]',
  payload        JSONB NOT NULL DEFAULT '{}',
  provider       TEXT NOT NULL DEFAULT 'outbox',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_outbox_dataset
  ON module_outbox (dataset_id, module_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_module_outbox_run ON module_outbox (run_id);
