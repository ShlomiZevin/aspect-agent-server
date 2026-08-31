-- 045_one_running_module_run.sql
--
-- Only one init may be running for a (dataset, module) at a time.
--
-- The guard in module-init.service is check-then-insert: two requests, or two
-- Cloud Run instances, can both pass hasRunningRun() and start pipelines that
-- share the SAME scratch-schema name. The second one's DROP SCHEMA ... CASCADE
-- then destroys the first one's build mid-verify.
--
-- Low probability on a super-admin-only surface, but this platform has already
-- lost a build to a multi-instance race once (the self-heal chop), and the
-- database is the only place the two instances can agree.
--
-- Partial, so finished runs are unconstrained -- the history is meant to
-- accumulate.

CREATE UNIQUE INDEX IF NOT EXISTS module_runs_one_running_idx
  ON module_runs (dataset_id, module_id) WHERE status = 'running';
