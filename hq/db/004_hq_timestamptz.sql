-- HQ — make every timestamp carry its time zone.
--
-- THE BUG: these columns were `timestamp WITHOUT time zone` and the database
-- session runs in UTC, so `NOW()` stored UTC wall-clock with no zone attached.
-- node-postgres then reads a naive timestamp and builds a JS Date in the
-- SERVER PROCESS's local zone (UTC+3 here). Same digits, different instant —
-- so a run started seconds ago came back to the UI as "3 hours ago", and a
-- brand-new sync looked like an old entry that had been there all along.
--
-- It was never only cosmetic. `watermark_at` is compared against Notion's
-- `last_edited_time` to decide what to re-read; three hours adrift meant every
-- refresh re-fetched a window it had already covered.
--
-- The stored values ARE UTC (that is what the session wrote), so
-- `AT TIME ZONE 'UTC'` reinterprets them correctly rather than shifting them.
-- Written out one statement per column because the migration runner splits on
-- `;` and would tear a DO $$ … $$ block in half. Each ALTER is a no-op if the
-- column is already timestamptz.

ALTER TABLE hq_atoms      ALTER COLUMN occurred_at      TYPE timestamptz USING occurred_at      AT TIME ZONE 'UTC';
ALTER TABLE hq_atoms      ALTER COLUMN ingested_at      TYPE timestamptz USING ingested_at      AT TIME ZONE 'UTC';
ALTER TABLE hq_atoms      ALTER COLUMN created_at       TYPE timestamptz USING created_at       AT TIME ZONE 'UTC';
ALTER TABLE hq_atoms      ALTER COLUMN updated_at       TYPE timestamptz USING updated_at       AT TIME ZONE 'UTC';

ALTER TABLE hq_links      ALTER COLUMN created_at       TYPE timestamptz USING created_at       AT TIME ZONE 'UTC';

ALTER TABLE hq_sources    ALTER COLUMN last_sync_at     TYPE timestamptz USING last_sync_at     AT TIME ZONE 'UTC';
ALTER TABLE hq_sources    ALTER COLUMN created_at       TYPE timestamptz USING created_at       AT TIME ZONE 'UTC';
ALTER TABLE hq_sources    ALTER COLUMN updated_at       TYPE timestamptz USING updated_at       AT TIME ZONE 'UTC';
ALTER TABLE hq_sources    ALTER COLUMN watermark_at     TYPE timestamptz USING watermark_at     AT TIME ZONE 'UTC';
ALTER TABLE hq_sources    ALTER COLUMN last_discover_at TYPE timestamptz USING last_discover_at AT TIME ZONE 'UTC';

ALTER TABLE hq_sync_items ALTER COLUMN remote_edited_at TYPE timestamptz USING remote_edited_at AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_items ALTER COLUMN synced_edited_at TYPE timestamptz USING synced_edited_at AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_items ALTER COLUMN synced_at        TYPE timestamptz USING synced_at        AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_items ALTER COLUMN created_at       TYPE timestamptz USING created_at       AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_items ALTER COLUMN updated_at       TYPE timestamptz USING updated_at       AT TIME ZONE 'UTC';

ALTER TABLE hq_sync_runs  ALTER COLUMN started_at       TYPE timestamptz USING started_at       AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_runs  ALTER COLUMN finished_at      TYPE timestamptz USING finished_at      AT TIME ZONE 'UTC';
ALTER TABLE hq_sync_runs  ALTER COLUMN updated_at       TYPE timestamptz USING updated_at       AT TIME ZONE 'UTC';
