-- HQ — runs you can walk away from, and refreshes that only fetch what moved.
--
-- Two problems this fixes:
--   1. A run existed only as an open HTTP stream. Close the tab and you lost all
--      sight of it, even though the loop kept going server-side.
--   2. Every "refresh" re-listed the entire workspace — 823 objects, ~800 writes
--      — regardless of whether anything had changed since last time.

-- Who started it and how, so a manual pick and a nightly job read differently
-- in the same list.
ALTER TABLE hq_sync_runs ADD COLUMN IF NOT EXISTS trigger VARCHAR(16) NOT NULL DEFAULT 'manual';
-- What was asked for, kept so a finished run still explains itself.
ALTER TABLE hq_sync_runs ADD COLUMN IF NOT EXISTS item_ids INTEGER[];
ALTER TABLE hq_sync_runs ADD COLUMN IF NOT EXISTS label VARCHAR(200);

CREATE INDEX IF NOT EXISTS hq_sync_runs_recent ON hq_sync_runs (source_id, started_at DESC);

-- The watermark. Notion's search can sort by last_edited_time, so once we know
-- the newest edit we saw, a later pass can stop paginating the moment it walks
-- past that timestamp instead of reading every page every time.
ALTER TABLE hq_sources ADD COLUMN IF NOT EXISTS watermark_at TIMESTAMP;
ALTER TABLE hq_sources ADD COLUMN IF NOT EXISTS last_discover_at TIMESTAMP;

-- Filtering "what changed last week" is a date range over this column, so it
-- needs to be cheap on 800+ rows.
CREATE INDEX IF NOT EXISTS hq_sync_items_edited ON hq_sync_items (source_id, remote_edited_at DESC);
CREATE INDEX IF NOT EXISTS hq_sync_items_status ON hq_sync_items (source_id, status);
