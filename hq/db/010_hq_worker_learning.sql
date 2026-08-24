-- What a worker has learned, and a hard ceiling on what it can spend learning it.
--
-- TWO THINGS, deliberately together, because one is dangerous without the other:
--
--   A worker that can SEE its own output can judge it and try again. That is
--   what turns "generate and hope" into craft. It is also exactly the loop that
--   can burn money unattended — judge, retry, judge, retry — so the cap and the
--   capability ship in the same migration.

-- Craft notes. Not HQ knowledge (that is shared, searchable, about the company);
-- this is a worker's own accumulated skill, injected into its prompt, so it is
-- better next week than it is today.
CREATE TABLE IF NOT EXISTS hq_worker_lessons (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES hq_workers(id) ON DELETE CASCADE,
  lesson TEXT NOT NULL,
  -- What prompted it, so a bad lesson can be traced and removed.
  learned_from VARCHAR(300),
  -- Someone can switch off a lesson that turns out to be wrong without
  -- losing the record that it was ever believed.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hq_worker_lessons_active
  ON hq_worker_lessons (worker_id, active, created_at DESC);

-- The ceiling. Counted per job so no single request can run away, whatever
-- the worker decides mid-loop.
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
