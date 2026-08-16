-- Lybi HQ — integration sync tracking.
-- Idempotent: safe to re-run.

-- One row per discovered remote object (a Notion page, later a Drive file).
-- Discovery is deliberately separate from syncing: listing is fast and free,
-- fetching content is slow and rate-limited, so we inventory first and let a
-- human choose what actually comes in.
CREATE TABLE IF NOT EXISTS hq_sync_items (
  id             SERIAL PRIMARY KEY,
  source_id      INTEGER NOT NULL REFERENCES hq_sources(id) ON DELETE CASCADE,

  external_id    VARCHAR(255) NOT NULL,          -- notion page id
  title          VARCHAR(1000) NOT NULL DEFAULT '',
  url            TEXT,
  parent_title   VARCHAR(500),                   -- where it lives, for grouping
  object_type    VARCHAR(32) NOT NULL DEFAULT 'page',  -- page | database_row

  remote_edited_at TIMESTAMP,                    -- Notion's last_edited_time
  synced_edited_at TIMESTAMP,                    -- what we had when we last synced

  -- pending  : discovered, never synced
  -- selected : ticked for the next run
  -- syncing  : in flight right now
  -- done     : synced, content unchanged since
  -- stale    : synced, but the remote changed since
  -- skipped  : deliberately excluded
  -- failed   : last attempt errored
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',

  atom_id        INTEGER REFERENCES hq_atoms(id) ON DELETE SET NULL,
  chars          INTEGER,
  chunks         INTEGER,
  error          TEXT,
  synced_at      TIMESTAMP,

  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS hq_sync_items_uniq
  ON hq_sync_items (source_id, external_id);
CREATE INDEX IF NOT EXISTS hq_sync_items_status_idx ON hq_sync_items (source_id, status);

-- One row per sync run, so a screen can show what happened and a restart can
-- tell "still going" from "died halfway".
CREATE TABLE IF NOT EXISTS hq_sync_runs (
  id          SERIAL PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES hq_sources(id) ON DELETE CASCADE,
  kind        VARCHAR(16) NOT NULL DEFAULT 'sync',   -- discover | sync
  status      VARCHAR(16) NOT NULL DEFAULT 'running',-- running | done | cancelled | failed
  total       INTEGER NOT NULL DEFAULT 0,
  processed   INTEGER NOT NULL DEFAULT 0,
  succeeded   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  current_title VARCHAR(500),
  error       TEXT,
  started_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hq_sync_runs_source_idx ON hq_sync_runs (source_id, started_at DESC);

-- The default kind an integration assigns to what it pulls in (meeting/doc/note).
ALTER TABLE hq_sources ADD COLUMN IF NOT EXISTS default_kind VARCHAR(32) NOT NULL DEFAULT 'doc';
