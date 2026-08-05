-- Lybi HQ — core tables (see docs/guides/LYBI_HQ.md §4)
-- Idempotent: safe to re-run.

-- A connected thing we pull from. One row per Notion database, uploaded file,
-- pasted link, Drive folder, etc.
CREATE TABLE IF NOT EXISTS hq_sources (
  id            SERIAL PRIMARY KEY,
  kind          VARCHAR(32)  NOT NULL,                 -- notion | upload | url | text | drive | meet
  label         VARCHAR(500) NOT NULL,
  config        JSONB        NOT NULL DEFAULT '{}',    -- { notionId, notionType, url, ... }
  sync_mode     VARCHAR(16)  NOT NULL DEFAULT 'once',  -- once | watch
  last_sync_at  TIMESTAMP,
  last_status   VARCHAR(32)  NOT NULL DEFAULT 'pending', -- pending | syncing | ok | failed
  last_error    TEXT,
  atom_count    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- The one normalised row for everything HQ knows.
CREATE TABLE IF NOT EXISTS hq_atoms (
  id            SERIAL PRIMARY KEY,
  kind          VARCHAR(32)  NOT NULL DEFAULT 'doc',   -- meeting | doc | note | transcript | page
  title         VARCHAR(1000) NOT NULL,
  body          TEXT,                                  -- normalised markdown — what we chunk
  summary       TEXT,

  source_id     INTEGER REFERENCES hq_sources(id) ON DELETE SET NULL,
  external_id   VARCHAR(255),                          -- notion page id / file id
  external_url  TEXT,                                  -- deep link back, shown in citations
  content_hash  VARCHAR(64),                           -- drift + dedup

  authors       JSONB NOT NULL DEFAULT '[]',
  participants  JSONB NOT NULL DEFAULT '[]',
  projects      JSONB NOT NULL DEFAULT '[]',
  entities      JSONB NOT NULL DEFAULT '[]',

  -- Scribe output. Kept on the meeting atom for the MVP (editable in place);
  -- promoting each decision to its own atom is a later refinement.
  decisions     JSONB NOT NULL DEFAULT '[]',
  actions       JSONB NOT NULL DEFAULT '[]',
  questions     JSONB NOT NULL DEFAULT '[]',
  scribe_status VARCHAR(32) NOT NULL DEFAULT 'none',   -- none | running | done | failed

  occurred_at   TIMESTAMP,                             -- when it HAPPENED (≠ ingested_at)
  ingested_at   TIMESTAMP NOT NULL DEFAULT NOW(),

  visibility    VARCHAR(16) NOT NULL DEFAULT 'company', -- company | client  (§9 backstop)
  status        VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | indexed | failed | superseded
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,

  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One external thing = one atom. Lets re-sync be idempotent (upsert on conflict).
CREATE UNIQUE INDEX IF NOT EXISTS hq_atoms_external_uniq
  ON hq_atoms (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS hq_atoms_kind_idx       ON hq_atoms (kind);
CREATE INDEX IF NOT EXISTS hq_atoms_occurred_idx   ON hq_atoms (occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS hq_atoms_source_idx     ON hq_atoms (source_id);
CREATE INDEX IF NOT EXISTS hq_atoms_status_idx     ON hq_atoms (status);

-- atom ↔ atom relations (mentions / supersedes / derived_from / decided_in)
CREATE TABLE IF NOT EXISTS hq_links (
  id         SERIAL PRIMARY KEY,
  from_atom  INTEGER NOT NULL REFERENCES hq_atoms(id) ON DELETE CASCADE,
  to_atom    INTEGER NOT NULL REFERENCES hq_atoms(id) ON DELETE CASCADE,
  rel        VARCHAR(32) NOT NULL DEFAULT 'mentions',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS hq_links_uniq ON hq_links (from_atom, to_atom, rel);
