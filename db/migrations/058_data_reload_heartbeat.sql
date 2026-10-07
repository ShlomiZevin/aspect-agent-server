-- Worker heartbeat for data reload runs.
--
-- A reload runs as background work inside a Cloud Run instance, and Cloud Run
-- can shut that instance down at any time (scale-in, min-instance recycle).
-- When it does, the run row stays 'running' with nobody behind it, and the
-- only thing that ever noticed was the 5h stale sweep — so a thestock index
-- run that died 20 minutes in blocked every other schema for 5 hours, then
-- retried, most nights of 2026-10.
--
-- The running instance now stamps heartbeat_at every 30s. A 'running' row
-- whose heartbeat is minutes old has no worker, and is reaped right away.
-- Rows written before this column existed keep heartbeat_at NULL and fall
-- back to the old 5h rule.
ALTER TABLE public.data_reload_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;
