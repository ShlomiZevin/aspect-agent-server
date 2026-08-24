-- HQ — workers ("employees"), their chats, their long jobs, and what they make.
--
-- Deliberately GENERIC. Marketing is the first worker, not a special case: a
-- worker is a row, its behaviour is a prompt, its abilities are a list of tool
-- names. Adding a second employee is an INSERT, not a code change.

-- ─── The employee ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hq_workers (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,        -- url segment, stable
  name VARCHAR(120) NOT NULL,              -- "Maya"
  role_title VARCHAR(160) NOT NULL,        -- "Marketing"
  tagline VARCHAR(300),                    -- one line for the team card
  avatar VARCHAR(16),                      -- emoji, until we have real portraits
  accent VARCHAR(16),                      -- brand-ish colour for their card

  -- The employment definition. A plain system prompt, editable by anyone —
  -- this IS the job description, so it must never be buried in code.
  role_definition TEXT NOT NULL DEFAULT '',

  model VARCHAR(64) NOT NULL DEFAULT 'claude-sonnet-4-6',
  -- Which tools this employee may use. Names only; the runtime resolves them.
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Free-form knobs a worker cares about (default image model, brand palette…).
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,

  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Talking to them ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hq_worker_conversations (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES hq_workers(id) ON DELETE CASCADE,
  title VARCHAR(300) NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hq_worker_convs_recent
  ON hq_worker_conversations (worker_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS hq_worker_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES hq_worker_conversations(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,               -- user | assistant
  content TEXT NOT NULL DEFAULT '',
  -- Tool calls, cost, model — anything worth keeping but not worth a column.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hq_worker_messages_conv
  ON hq_worker_messages (conversation_id, created_at);

-- ─── Long work ──────────────────────────────────────────────────────────────
-- A job is what makes an employee feel like an employee rather than a chatbot:
-- it writes down a plan you can see, then works through it while you go away.
-- Same shape as hq_sync_runs (which already proved detached + cancellable +
-- survives a reload), but the unit of progress is a step it decided on.
CREATE TABLE IF NOT EXISTS hq_jobs (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES hq_workers(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES hq_worker_conversations(id) ON DELETE SET NULL,
  title VARCHAR(300) NOT NULL,
  brief TEXT,                              -- what was actually asked for
  -- running | done | cancelled | failed | awaiting_approval
  status VARCHAR(24) NOT NULL DEFAULT 'running',
  -- [{ n, title, status, detail, startedAt, finishedAt }]
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_step INTEGER,
  error TEXT,
  -- Money actually spent, accumulated as tools report it.
  cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  -- What the worker estimated before starting, so a spend can be approved.
  estimated_usd NUMERIC(10,4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hq_jobs_recent ON hq_jobs (worker_id, started_at DESC);
CREATE INDEX IF NOT EXISTS hq_jobs_conv ON hq_jobs (conversation_id);

-- ─── What they make ─────────────────────────────────────────────────────────
-- Folders are optional and manual. The DEFAULT view groups by conversation,
-- because "the images from the chat where we did the launch" is how people
-- actually look for things; folders are for when you want to impose an order.
CREATE TABLE IF NOT EXISTS hq_media_folders (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  parent_id INTEGER REFERENCES hq_media_folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hq_media (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER REFERENCES hq_workers(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES hq_worker_conversations(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES hq_jobs(id) ON DELETE SET NULL,
  folder_id INTEGER REFERENCES hq_media_folders(id) ON DELETE SET NULL,

  kind VARCHAR(24) NOT NULL DEFAULT 'image',   -- image | render | doc
  title VARCHAR(300),
  -- Where the bytes live. GCS is the store; url is what the browser loads.
  gcs_path TEXT,
  url TEXT,
  mime_type VARCHAR(120),
  width INTEGER,
  height INTEGER,
  bytes INTEGER,

  -- How it was made — so any image can be re-generated or tweaked later.
  prompt TEXT,
  model VARCHAR(64),
  cost_usd NUMERIC(10,4),
  source VARCHAR(32),                          -- leonardo | html_render | upload
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hq_media_conv ON hq_media (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_media_folder ON hq_media (folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_media_job ON hq_media (job_id);
